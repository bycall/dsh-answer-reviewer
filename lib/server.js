/**
 * Local HTTP config server for dsh-answer-reviewer.
 *
 * What this is:
 *   * A tiny `node:http` instance bound to 127.0.0.1 only (no external
 *     access). It is the "graphical" surface for the config store, plus
 *     a JSON API that scripts and curl can drive.
 *   * The HTML page is self-contained: zero external assets, zero CDN
 *     requests. The form posts JSON to /api/config; the same endpoint
 *     is usable from `curl -X POST` for automation.
 *
 * What this is NOT:
 *   * Not a replacement for the host's web UI. The host does not expose
 *     a third-party plugin settings panel, so this fills that gap as a
 *     sidecar. When the host does add a settings API, swap `startServer`
 *     for that integration; the ConfigStore layer above this is the
 *     source of truth and does not change.
 *   * Not authenticated. Localhost-only binding + same-user-only access
 *     is the trust boundary. If you forward the port or expose it, add
 *     a real auth layer; do not "fix" this server.
 *
 * Routes:
 *   GET    /              HTML form (config editor + recent activity)
 *   GET    /api/health    { ok: true, at }
 *   GET    /api/config    { config, overrides, source, path }
 *   POST   /api/config    body: partial JSON; returns { config } or { error }
 *   DELETE /api/config    wipe overrides back to defaults; returns { config }
 *   GET    /api/recent    { entries: [...] } (in-memory ring, newest first)
 *
 * @module dsh-answer-reviewer/server
 */

import http from 'node:http'
import { DEFAULT_HTTP_PORT, HTTP_PORT_ENV, HTTP_ENABLED_ENV } from './config-store.js'

const MAX_BODY_BYTES = 16 * 1024

/**
 * Start the local config server. Returns a `close()` function the caller
 * (the plugin's `apply`) is expected to call on `ctx.on('dispose')`.
 *
 * @param store - the active ConfigStore.
 * @param options - `{ host, port, logger }`.
 */
export async function startServer(store, options = {}) {
  const host = options.host || '127.0.0.1'
  const port = Number.parseInt(options.port ?? process.env[HTTP_PORT_ENV] ?? DEFAULT_HTTP_PORT, 10)
  const logger = options.logger || null
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`startServer: invalid port ${port}`)
  }
  if (process.env[HTTP_ENABLED_ENV] === '0') {
    if (logger && typeof logger.info === 'function') {
      logger.info('dsh-answer-reviewer: config server disabled via REVIEWER_HTTP=0')
    }
    return () => {}
  }

  const server = http.createServer((req, res) => handle(req, res, store, logger))
  server.on('error', (error) => {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`dsh-answer-reviewer: config server error: ${String(error)}`)
    }
  })

  // Re-attach the active store's recent entries (closure) on every request;
  // nothing else to do on subscribe.
  const boundPort = await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const addr = server.address()
      const actual = (addr && typeof addr === 'object') ? addr.port : port
      if (logger && typeof logger.info === 'function') {
        logger.info(`dsh-answer-reviewer: config server listening on http://${host}:${actual}`)
      }
      resolve(actual)
    })
  })

  return Object.freeze({
    port: boundPort,
    close() { server.close(() => {}) },
  })
}

async function handle(req, res, store, logger) {
  if (!req.url) {
    send(res, 400, 'text/plain', 'bad request')
    return
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = renderHtml(store)
    send(res, 200, 'text/html; charset=utf-8', html)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, at: new Date().toISOString() })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      config: store.get(),
      overrides: store.getOverrides(),
      source: store.getSource(),
      path: store.getPath(),
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/recent') {
    sendJson(res, 200, { entries: store.getRecent().slice(-20).reverse() })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readJsonBody(req)
    if (body === null) {
      sendJson(res, 400, { error: 'body must be valid JSON object under 16KB' })
      return
    }
    const result = await store.update(body)
    if (result.error) {
      sendJson(res, 400, { error: result.error })
      return
    }
    sendJson(res, 200, { config: result.config, overrides: store.getOverrides() })
    return
  }
  if (req.method === 'DELETE' && url.pathname === '/api/config') {
    const result = await store.reset()
    sendJson(res, 200, { config: result.config, overrides: {} })
    return
  }
  send(res, 404, 'text/plain', 'not found')
}

function send(res, status, contentType, body) {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve(null); return }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          resolve(null)
          return
        }
        resolve(parsed)
      } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Format an ISO-8601 activity timestamp as local wall-clock HH:MM:SS.
 * Activity timestamps are stored in UTC (toISOString); slicing the raw ISO
 * string used to render UTC time, which reads 8 hours behind for users east
 * of Greenwich (e.g. GMT+8). Converting through `Date` renders the host's
 * local timezone instead.
 * @param iso - ISO-8601 string (UTC), e.g. an activity's `at`.
 * @returns local `HH:MM:SS`, or the original string when unparseable.
 */
export function fmtLocalTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function renderHtml(store) {
  const c = store.get()
  const source = store.getSource()
  const path = store.getPath()
  const port = Number.parseInt(process.env[HTTP_PORT_ENV] ?? DEFAULT_HTTP_PORT, 10)
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-answer-reviewer · 实时配置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 13px/1.55 -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 24px 64px; max-width: 760px; margin-inline: auto; color: var(--fg, #1d1d1f); background: var(--bg, #fafaf7); }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 500; margin: 28px 0 10px; }
  .sub { color: #6b6b70; font-size: 12px; margin: 0 0 24px; }
  .meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #6b6b70; margin: 0 0 24px; padding: 10px 14px; background: rgba(0,0,0,.04); border-radius: 8px; }
  .meta code { color: #1d1d1f; }
  form { display: grid; grid-template-columns: 200px 1fr; gap: 14px 18px; align-items: start; padding: 18px 20px; background: #fff; border: 0.5px solid rgba(0,0,0,.12); border-radius: 12px; }
  label { font-weight: 500; }
  .hint { display: block; font-weight: 400; font-size: 12px; color: #6b6b70; margin-top: 2px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  input[type=text], input[type=number], select { font: inherit; padding: 6px 8px; border: 0.5px solid rgba(0,0,0,.2); border-radius: 6px; background: #fff; color: inherit; }
  input[type=range] { width: 100%; }
  input[type=checkbox] { transform: scale(1.15); margin: 4px 0; }
  .actions { grid-column: 1 / -1; display: flex; gap: 8px; margin-top: 4px; }
  button { font: inherit; padding: 6px 14px; border: 0.5px solid rgba(0,0,0,.2); border-radius: 6px; background: #fff; color: inherit; cursor: pointer; }
  button.primary { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
  button:hover { background: rgba(0,0,0,.05); }
  button.primary:hover { background: #38383d; }
  .status { grid-column: 1 / -1; font-size: 12px; color: #6b6b70; min-height: 1.5em; }
  .status.ok { color: #1d6b3a; }
  .status.err { color: #b3261e; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 0.5px solid rgba(0,0,0,.08); }
  th { color: #6b6b70; font-weight: 500; }
  td.score-pass { color: #1d6b3a; font-weight: 500; }
  td.score-steer { color: #b3261e; font-weight: 500; }
  td.score-other { color: #6b6b70; }
  .empty { color: #6b6b70; font-size: 12px; }
  #recent.fresh { animation: recent-pop .6s ease; }
  @keyframes recent-pop { from { opacity: .3; } to { opacity: 1; } }
  @media (prefers-color-scheme: dark) {
    body { --bg: #18181b; --fg: #ececec; }
    form, .meta { background: #1f1f23; border-color: rgba(255,255,255,.1); }
    input[type=text], input[type=number], select, button { background: #1f1f23; color: #ececec; border-color: rgba(255,255,255,.2); }
    button.primary { background: #ececec; color: #18181b; border-color: #ececec; }
    .meta { background: #1f1f23; }
  }
</style>
</head>
<body>
  <h1>dsh-answer-reviewer · 实时配置</h1>
  <p class="sub">改完即生效，无需重启宿主。仅监听 127.0.0.1:${port}，无外部访问。</p>
  <div class="meta">
    <span>来源：<code>${escapeHtml(source)}</code></span>
    <span>路径：<code>${escapeHtml(path)}</code></span>
    <span>阈值：<code>${c.threshold}</code></span>
    <span>上限：<code>${c.maxChallenges}</code></span>
  </div>

  <form id="cfg">
    <label for="enabled">启用审查</label>
    <div class="field">
      <input type="checkbox" id="enabled" name="enabled" ${c.enabled ? 'checked' : ''}>
      <span class="hint">关闭后所有 turn 直接放行</span>
    </div>

    <label for="threshold">分数阈值 (<output id="thresholdVal">${c.threshold}</output>)</label>
    <div class="field">
      <input type="range" id="threshold" name="threshold" min="1" max="100" value="${c.threshold}" oninput="thresholdVal.value=value">
      <span class="hint">≥ 此分数的回复直接放行；&lt; 此分数触发 steer</span>
    </div>

    <label for="maxChallenges">单 turn 重试上限</label>
    <div class="field">
      <select id="maxChallenges" name="maxChallenges">
        ${[1,2,3,4,5,6,7,8].map(n => `<option value="${n}" ${c.maxChallenges === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <span class="hint">漏防上限，非质量 gate（gate 是 threshold）</span>
    </div>

    <label for="maxReviewTokens">审查模型输出上限</label>
    <div class="field">
      <input type="number" id="maxReviewTokens" name="maxReviewTokens" min="64" max="4096" step="64" value="${c.maxReviewTokens}">
      <span class="hint">审查 LLM 的 maxTokens</span>
    </div>

    <label for="timeoutMs">审查超时（毫秒）</label>
    <div class="field">
      <select id="timeoutMs" name="timeoutMs">
        ${[30000, 60000, 120000, 300000, 600000].map(n => `<option value="${n}" ${c.timeoutMs === n ? 'selected' : ''}>${(n/1000)|0}s</option>`).join('')}
      </select>
      <span class="hint">审查 LLM 的 wall-clock 上限</span>
    </div>

    <label for="reviewProvider">独立审查 Provider</label>
    <div class="field">
      <input type="text" id="reviewProvider" name="reviewProvider" value="${escapeHtml(c.reviewProvider ?? '')}" placeholder="(留空 = agent 当前 provider)">
      <span class="hint">需与 model 配对设置</span>
    </div>

    <label for="reviewModel">独立审查 Model</label>
    <div class="field">
      <input type="text" id="reviewModel" name="reviewModel" value="${escapeHtml(c.reviewModel ?? '')}" placeholder="(留空 = agent 当前 model)">
      <span class="hint">provider 与 model 必须同时设</span>
    </div>

    <div class="actions">
      <button type="submit" class="primary">保存</button>
      <button type="button" id="reload">重新加载</button>
      <button type="button" id="reset">重置默认值</button>
    </div>
    <div class="status" id="status"></div>
  </form>

  <h2>最近 15 条审查活动</h2>
  <div id="recent"><p class="empty">载入中…</p></div>

<script>
const status = document.getElementById('status');
function setStatus(text, kind) { status.textContent = text; status.className = 'status ' + (kind || ''); }

// --- Recent-activity auto-refresh ---
// The activity ring lives in the host process and grows while a turn is
// being reviewed. Instead of requiring a manual "重新加载" (or a full page
// reload that would discard unsaved config edits), poll the JSON API and
// swap ONLY the table underneath the form.
const RECENT_POLL_MS = 3000;
let recentKey = '';

const pad2 = (n) => String(n).padStart(2, '0');
function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function shortId(sessionId) {
  // "session-b6d12535-2979-..." reads better as "b6d12535": strip the
  // known prefix, then show the first 8 chars of the uuid tail so rows
  // are distinguishable instead of all reading "session-".
  const s = String(sessionId || '?');
  const tail = s.startsWith('session-') ? s.slice('session-'.length) : s;
  return tail.slice(0, 8) || '?';
}
function renderRecent(entries) {
  const box = document.getElementById('recent');
  if (!entries.length) {
    box.innerHTML = '<p class="empty">尚无记录。在对话里发条消息、触发一次审查即可。</p>';
    return;
  }
  const rows = entries.map((r) => {
    const cls = r.decision === 'pass' ? 'pass' : r.decision === 'steer' ? 'steer' : 'other';
    const score = r.score != null ? r.score : '—';
    return '<tr>' +
      '<td>' + esc(fmtLocal(r.at)) + '</td>' +
      '<td>' + esc(shortId(r.sessionId)) + '/' + (r.turn != null ? r.turn : '?') + '</td>' +
      '<td class="score-' + cls + '">' + esc(score) + '</td>' +
      '<td>' + esc(r.decision || '') + '</td>' +
      '<td>' + esc((r.reason || '').slice(0, 80)) + '</td>' +
    '</tr>';
  }).join('');
  box.innerHTML = '<table>' +
    '<thead><tr><th>时间</th><th>会话/turn</th><th>分数</th><th>动作</th><th>原因</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
  // Visual ping so a freshly landed row is noticeable.
  box.classList.remove('fresh');
  void box.offsetWidth; // restart the CSS animation
  box.classList.add('fresh');
}
async function refreshRecent() {
  let data;
  try {
    const res = await fetch('/api/recent');
    if (!res.ok) return;
    data = await res.json();
  } catch (_) {
    return; // host momentarily down (restart): keep the last view
  }
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  const key = entries.length ? entries[0].at + '|' + entries.length : 'empty';
  if (key === recentKey) return;
  recentKey = key;
  renderRecent(entries);
}
refreshRecent();
setInterval(refreshRecent, RECENT_POLL_MS);
// The better-sidebar tab unmounts its iframe while hidden; when it becomes
// visible again (or the window regains focus) fetch immediately so a review
// that happened in the meantime shows up without waiting a poll tick.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRecent(); });
window.addEventListener('focus', refreshRecent);

document.getElementById('cfg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  body.enabled = document.getElementById('enabled').checked;
  body.threshold = Number(document.getElementById('threshold').value);
  body.maxChallenges = Number(document.getElementById('maxChallenges').value);
  body.maxReviewTokens = Number(document.getElementById('maxReviewTokens').value);
  body.timeoutMs = Number(document.getElementById('timeoutMs').value);
  const prov = document.getElementById('reviewProvider').value.trim();
  const mod  = document.getElementById('reviewModel').value.trim();
  body.reviewProvider = prov || undefined;
  body.reviewModel    = mod  || undefined;
  if ((prov === '') !== (mod === '')) {
    setStatus('保存失败：reviewProvider 与 reviewModel 必须同时设或同时留空', 'err');
    return;
  }
  setStatus('保存中…');
  try {
    const res = await fetch('/api/config', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) { setStatus('保存失败：' + (json.error || res.status), 'err'); return; }
    setStatus('已保存 · 立即生效', 'ok');
    setTimeout(() => location.reload(), 600);
  } catch (err) { setStatus('保存失败：' + String(err), 'err'); }
});

document.getElementById('reload').addEventListener('click', () => location.reload());
document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('确认重置为默认值？将清空配置文件并重载。')) return;
  setStatus('重置中…');
  try {
    const res = await fetch('/api/config', { method: 'DELETE' });
    const json = await res.json();
    if (res.ok) { setStatus('已重置默认值', 'ok'); setTimeout(() => location.reload(), 600); }
    else { setStatus('重置失败：' + (json.error || res.status) + ' · 可手动删除 ' + ${JSON.stringify(path)}, 'err'); }
  } catch (err) { setStatus('重置失败：' + String(err), 'err'); }
});
</script>
</body>
</html>`
}
