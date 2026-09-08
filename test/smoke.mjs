#!/usr/bin/env node
/**
 * Smoke test for dsh-answer-reviewer.
 *
 * Runs without a live dsh host. Self-bootstraps node_modules symlinks for
 * the plugin's peer dependencies (resolved against the active dsh install)
 * so the ESM `import '@deepseek-ai/...'` statements work, then dynamically
 * imports the plugin and exercises every pure helper plus the fail-open,
 * skip-subagent, and below-threshold branches of onTurnStopping with mock
 * objects.
 *
 * Exit code 0 = all green.
 */

import { existsSync, mkdirSync, lstatSync, readlinkSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

/**
 * Resolve a peer package against the dsh host install, falling back to
 * `~/.dsh/profiles/web/node_modules`. Mirrors the resolution chain a
 * registered plugin would see at runtime.
 */
function resolveHostPath(pkg) {
  const dshGlobal = '/Users/bycall/.workbuddy/binaries/node/versions/22.22.2-2/lib/node_modules/@deepseek-ai/dsh/node_modules'
  const profile = `${process.env.HOME}/.dsh/profiles/web/node_modules`
  const fullName = pkg.startsWith('@') ? pkg : `@deepseek-ai/${pkg}`
  for (const base of [dshGlobal, profile]) {
    try {
      const real = require.resolve(`${fullName}/package.json`, { paths: [base] })
      return dirname(real)
    } catch { /* try next */ }
  }
  return null
}

/**
 * Make sure `node_modules/@deepseek-ai/<pkg>` is a symlink pointing at the
 * host install. Idempotent. Never touches the real host install.
 */
function ensurePeerLink(pkg) {
  const real = resolveHostPath(pkg)
  if (!real) throw new Error(`smoke: cannot locate ${pkg} in any known host install`)
  const fullName = pkg.startsWith('@') ? pkg : `@deepseek-ai/${pkg}`
  const shortName = fullName.split('/')[1]
  const nm = resolve(pkgRoot, 'node_modules/@deepseek-ai')
  const link = resolve(nm, shortName)
  mkdirSync(nm, { recursive: true })
  let existing
  try { existing = lstatSync(link) } catch { existing = null }
  if (existing) {
    if (existing.isSymbolicLink()) {
      const target = readlinkSync(link)
      if (target === real) return
    }
    return
  }
  symlinkSync(real, link)
}

ensurePeerLink('cordis')
ensurePeerLink('dsh-llm')
ensurePeerLink('dsh-session')
ensurePeerLink('schemastery')

const plugin = await import(pathToFileURL(resolve(pkgRoot, 'lib/index.js')).href)
const {
  Config,
  buildReviewPrompt,
  buildSteerMessage,
  createChallengeCounter,
  createConfigStore,
  defaultConfigPath,
  DEFAULT_HTTP_PORT,
  extractAssistantText,
  extractUserPrompts,
  isScoreAcceptable,
  name,
  onTurnStopping,
  parseScore,
  resolveConfig,
  startServer,
} = plugin

const tests = []
const test = (label, fn) => tests.push({ label, fn })
const ok = (cond, message) => { if (!cond) throw new Error(`assertion failed: ${message}`) }

/** Build a fresh ConfigStore backed by a tmp file the test can write into
 *  without leaking into the user's real config. Caller is expected to
 *  delete the tmp dir if needed; the OS reaps `/tmp` on reboot anyway. */
async function makeTestStore(overrides = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'dsh-reviewer-'))
  const filePath = resolve(dir, 'config.json')
  const defaults = resolveConfig(overrides)
  const store = await createConfigStore({ defaults, filePath, logger: { info() {}, warn() {} } })
  await store.load()
  return { store, dir, filePath, defaults, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('name exports the right plugin id', () => {
  ok(name === 'dsh-answer-reviewer', `name=${name}`)
})

test('resolveConfig applies defaults', () => {
  const c = resolveConfig(undefined)
  ok(c.enabled === true, 'enabled defaults to true')
  ok(c.maxChallenges === 5, `maxChallenges defaults to 5, got ${c.maxChallenges}`)
  ok(c.maxReviewTokens === 512, 'maxReviewTokens defaults to 512')
  ok(c.timeoutMs === 60_000, 'timeoutMs defaults to 60_000')
  ok(c.threshold === 80, `threshold defaults to 80, got ${c.threshold}`)
  ok(c.reviewProvider === undefined, 'reviewProvider defaults undefined')
  ok(c.reviewModel === undefined, 'reviewModel defaults undefined')
})

test('resolveConfig validates reviewProvider/reviewModel pair', () => {
  let threw = false
  try { resolveConfig({ reviewProvider: 'openai' }) } catch { threw = true }
  ok(threw, 'reviewProvider alone should throw')
  let threw2 = false
  try { resolveConfig({ reviewModel: 'x' }) } catch { threw2 = true }
  ok(threw2, 'reviewModel alone should throw')
})

test('resolveConfig clamps out-of-range integers and threshold', () => {
  const c = resolveConfig({ maxChallenges: 999, maxReviewTokens: 0, timeoutMs: -1, threshold: 150 })
  ok(c.maxChallenges === 8, `clamped to cap, got ${c.maxChallenges}`)
  ok(c.maxReviewTokens === 512, `falls back to default, got ${c.maxReviewTokens}`)
  ok(c.timeoutMs === 60_000, `falls back to default, got ${c.timeoutMs}`)
  // threshold out-of-range is "invalid configuration" — we refuse it silently
  // by falling back to DEFAULT (80), not by silently clamping to a different
  // gate value the user did not ask for.
  ok(c.threshold === 80, `out-of-range threshold falls back to default, got ${c.threshold}`)
  const c2 = resolveConfig({ threshold: -5 })
  ok(c2.threshold === 80, `threshold below 1 falls back to default, got ${c2.threshold}`)
  const c3 = resolveConfig({ threshold: 73 })
  ok(c3.threshold === 73, `threshold within range is preserved, got ${c3.threshold}`)
})

test('extractAssistantText concatenates text blocks for the turn', () => {
  const events = [
    { type: 'user/message', data: { turn: 1 }, seq: 0 },
    {
      type: 'assistant/message',
      data: {
        turn: 1, step: 0,
        message: { content: [{ type: 'text', text: 'hello ' }, { type: 'code', text: 'ignored' }] },
      },
      seq: 1,
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'world' }] },
      },
      seq: 2,
    },
    {
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: 'other turn' }] } },
      seq: 3,
    },
  ]
  const out = extractAssistantText(events, 1)
  ok(out === 'hello \n\nworld', `got ${JSON.stringify(out)}`)
})

test('extractAssistantText skips interrupted messages', () => {
  const events = [
    {
      type: 'assistant/message',
      interrupted: true,
      data: { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'x' }] } },
      seq: 0,
    },
  ]
  ok(extractAssistantText(events, 1) === null, 'interrupted should yield null')
})

test('extractUserPrompts concatenates user-source messages, drops plugin injections', () => {
  const events = [
    {
      type: 'user/message',
      data: {
        message: { content: [{ type: 'text', text: 'first user question' }] },
        source: { kind: 'user' },
      },
      seq: 0,
    },
    {
      type: 'user/message',
      data: {
        message: { content: [{ type: 'text', text: 'AGENTS.md context' }] },
        source: { kind: 'plugin', plugin: 'dsh-context' },
      },
      seq: 1,
    },
    {
      type: 'user/message',
      data: {
        message: { content: [{ type: 'text', text: 'second user question' }] },
        source: { kind: 'user' },
      },
      seq: 2,
    },
  ]
  const out = extractUserPrompts(events)
  ok(out && out.includes('first user question'), 'first user prompt included')
  ok(out && !out.includes('AGENTS.md'), 'plugin-injected context filtered out')
  ok(out && out.includes('second user question'), 'second user prompt included')
  ok(out && out.includes('---'), 'separator between prompts')
})

test('extractUserPrompts returns null when no real user prompts exist', () => {
  const events = [
    {
      type: 'user/message',
      data: { message: { content: [{ type: 'text', text: 'noise' }] }, source: { kind: 'plugin' } },
      seq: 0,
    },
  ]
  ok(extractUserPrompts(events) === null, 'null when only plugin injections exist')
})

test('parseScore accepts clean JSON', () => {
  const s = parseScore('{"score": 85, "reason": "well done"}')
  ok(s && s.score === 85, `score=${s && s.score}`)
  ok(s && s.reason === 'well done', `reason=${s && s.reason}`)
})

test('parseScore strips surrounding markdown', () => {
  const s = parseScore('Here you go:\n```json\n{"score": 45, "reason": "truncated"}\n```')
  ok(s && s.score === 45, `score=${s && s.score}`)
  ok(s && s.reason === 'truncated', `reason=${s && s.reason}`)
})

test('parseScore fails closed on out-of-band scores (no silent clamp)', () => {
  // Out-of-band scores are rejected, not silently clamped. Letting a model
  // "buy" a pass by returning -1 or 9999 would defeat the gate.
  ok(parseScore('{"score": -10, "reason": "x"}') === null, 'negative rejects')
  ok(parseScore('{"score": 200, "reason": "x"}') === null, 'over-100 rejects')
  ok(parseScore('{"score": 0, "reason": "x"}') === null, 'zero rejects (min is 1)')
  ok(parseScore('{"score": "abc", "reason": "x"}') === null, 'non-numeric rejects')
  ok(parseScore('{"score": null, "reason": "x"}') === null, 'null rejects')
})

test('parseScore fails closed on garbage', () => {
  ok(parseScore('not json') === null, 'garbage rejected')
  ok(parseScore('') === null, 'empty rejected')
  ok(parseScore('{}') === null, 'no score rejected')
  ok(parseScore('{"score": 50}') === null, 'missing reason rejected')
})

test('parseScore handles reason longer than 240 chars', () => {
  const long = 'x'.repeat(300)
  const s = parseScore(JSON.stringify({ score: 60, reason: long }))
  ok(s && s.reason.length <= 240, `len=${s && s.reason.length}`)
})

test('isScoreAcceptable honours threshold', () => {
  ok(isScoreAcceptable({ score: 80 }, 80) === true, 'equal is acceptable')
  ok(isScoreAcceptable({ score: 81 }, 80) === true, 'above is acceptable')
  ok(isScoreAcceptable({ score: 79 }, 80) === false, 'below is not acceptable')
  ok(isScoreAcceptable(null, 80) === false, 'null rejected')
})

test('buildSteerMessage renders score, reason, and the retry position', () => {
  const m = buildSteerMessage({ score: 42, reason: 'mentions rm -rf', attempt: 1, maxAttempts: 5 })
  ok(m.role === 'user', 'role user')
  ok(m.source && m.source.kind === 'plugin', 'source plugin')
  ok(m.source.plugin === 'dsh-answer-reviewer', 'plugin id')
  const text = m.content[0].text
  ok(text.includes('42/100'), 'score rendered')
  ok(text.includes('mentions rm -rf'), 'reason listed')
  ok(text.includes('retry 1 of 5'), 'retry position')
  ok(text.includes('4 remaining'), 'remaining count')
})

test('buildSteerMessage flags the last retry with no remaining', () => {
  const m = buildSteerMessage({ score: 20, reason: 'truncated', attempt: 5, maxAttempts: 5 })
  ok(m.content[0].text.includes('last retry'), 'last retry hint')
})

test('buildSteerMessage tolerates missing reason', () => {
  const m = buildSteerMessage({ score: 30, reason: '', attempt: 2, maxAttempts: 5 })
  ok(m.content[0].text.includes('no specific defect was named'), 'fallback for empty reason')
})

test('buildReviewPrompt carries both user prompts and assistant reply', () => {
  const p = buildReviewPrompt({
    userPrompts: 'is the macOS ssh helper buggy',
    assistantText: 'no, it works fine',
    threshold: 80,
  })
  ok(p.system.includes('1-100'), 'system prompt mentions the 1-100 scale')
  ok(p.system.includes('80'), 'system prompt echoes the threshold')
  ok(p.system.includes('JSON'), 'system prompt demands JSON output')
  ok(p.messages.length === 1, 'one user message')
  const block = p.messages[0].content[0]
  ok(block.text.includes('<all_user_prompts>'), 'user prompts section')
  ok(block.text.includes('<reply>'), 'reply section')
  ok(block.text.includes('is the macOS ssh helper buggy'), 'user prompt carried')
  ok(block.text.includes('no, it works fine'), 'reply carried')
  ok(p.messages[0].source.plugin === 'dsh-answer-reviewer', 'source plugin id')
})

test('buildReviewPrompt falls back when userPrompts is empty', () => {
  const p = buildReviewPrompt({ userPrompts: '', assistantText: 'hi', threshold: 80 })
  ok(p.messages[0].content[0].text.includes('none extracted'), 'placeholder for missing prompts')
})

test('onTurnStopping skips subagent sessions', async () => {
  let steerCalled = false
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: { stream: () => { throw new Error('should not be called for subagent') } },
  }
  const agent = {
    session: { id: 's', header: { origin: 'subagent' }, snapshotEvents: () => [] },
    options: { provider: 'p', model: 'm' },
    steer() { steerCalled = true },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(!steerCalled, 'subagent was skipped')
})

test('onTurnStopping skips turns with no assistant text', async () => {
  let steerCalled = false
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: { stream: () => { throw new Error('should not be called when no text') } },
  }
  const agent = {
    session: { id: 's', snapshotEvents: () => [] },
    options: { provider: 'p', model: 'm' },
    steer() { steerCalled = true },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(!steerCalled, 'no text => no review => no steer')
})

test('onTurnStopping fail-open when review call throws', async () => {
  let steerCalled = false
  let warned = ''
  const ctx = {
    logger: { info() {}, warn(m) { warned += String(m) + '|' } },
    llm: { async *stream() { throw new Error('network down') } },
  }
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } }, seq: 0 },
  ]
  const agent = {
    session: { id: 's', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer() { steerCalled = true },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(!steerCalled, 'no steer on review failure')
  ok(warned.includes('review call failed'), `expected fail-open warn, got: ${warned}`)
})

test('onTurnStopping fail-open on parse failure', async () => {
  let steerCalled = false
  const ctx = {
    logger: { info() {}, warn() {} },
    // Empty stream → BlockAssembler blocks() is empty → streamToText returns '' → parseScore('') is null → fail-open.
    llm: { async *stream() { /* yields nothing */ } },
  }
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } }, seq: 0 },
  ]
  const agent = {
    session: { id: 's', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer() { steerCalled = true },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(!steerCalled, 'no steer on parse failure')
})

test('onTurnStopping steers when score is below threshold', async () => {
  const steers = []
  let infoLog = ''
  const reply = '{"score": 42, "reason": "reply is empty"}'
  const ctx = {
    logger: { info(m) { infoLog += String(m) + '|' }, warn() {} },
    // BlockAssembler consumes the canonical delta protocol:
    // block-start(index) → text-delta(index, text) → block-end(index, block).
    llm: { async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'do thing' }] } }, seq: 0 },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'k' }] } }, seq: 1 },
  ]
  const agent = {
    session: { id: 's1', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer(m) { steers.push(m) },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(steers.length === 1, `steer called once, got ${steers.length}`)
  ok(steers[0].content[0].text.includes('42/100'), 'steer text contains the score')
  ok(steers[0].content[0].text.includes('reply is empty'), 'steer text contains the reason')
  ok(steers[0].content[0].text.includes('retry 1 of 5'), 'steer text names the retry position')
  ok(infoLog.includes('score=42/80'), 'info log notes score vs threshold')
})

test('onTurnStopping does not steer when score meets threshold', async () => {
  const steers = []
  const reply = '{"score": 92, "reason": ""}'
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: { async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'solid reply' }] } }, seq: 0 },
  ]
  const agent = {
    session: { id: 's2', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer(m) { steers.push(m) },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, createChallengeCounter(), { agent, turn: 1 })
  } finally { cleanup() }
  ok(steers.length === 0, 'no steer when score >= threshold')
})

test('onTurnStopping stops steering after maxChallenges', async () => {
  const steers = []
  const counter = createChallengeCounter()
  counter.bump('s3', 1)
  counter.bump('s3', 1)
  counter.bump('s3', 1)
  counter.bump('s3', 1)
  counter.bump('s3', 1) // 5 already used; default cap is 5
  const reply = '{"score": 10, "reason": "x"}'
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: { async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } },
  }
  const events = [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'bad reply' }] } }, seq: 0 },
  ]
  const agent = {
    session: { id: 's3', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer(m) { steers.push(m) },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, counter, { agent, turn: 1 })
  } finally { cleanup() }
  ok(steers.length === 0, 'cap exhausted => no further steer')
})

test('Config schema covers the same defaults as resolveConfig', () => {
  ok(typeof Config === 'function', 'Config is exported')
  const parsed = Config({})
  ok(parsed.enabled === true, 'schema default enabled')
  ok(parsed.maxChallenges === 5, `schema default maxChallenges, got ${parsed.maxChallenges}`)
  ok(parsed.threshold === 80, `schema default threshold, got ${parsed.threshold}`)
})

// --- ConfigStore -----------------------------------------------------------

test('ConfigStore loads defaults when no file exists', async () => {
  const { store, filePath, cleanup } = await makeTestStore()
  try {
    ok(store.get().threshold === 80, 'effective config starts at defaults')
    ok(store.getSource() === 'defaults', 'source reports defaults')
    ok(store.getPath() === filePath, 'path returned matches input')
  } finally { cleanup() }
})

test('ConfigStore.update persists and applies the partial', async () => {
  const { store, filePath, cleanup } = await makeTestStore()
  try {
    const result = await store.update({ threshold: 90, enabled: false })
    ok(!result.error, `update returned: ${JSON.stringify(result)}`)
    ok(store.get().threshold === 90, 'effective threshold updated')
    ok(store.get().enabled === false, 'enabled flag updated')
    ok(store.getSource() === 'file', 'source reports file after update')
    // Re-load in a fresh store to confirm disk persistence.
    const reopened = await createConfigStore({ defaults: resolveConfig({}), filePath, logger: { info() {}, warn() {} } })
    await reopened.load()
    ok(reopened.get().threshold === 90, 'on-disk threshold survives reopen')
  } finally { cleanup() }
})

test('ConfigStore.update rejects invalid provider/model pair', async () => {
  const { store, cleanup } = await makeTestStore()
  try {
    const r = await store.update({ reviewProvider: 'openai' })
    ok(r.error && r.error.includes('must be set together'), `error: ${r.error}`)
    // State must not have changed.
    ok(store.get().reviewProvider === undefined, 'reviewProvider still undefined')
  } finally { cleanup() }
})

test('ConfigStore.subscribe fires on every successful update', async () => {
  const { store, cleanup } = await makeTestStore()
  try {
    const seen = []
    store.subscribe((cfg) => seen.push(cfg.threshold))
    await store.update({ threshold: 70 })
    await store.update({ threshold: 75 })
    ok(seen.length === 2 && seen[0] === 70 && seen[1] === 75, `thresholds observed: ${seen.join(',')}`)
  } finally { cleanup() }
})

test('ConfigStore.reset removes the on-disk file', async () => {
  const { store, filePath, cleanup } = await makeTestStore()
  try {
    await store.update({ threshold: 33 })
    ok(existsSync(filePath), 'file exists after update')
    await store.reset()
    ok(!existsSync(filePath), 'file removed after reset')
    ok(store.get().threshold === 80, 'config back to defaults after reset')
    ok(store.getSource() === 'defaults', 'source reports defaults after reset')
  } finally { cleanup() }
})

test('ConfigStore.recordActivity keeps a ring buffer', async () => {
  const { store, cleanup } = await makeTestStore()
  try {
    for (let i = 0; i < 60; i += 1) store.recordActivity({ sessionId: 'x', turn: i, decision: 'pass' })
    const recent = store.getRecent()
    ok(recent.length === 50, `ring capped at 50, got ${recent.length}`)
    // The array grows by `push` and ages by `shift`, so the OLDEST survivor
    // sits at index 0 and the NEWEST at the end.
    ok(recent[0].turn === 10, `oldest is the 11th push (turn=10), got ${recent[0].turn}`)
    ok(recent[recent.length - 1].turn === 59, `newest is the 60th push (turn=59), got ${recent[recent.length - 1].turn}`)
  } finally { cleanup() }
})

test('defaultConfigPath honours REVIEWER_CONFIG_PATH', () => {
  const p = defaultConfigPath({ REVIEWER_CONFIG_PATH: '/tmp/x.json', HOME: '/home/me' })
  ok(p === '/tmp/x.json', `env override honoured, got ${p}`)
})

// --- HTTP server -----------------------------------------------------------

test('startServer binds, serves /api/health, and exposes its port', async () => {
  const { store, cleanup } = await makeTestStore()
  let handle
  try {
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    ok(typeof handle.port === 'number' && handle.port > 0, `bound port=${handle.port}`)
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`)
    ok(res.status === 200, `health status=${res.status}`)
    const json = await res.json()
    ok(json.ok === true, 'health body says ok')
  } finally { handle?.close(); cleanup() }
})

test('startServer exposes /api/config GET and POST', async () => {
  const { store, cleanup } = await makeTestStore()
  let handle
  try {
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    const url = `http://127.0.0.1:${handle.port}/api/config`
    const before = await fetch(url).then((r) => r.json())
    ok(before.config.threshold === 80, 'initial threshold 80')
    const post = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 95, maxChallenges: 3 }),
    })
    ok(post.status === 200, `post status=${post.status}`)
    const after = await fetch(url).then((r) => r.json())
    ok(after.config.threshold === 95, 'threshold updated to 95')
    ok(after.config.maxChallenges === 3, 'maxChallenges updated to 3')
  } finally { handle?.close(); cleanup() }
})

test('startServer POST rejects bad JSON bodies', async () => {
  const { store, cleanup } = await makeTestStore()
  let handle
  try {
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    const url = `http://127.0.0.1:${handle.port}/api/config`
    const bad = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    ok(bad.status === 400, `bad body status=${bad.status}`)
  } finally { handle?.close(); cleanup() }
})

test('startServer POST rejects mismatched provider/model', async () => {
  const { store, cleanup } = await makeTestStore()
  let handle
  try {
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    const url = `http://127.0.0.1:${handle.port}/api/config`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewProvider: 'openai' }),
    })
    ok(res.status === 400, `mismatched provider status=${res.status}`)
    const body = await res.json()
    ok(body.error && body.error.includes('must be set together'), `error: ${body.error}`)
  } finally { handle?.close(); cleanup() }
})

test('startServer DELETE wipes overrides back to defaults', async () => {
  const { store, filePath, cleanup } = await makeTestStore()
  let handle
  try {
    await store.update({ threshold: 77 })
    ok(existsSync(filePath), 'file present after update')
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    const url = `http://127.0.0.1:${handle.port}/api/config`
    const res = await fetch(url, { method: 'DELETE' })
    ok(res.status === 200, `delete status=${res.status}`)
    ok(!existsSync(filePath), 'file removed after DELETE')
    const after = await fetch(url).then((r) => r.json())
    ok(after.config.threshold === 80, 'threshold back to default')
    ok(after.source === 'defaults', 'source reports defaults after DELETE')
  } finally { handle?.close(); cleanup() }
})

let failures = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log(`  ok  ${t.label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${t.label}\n        ${error.message}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${tests.length} tests failed`)
  process.exit(1)
}
console.log(`\n${tests.length}/${tests.length} tests passed`)
