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

import { existsSync, mkdirSync, lstatSync, readlinkSync, symlinkSync, mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

const NODE_VERSIONS = '/Users/bycall/.workbuddy/binaries/node/versions'
const PROFILE_NM = `${process.env.HOME}/.dsh/profiles/web/node_modules`

/**
 * Every plausible `node_modules` directory that can satisfy an
 * `@deepseek-ai/*` peer import at plugin runtime, most-preferred first.
 *
 * The managed Node runtime directory is versioned and gets REPLACED on
 * WorkBuddy upgrades — `22.22.2-2` was deleted and `22.22.2-3` created on
 * 2026-09-11, moving the global dsh install with it. Hardcoding one version
 * therefore breaks this harness for no reason (and did). Discover instead.
 */
function hostModuleRoots() {
  const roots = []
  const seen = new Set()
  const push = (p) => {
    if (p && !seen.has(p)) { seen.add(p); roots.push(p) }
  }
  // 1) The active managed-runtime global install: `versions/current` names
  //    it, and the plain sweep covers a stale/missing marker.
  try {
    const current = readFileSync(resolve(NODE_VERSIONS, 'current'), 'utf8').trim()
    if (current) push(resolve(NODE_VERSIONS, current, 'lib/node_modules/@deepseek-ai/dsh/node_modules'))
  } catch { /* no `current` marker */ }
  try {
    for (const v of readdirSync(NODE_VERSIONS)) {
      push(resolve(NODE_VERSIONS, v, 'lib/node_modules/@deepseek-ai/dsh/node_modules'))
    }
  } catch { /* runtime dir missing */ }
  // 2) Derive it from the profile's `dsh-tools` link, which points INTO the
  //    global install's nested node_modules. Survives any version rename.
  try {
    const target = realpathSync(resolve(PROFILE_NM, '@deepseek-ai/dsh-tools'))
    push(dirname(dirname(target)))
  } catch { /* profile not linked yet */ }
  // 3) The profile's own node_modules, then the plugin's local links.
  push(PROFILE_NM)
  push(resolve(pkgRoot, 'node_modules'))
  return roots
}

/**
 * Resolve a peer package against the dsh host install, falling back to
 * `~/.dsh/profiles/web/node_modules`. Mirrors the resolution chain a
 * registered plugin would see at runtime.
 */
function resolveHostPath(pkg) {
  const fullName = pkg.startsWith('@') ? pkg : `@deepseek-ai/${pkg}`
  for (const base of hostModuleRoots()) {
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
  createReviewsHandler,
  defaultConfigPath,
  DEFAULT_HTTP_PORT,
  extractAssistantText,
  extractUserPrompts,
  isScoreAcceptable,
  latestAssistantMessageId,
  name,
  onTurnStopping,
  parseScore,
  resolveConfig,
  REVIEWS_ROUTE_PATH,
  reviewsPayload,
  startServer,
  fmtLocalTime,
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

test('parseScore accepts an empty reason on a pass at/above threshold', () => {
  // The review prompt tells the model to leave `reason` empty when the
  // answer clears the gate; rejecting that used to misclassify clean
  // passes as parse failures. Regression for the 0.5.1 fix.
  const pass = parseScore('{"score": 90, "reason": ""}', 80)
  ok(pass !== null, 'empty reason accepted when score >= threshold')
  ok(pass.score === 90 && pass.reason === '', `got ${JSON.stringify(pass)}`)
  const exactly = parseScore('{"score": 80, "reason": ""}', 80)
  ok(exactly !== null, 'score equal to threshold still a pass')
})

test('parseScore still fails closed on an empty reason below threshold', () => {
  // Below the gate the agent needs concrete feedback; an empty reason is
  // indistinguishable from "no feedback", so it must keep failing closed.
  ok(parseScore('{"score": 79, "reason": ""}', 80) === null, 'below threshold rejects')
  ok(parseScore('{"score": 70, "reason": "  "}', 80) === null, 'whitespace-only reason rejects')
})

test('parseScore keeps strict behaviour when no threshold is supplied', () => {
  // Older callers without a threshold cannot classify pass vs fail, so the
  // fail-closed contract for missing reasons is preserved.
  ok(parseScore('{"score": 90, "reason": ""}') === null, 'no threshold => empty reason rejects')
})

test('fmtLocalTime renders stored UTC activity times as local wall-clock', () => {
  const iso = '2026-09-08T12:26:19.331Z'
  const expected = (() => {
    const d = new Date(iso)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  })()
  const got = fmtLocalTime(iso)
  ok(got === expected, `fmtLocalTime('${iso}') = '${got}', expected local '${expected}'`)
  // Regression guard: a naive `iso.slice(11, 19)` returns the UTC "12:26:19"
  // part. On any host east of Greenwich (e.g. GMT+8) that is 8h stale.
  ok(got !== iso.slice(11, 19), 'must not echo the raw UTC slice')
  ok(fmtLocalTime('') === '', 'empty input stays empty')
  ok(fmtLocalTime('not-a-date') === 'not-a-date', 'unparseable input passes through')
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
  // Regression guard (0.5.1): the mock reply has an empty reason because a
  // pass does not need one. It must be recorded as a real `pass`, NOT
  // misclassified as `parse-fail` the way empty-reason replies were before.
  const latest = store.getRecent().slice(-1)[0]
  ok(latest && latest.decision === 'pass', `recorded pass, got ${latest && latest.decision}`)
  ok(latest && latest.score === 92, `recorded score 92, got ${latest && latest.score}`)
})

test('onTurnStopping publishes the score under the answer it graded', async () => {
  const reply = (score, reason) => (async function* () {
    const text = JSON.stringify({ score, reason })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const userEvent = { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'do thing' }] } }, seq: 0 }
  const firstAnswer = { type: 'assistant/message', data: { turn: 1, message: { id: 'answer-1', content: [{ type: 'text', text: 'first try' }] } }, seq: 1 }
  const agentFor = (events) => ({
    session: { id: 's1', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer() {},
  })
  const ctxFor = (score, reason) => ({
    logger: { info() {}, warn() {} },
    llm: { stream: () => reply(score, reason) },
  })

  // Below the gate: the failing score is published against the answer the
  // reviewer read, so the UI can show WHY a retry happened.
  const failing = await makeTestStore()
  try {
    await onTurnStopping(ctxFor(42, 'too thin'), failing.store, createChallengeCounter(), {
      agent: agentFor([userEvent, firstAnswer]), turn: 1,
    })
    const entries = failing.store.getReviews()
    ok(entries.length === 1, `one score recorded, got ${entries.length}`)
    ok(entries[0].messageId === 'answer-1', `bound to the answer, got ${entries[0].messageId}`)
    ok(entries[0].score === 42 && entries[0].decision === 'steer', `record=${JSON.stringify(entries[0])}`)
    ok(entries[0].threshold === 80, `gate recorded, got ${entries[0].threshold}`)
    ok(entries[0].attempt === 1, `attempt recorded, got ${entries[0].attempt}`)
    ok(typeof entries[0].sessionId === 'string', 'session kept for the activity log')
    // The activity ring keeps working alongside the new review ring.
    ok(failing.store.getRecent().length === 1, 'activity entry still recorded')
    // sessionId is diagnostics-only and must not reach the page.
    ok(!('sessionId' in reviewsPayload(failing.store).entries[0]), 'payload strips sessionId')
  } finally { failing.cleanup() }

  // The retry produces a NEW answer id, so the two scores coexist instead of
  // the passing one overwriting the failing one.
  const retryAnswer = { type: 'assistant/message', data: { turn: 1, message: { id: 'answer-2', content: [{ type: 'text', text: 'second try' }] } }, seq: 2 }
  const passing = await makeTestStore()
  try {
    await onTurnStopping(ctxFor(91, 'good'), passing.store, createChallengeCounter(), {
      agent: agentFor([userEvent, firstAnswer, retryAnswer]), turn: 1,
    })
    const entries = passing.store.getReviews()
    ok(entries.length === 1, `one record for the retry, got ${entries.length}`)
    ok(entries[0].messageId === 'answer-2', `retry addressed by its own answer, got ${entries[0].messageId}`)
    ok(entries[0].score === 91 && entries[0].decision === 'pass', `record=${JSON.stringify(entries[0])}`)
  } finally { passing.cleanup() }

  // An answer with no durable id still gets reviewed (the gate must never
  // depend on the display path) but publishes nothing: the UI addresses
  // scores by id, so an unkeyed record could never be shown.
  const anonymous = await makeTestStore()
  try {
    await onTurnStopping(ctxFor(91, 'good'), anonymous.store, createChallengeCounter(), {
      agent: agentFor([userEvent, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'no id' }] } }, seq: 1 }]),
      turn: 1,
    })
    ok(anonymous.store.getReviews().length === 0, 'unaddressable answer publishes no score')
    const latest = anonymous.store.getRecent().slice(-1)[0]
    ok(latest && latest.decision === 'pass', `the gate still ran, got ${latest && latest.decision}`)
  } finally { anonymous.cleanup() }
})

test('onTurnStopping publishes the final score but stops steering after maxChallenges', async () => {
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
    { type: 'assistant/message', data: { turn: 1, message: { id: 'msg-cap-1', content: [{ type: 'text', text: 'bad reply' }] } }, seq: 0 },
  ]
  const agent = {
    session: { id: 's3', snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
    steer(m) { steers.push(m) },
  }
  const { store, cleanup } = await makeTestStore()
  try {
    await onTurnStopping(ctx, store, counter, { agent, turn: 1 })
    ok(steers.length === 0, 'cap exhausted => no further steer')

    // The cap silences steering, NOT the review. The turn's final answer is the
    // only one `conversation.chat.assistant-actions` binds to, so it must still
    // carry a score or the answer the user reads is the one answer with none.
    const reviews = store.getReviews()
    ok(reviews.length === 1, `cap still publishes the final score, got ${reviews.length}`)
    ok(reviews[0].messageId === 'msg-cap-1', `bound to the final message, got ${reviews[0].messageId}`)
    ok(reviews[0].score === 10, `carried the score through, got ${reviews[0].score}`)
    ok(reviews[0].decision === 'capped', `marked as capped, got ${reviews[0].decision}`)
    ok(reviews[0].attempt === 6, `counts the capped answer as the 6th, got ${reviews[0].attempt}`)
    const latest = store.getRecent().slice(-1)[0]
    ok(latest && latest.decision === 'cap-exhausted', `activity ring still explains the cap, got ${latest && latest.decision}`)
  } finally { cleanup() }
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

test('startServer serves the config page with recent-activity auto-refresh', async () => {
  const { store, cleanup } = await makeTestStore()
  let handle
  try {
    handle = await startServer(store, { host: '127.0.0.1', port: 0, logger: { info() {}, warn() {} } })
    const res = await fetch(`http://127.0.0.1:${handle.port}/`)
    ok(res.status === 200, `page status=${res.status}`)
    const html = await res.text()
    ok(html.includes('最近 15 条审查活动'), 'activity table section present')
    // 0.5.2: the activity list must refresh itself by polling /api/recent —
    // the client side has its own row renderer + local-time formatter.
    ok(html.includes('id="recent"'), 'client-rendered recent container present')
    ok(html.includes('refreshRecent'), 'auto-refresh poller present')
    ok(html.includes('/api/recent'), 'poller targets the recent API')
    ok(html.includes('RECENT_POLL_MS'), 'poll interval declared')
    ok(html.includes('fmtLocal('), 'client-side local-time formatting present')
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

// --- per-message scores -----------------------------------------------------
// The conversation UI addresses a finalized answer by the durable id the shell
// itself uses, so the score a turn displays and the score the plugin gated on
// must be recorded under the same key.

test('latestAssistantMessageId reads the id ui-chat addresses the turn by', () => {
  const events = [
    { type: 'user/message', data: { turn: 1, message: { id: 'u1', content: [] } } },
    { type: 'assistant/message', data: { turn: 1, message: { id: 'a1', content: [] } } },
    { type: 'assistant/message', data: { turn: 2, message: { id: 'b1', content: [] } } },
    { type: 'assistant/message', data: { turn: 1, message: { id: 'a2', content: [] } } },
    // Interrupted output is excluded everywhere else, so it must not become
    // the address of the turn either.
    { type: 'assistant/message', data: { turn: 1, interrupted: true, message: { id: 'a3', content: [] } } },
  ]
  ok(latestAssistantMessageId(events, 1) === 'a2', `turn 1 -> ${latestAssistantMessageId(events, 1)}`)
  ok(latestAssistantMessageId(events, 2) === 'b1', `turn 2 -> ${latestAssistantMessageId(events, 2)}`)
  ok(latestAssistantMessageId(events, 9) === null, 'absent turn -> null')
  ok(latestAssistantMessageId(null, 1) === null, 'non-array -> null')
  ok(latestAssistantMessageId(events, '1') === null, 'non-number turn -> null')
  // An id-less message is not addressable: skip it rather than hand back
  // undefined and have the caller record an unretrievable score.
  ok(
    latestAssistantMessageId([{ type: 'assistant/message', data: { turn: 1, message: { content: [] } } }], 1) === null,
    'id-less message -> null'
  )
})

test('ConfigStore.recordReview keys scores by message id and evicts oldest', async () => {
  const { store, cleanup } = await makeTestStore()
  try {
    store.recordReview({ messageId: 'x', score: 10 })
    // Re-recording one message replaces its record; the UI looks up by id.
    store.recordReview({ messageId: 'x', score: 88 })
    ok(store.getReviews().length === 1, `deduped to ${store.getReviews().length}`)
    ok(store.getReviews()[0].score === 88, 'the latest score wins')
    ok(typeof store.getReviews()[0].at === 'string', 'timestamp stamped')

    // Unaddressable records never enter the ring.
    store.recordReview({ messageId: '', score: 50 })
    store.recordReview({ messageId: 'no-score', decision: 'pass' })
    ok(store.getReviews().length === 1, `unusable records dropped, got ${store.getReviews().length}`)

    for (let i = 0; i < 260; i += 1) store.recordReview({ messageId: `m-${i}`, score: 50 })
    const all = store.getReviews()
    ok(all.length === 200, `review ring capped at 200, got ${all.length}`)
    ok(all[0].messageId === 'm-259', `newest first, got ${all[0].messageId}`)
    ok(!all.some((entry) => entry.messageId === 'x'), 'the oldest record was evicted')
  } finally { cleanup() }
})

test('reviewsPayload shapes records for the UI and drops unusable ones', async () => {
  const { store, cleanup } = await makeTestStore()
  try {
    store.recordReview({
      messageId: 'a', score: 91, threshold: 80, decision: 'pass',
      attempt: 1, turn: 2, reason: 'good', sessionId: 'secret-session',
    })
    store.recordReview({
      messageId: 'b', score: 61, threshold: 80, decision: 'steer',
      attempt: 2, turn: 4, reason: 'x'.repeat(500),
    })
    const payload = reviewsPayload(store)
    ok(payload.entries.length === 2, `kept ${payload.entries.length}`)
    ok(payload.entries[0].messageId === 'b', `newest first, got ${payload.entries[0].messageId}`)
    const b = payload.entries[0]
    ok(b.threshold === 80 && b.attempt === 2 && b.turn === 4, `record=${JSON.stringify(b)}`)
    ok(typeof b.at === 'string' && b.at.length > 0, 'record carries a timestamp')
    ok(b.reason.length === 300, `reason trimmed to ${b.reason.length}`)
    ok(!('sessionId' in b), `sessionId is not published: ${JSON.stringify(b)}`)
    ok(typeof payload.at === 'string', 'payload carries its own timestamp')
    ok(REVIEWS_ROUTE_PATH === '/api/dsh-answer-reviewer/reviews', `route=${REVIEWS_ROUTE_PATH}`)
  } finally { cleanup() }
})

test('createReviewsHandler answers GET and defers to the host fence', async () => {
  const { store, cleanup } = await makeTestStore()
  const fakeRes = () => ({
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = b === undefined ? '' : b },
  })
  try {
    store.recordReview({ messageId: 'm-1', score: 91, threshold: 80, decision: 'pass', attempt: 1, turn: 3 })

    const open = createReviewsHandler(store)
    const res = fakeRes()
    open({ method: 'GET' }, res)
    ok(res.statusCode === 200, `status=${res.statusCode}`)
    const payload = JSON.parse(res.body)
    ok(payload.entries.length === 1 && payload.entries[0].messageId === 'm-1', `body=${res.body}`)
    ok(res.headers['content-type'].startsWith('application/json'), 'JSON content type')
    ok(res.headers['cache-control'] === 'no-store', 'never cached')

    const resPost = fakeRes()
    open({ method: 'POST' }, resPost)
    ok(resPost.statusCode === 405, `POST status=${resPost.statusCode}`)

    // The host passes connection.requestRejection here. A refusal must answer
    // the request and short-circuit BEFORE the payload is ever built.
    let rejectCalls = 0
    const guarded = createReviewsHandler(store, {
      reject(req, r) { rejectCalls += 1; r.statusCode = 401; r.end(); return true },
    })
    const res401 = fakeRes()
    guarded({ method: 'GET' }, res401)
    ok(rejectCalls === 1, `fence called ${rejectCalls} times`)
    ok(res401.statusCode === 401 && res401.body === '', `fenced status=${res401.statusCode}`)

    // A fence that abstains lets the request through.
    const abstaining = createReviewsHandler(store, { reject: () => false })
    const resOk = fakeRes()
    abstaining({ method: 'GET' }, resOk)
    ok(resOk.statusCode === 200, `abstaining fence status=${resOk.statusCode}`)
  } finally { cleanup() }
})

// --- Client bundle ----------------------------------------------------------
// The client bundle is a self-executing script that calls
// `window.__ModuleLoader__.load({ id, factory })`. We don't boot a browser
// here; we set up a stub window + react + service stubs and verify the
// factory wires up correctly: apply() exists, both mounts are registered
// through the lazy ctx.inject path, and the rendered components mount an
// iframe onto the standalone config page.

/**
 * Load lib/client.js inside a vm with a stub `window.__ModuleLoader__` and
 * a stub react, then run the factory + apply(ctx) against a recording ctx.
 *
 * No browser and no reconciler: `createElement` immediately invokes function
 * components, so a registered component can be called directly to obtain its
 * element tree.
 */
function loadClientBundle({ storage } = {}) {
  const registered = [] // betterSidebar tabs
  const effects = []
  const injectCalls = []
  const slotInjects = []
  const slotRegistrations = []
  const createElement = function (type, props, ...children) {
    if (typeof type === 'function') {
      return type(Object.assign({}, props || {}), ...children)
    }
    return { type, props: props || {}, children: children.length === 1 ? children[0] : children }
  }
  const useState = (initial) => [initial, () => {}]
  const useEffect = () => {}
  const reactStub = { createElement, useState, useEffect, default: { createElement, useState, useEffect } }
  let exportsObj = null
  const moduleLoader = { load(opts) {
    if (!opts || typeof opts.factory !== 'function') throw new Error('load called with no factory')
    exportsObj = opts.factory((id) => id === 'react' ? reactStub : null)
  } }
  const win = { __ModuleLoader__: moduleLoader }
  if (storage) win.localStorage = storage
  const sandbox = { window: win }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(resolve(pkgRoot, 'lib/client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })

  // The host's client-loader calls apply(ctx) next. Every service is a stub
  // that records what the bundle asked for. `inject` drives its callback
  // immediately, mirroring cordis once the waited-for service is available.
  const ctx = {
    effect(fn) { effects.push(fn); return () => {} },
    inject(deps, cb) { injectCalls.push(deps); cb(ctx) },
    slots: {
      inject(slotName, cb) { slotInjects.push(slotName); return cb() },
      register(descriptor, component) {
        slotRegistrations.push({ descriptor, component })
        return () => {}
      },
    },
    betterSidebar: { registerTab(desc) { registered.push(desc); return () => {} } },
  }
  return { exports: exportsObj, ctx, registered, effects, injectCalls, slotInjects, slotRegistrations }
}

/** Depth-first search for the first node of a given element type. */
function findNode(node, type) {
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  const kids = node.children
  if (Array.isArray(kids)) {
    for (const k of kids) { const f = findNode(k, type); if (f) return f }
  } else if (kids && typeof kids === 'object') {
    const f = findNode(kids, type); if (f) return f
  }
  return null
}

/** Every node of a given element type, depth-first. */
function findAllNodes(node, type, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === type) out.push(node)
  const kids = node.children
  if (Array.isArray(kids)) {
    for (const k of kids) findAllNodes(k, type, out)
  } else if (kids && typeof kids === 'object') {
    findAllNodes(kids, type, out)
  }
  return out
}

/** Concatenate every string leaf under a node — the element's text content. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  const kids = node.children
  if (Array.isArray(kids)) return kids.map(textOf).join('')
  return textOf(kids)
}

test('client bundle registers the dock, the score chip, and the sidebar tab', async () => {
  const h = loadClientBundle()
  ok(h.exports, 'factory returned an exports object')
  ok(typeof h.exports.apply === 'function', 'exports.apply is a function')
  h.exports.apply(h.ctx)

  // Both mounts must go through the LAZY ctx.inject path — one entry, two
  // optional deps. A hard `exports.inject` dependency would leave the entry
  // "pending (waiting for service: ...)" and paint a
  // "Failed to load plugins" banner whenever a service is absent.
  const depSets = h.injectCalls.map((d) => d.join('+')).sort()
  ok(depSets.length === 2, `apply() waited for deps twice, got ${depSets.length}`)
  ok(depSets[0] === 'betterSidebar', `unexpected lazy deps: ${JSON.stringify(h.injectCalls)}`)
  ok(depSets[1] === 'slots', `unexpected lazy deps: ${JSON.stringify(h.injectCalls)}`)
  ok(h.effects.length === 2, `apply() registered two effects, got ${h.effects.length}`)

  // Driving the effects is where both registrations live.
  for (const fn of h.effects) fn()

  // --- mount 1: conversation input dock -----------------------------------
  ok(h.slotInjects.length === 2, `slots.inject called twice, got ${h.slotInjects.length}`)
  ok(
    h.slotInjects[0] === 'conversation.input.dock',
    `dock slot=${h.slotInjects[0]}`
  )
  ok(
    h.slotInjects[1] === 'conversation.chat.assistant-actions',
    `score slot=${h.slotInjects[1]}`
  )
  ok(h.slotRegistrations.length === 2, `two surfaces registered, got ${h.slotRegistrations.length}`)
  const { descriptor, component } = h.slotRegistrations[0]
  ok(descriptor.name === 'conversation.input.dock', `descriptor.name=${descriptor.name}`)
  // `kind: "list"` slots THROW without options.id. Ordering for a list slot is
  // `(priority ?? 0) || (order ?? 0)` — see the registry's entry sort — so
  // `priority` is the primary key and `order` only breaks ties.
  ok(descriptor.id === 'answer-reviewer:config', `descriptor.id=${descriptor.id}`)
  ok(descriptor.priority === 30, `descriptor.priority=${descriptor.priority}`)
  ok(typeof component === 'function', 'dock registration carries a component function')

  // --- mount 2: the score chip in the assistant action row -----------------
  const scoreReg = h.slotRegistrations[1]
  ok(scoreReg.descriptor.name === 'conversation.chat.assistant-actions', `score name=${scoreReg.descriptor.name}`)
  ok(scoreReg.descriptor.id === 'answer-reviewer:score', `score id=${scoreReg.descriptor.id}`)
  // The shipped Like/Dislike entry takes the default order, so a positive one
  // parks the score to its right instead of shadowing it.
  ok(scoreReg.descriptor.order === 100, `score order=${scoreReg.descriptor.order}`)
  ok(scoreReg.descriptor.priority === undefined, 'score chip does not fight over priority')
  ok(typeof scoreReg.component === 'function', 'score registration carries a component function')
  // No score for this message yet => the chip must render NOTHING, so the
  // action row is byte-identical to stock dsh until a review lands.
  const quiet = scoreReg.component({ messageId: 'msg-without-score' })
  ok(quiet === null, `score chip renders null without a score, got ${JSON.stringify(quiet)}`)

  // Collapsed by default => the iframe is UNMOUNTED so a closed dock never
  // runs the page's poll timers.
  const collapsed = component({ sessionId: 's1' })
  ok(collapsed && collapsed.type === 'div', 'dock root is a div')
  ok(findNode(collapsed, 'iframe') === null, 'collapsed dock mounts no iframe')
  const toggle = findNode(collapsed, 'button')
  ok(toggle, 'collapsed dock renders a toggle button')
  // The whole strip is one button — icon + label + caret — matching dsh's own
  // dock headers, so assert on aggregated text plus the aria state.
  ok(textOf(toggle).includes('Reviewer 配置'), `strip label=${textOf(toggle)}`)
  ok(toggle.props['aria-expanded'] === false, 'collapsed strip reports aria-expanded=false')
  // The collapsed strip is deliberately quiet: no address, no deep link.
  ok(!textOf(toggle).includes('127.0.0.1'), 'collapsed strip hides the address')
  ok(!textOf(toggle).includes('新标签'), 'collapsed strip hides the deep link')

  // Screenshot the second mount too.
  ok(h.registered.length === 1, `one tab registered, got ${h.registered.length}`)
  const desc = h.registered[0]
  ok(desc.id === 'dsh-answer-reviewer:config', `tab id=${desc.id}`)
  ok(desc.title === 'Reviewer 配置', `tab title=${desc.title}`)
  ok(desc.single === true, 'tab marked single-instance')
  ok(typeof desc.component === 'function', 'tab has a component function')
  const tabTree = desc.component({ visible: true })
  ok(tabTree && tabTree.type === 'div', 'tab root is a div')
  const tabIframe = findNode(tabTree, 'iframe')
  ok(tabIframe, 'tab tree contains an iframe')
  ok(
    tabIframe.props.src === 'http://127.0.0.1:3987/',
    `tab iframe src=${tabIframe.props.src}`
  )
})

test('expanded dock mounts the config iframe and a collapse control', () => {
  // localStorage remembers the expanded state across reloads.
  const h = loadClientBundle({ storage: { getItem: () => '1', setItem() {} } })
  h.exports.apply(h.ctx)
  for (const fn of h.effects) fn()
  const { component } = h.slotRegistrations[0]

  const tree = component({ sessionId: 's1' })
  const iframe = findNode(tree, 'iframe')
  ok(iframe, 'expanded dock mounts an iframe')
  ok(
    iframe.props.src === 'http://127.0.0.1:3987/',
    `dock iframe src=${iframe.props.src}, expected the standalone config page`
  )
  const toggle = findNode(tree, 'button')
  ok(toggle && toggle.props['aria-expanded'] === true, 'expanded strip reports aria-expanded=true')
  ok(
    textOf(toggle).includes('127.0.0.1:3987'),
    `expanded strip surfaces the address: ${textOf(toggle)}`
  )
  ok(textOf(toggle).includes('新标签'), 'expanded strip offers the deep link')
  // A dead config server must not leave the user staring at a blank frame.
  ok(findAllNodes(tree, 'iframe').length === 1, 'exactly one iframe while expanded')
})

test('dock geometry cannot be crushed by the composer column', () => {
  // Regression guard. `conversation.input.dock` entries are direct flex
  // children of dsh's fixed-height `.composerStack`. With the default
  // `flex-shrink: 1` the dock was squeezed to ~10px and its own
  // `overflow: hidden` clipped the label into an unreadable sliver.
  // `flex: none` is what stops that, and the width formula is what keeps the
  // strip aligned with the composer card instead of the whole column.
  const h = loadClientBundle({ storage: { getItem: () => '0', setItem() {} } })
  h.exports.apply(h.ctx)
  for (const fn of h.effects) fn()
  const tree = h.slotRegistrations[0].component({ sessionId: 's1' })

  ok(tree.props.style.flex === 'none', `dock root flex=${tree.props.style.flex}`)
  const width = String(tree.props.style.width || '')
  ok(width.includes('100% -'), `dock width is inset-based: ${width}`)
  ok(
    width.includes('--dsh-composer-side-clearance') &&
      width.includes('--dsh-composer-dock-inset'),
    `dock width reuses the composer geometry vars: ${width}`
  )
  ok(
    String(tree.props.style.maxWidth).includes('--dsh-composer-card-max-width'),
    `dock maxWidth reuses the composer card width: ${tree.props.style.maxWidth}`
  )
  ok(tree.props.style.position === 'relative', 'dock root is a positioning context')
})

test('expanded dock overlays instead of reflowing the transcript', () => {
  // The panel must be taken OUT of flow. An inline panel inside the fixed
  // composer column pushes the composer down and reflows every message,
  // which is exactly the "intrusive" behaviour that was reported.
  const h = loadClientBundle({ storage: { getItem: () => '1', setItem() {} } })
  h.exports.apply(h.ctx)
  for (const fn of h.effects) fn()
  const tree = h.slotRegistrations[0].component({ sessionId: 's1' })

  // The overlay is the absolutely positioned child that is NOT the strip.
  const positioned = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.props && node.props.style && node.props.style.position === 'absolute') {
      positioned.push(node)
    }
    const kids = node.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else if (kids && typeof kids === 'object') walk(kids)
  }
  walk(tree)
  ok(positioned.length === 1, `exactly one absolutely positioned panel, got ${positioned.length}`)
  const overlay = positioned[0]
  ok(overlay.props.style.bottom === '100%', `overlay bottom=${overlay.props.style.bottom}`)
  ok(
    String(overlay.props.style.height).includes('vh'),
    `overlay height is viewport-capped: ${overlay.props.style.height}`
  )
  ok(findNode(overlay, 'iframe'), 'the iframe lives inside the overlay')

  // And the strip itself must stay in flow, directly above the composer.
  const strip = tree.children[1]
  ok(strip && strip.props.style.position === 'relative', 'strip is the in-flow sibling')
})

test('dock embeds the SAME page as the sidebar tab (single source of truth)', () => {
  // Both mounts iframe the standalone server, so the HTTP API and both UI
  // mounts share one ConfigStore and cannot drift.
  const collapsed = loadClientBundle({ storage: { getItem: () => '0', setItem() {} } })
  collapsed.exports.apply(collapsed.ctx)
  for (const fn of collapsed.effects) fn()
  const dockComponent = collapsed.slotRegistrations[0].component
  const tabComponent = collapsed.registered[0].component

  // Force the dock open by replaying with storage = expanded.
  const expanded = loadClientBundle({ storage: { getItem: () => '1', setItem() {} } })
  expanded.exports.apply(expanded.ctx)
  for (const fn of expanded.effects) fn()
  const dockIframe = findNode(expanded.slotRegistrations[0].component({}), 'iframe')
  const tabIframe = findNode(tabComponent({ visible: true }), 'iframe')
  ok(dockIframe && tabIframe, 'both mounts render an iframe')
  ok(
    dockIframe.props.src === tabIframe.props.src,
    `dock=${dockIframe.props.src} tab=${tabIframe.props.src}`
  )
  ok(typeof dockComponent === 'function', 'dock component is a function')
})

test('score chip renders the score, its band, and the retry count', () => {
  const h = loadClientBundle()
  h.exports.apply(h.ctx)
  for (const fn of h.effects) fn()
  const chip = h.slotRegistrations[1].component
  ok(typeof h.exports.__test?.setScores === 'function', 'bundle exposes the score test seam')

  h.exports.__test.setScores({
    pass: {
      messageId: 'pass', score: 91, threshold: 80, decision: 'pass',
      attempt: 1, turn: 3, reason: 'looks right', at: '2026-01-01T00:00:00.000Z',
    },
    low: {
      messageId: 'low', score: 61, threshold: 80, decision: 'steer',
      attempt: 2, turn: 4, reason: 'missed the ask', at: '2026-01-01T00:00:01.000Z',
    },
  })

  const passing = chip({ messageId: 'pass' })
  ok(passing && passing.type === 'span', 'chip root is a span')
  ok(textOf(passing) === '评分 91', `passing label=${textOf(passing)}`)
  // The band drives the tint through dsh's own state tokens, so the chip
  // follows the host theme instead of hardcoding a palette.
  ok(passing.props.style.background.includes('state-success'), `passing tint=${passing.props.style.background}`)
  ok(passing.props['data-answer-reviewer-score'] === '91', 'score exposed as a data attribute')
  ok(passing.props.title.includes('阈值 80'), `title carries the gate: ${passing.props.title}`)
  ok(passing.props.title.includes('通过'), `title carries the verdict: ${passing.props.title}`)
  ok(passing.props.title.includes('looks right'), `title carries the reason: ${passing.props.title}`)

  const low = chip({ messageId: 'low' })
  ok(textOf(low) === '评分 61 · 第2次', `low label=${textOf(low)}`)
  ok(low.props.style.background.includes('state-warn'), `low tint=${low.props.style.background}`)
  ok(low.props.title.includes('打回'), `low title=${low.props.title}`)

  // A capped answer (below threshold, out of retries) is a distinct verdict:
  // the score is published but nothing was pushed back, so saying "已打回" would
  // be a lie. This is the case the whole cap-review fix exists to surface.
  h.exports.__test.setScores({
    capped: {
      messageId: 'capped', score: 55, threshold: 90, decision: 'capped',
      attempt: 4, turn: 3, reason: 'still wrong', at: '2026-01-01T00:00:02.000Z',
    },
  })
  const capped = chip({ messageId: 'capped' })
  ok(capped && textOf(capped) === '评分 55 · 第4次', `capped label=${textOf(capped)}`)
  ok(capped.props.style.background.includes('state-warn'), `capped tint=${capped.props.style.background}`)
  ok(capped.props.title.includes('重试次数已用尽'), `capped title=${capped.props.title}`)
  ok(capped.props.title.includes('still wrong'), `capped title keeps the reason: ${capped.props.title}`)

  // Silence, not a placeholder, for anything the reviewer skipped.
  ok(chip({ messageId: 'unknown' }) === null, 'unknown message renders nothing')
  ok(chip({}) === null, 'missing messageId renders nothing')
  ok(chip(null) === null, 'null props renders nothing')
})

test('client bundle CONFIG_ORIGIN stays in sync with DEFAULT_HTTP_PORT', () => {
  // The client bundle cannot import lib/config-store.js (it is loaded raw
  // into the renderer, no bundler), so the port is duplicated as a literal.
  // This guard is the only thing keeping the two from drifting apart.
  const src = readFileSync(resolve(pkgRoot, 'lib/client.js'), 'utf8')
  const m = src.match(/http:\/\/127\.0\.0\.1:(\d+)/)
  ok(m, 'client bundle declares a config origin')
  ok(
    Number(m[1]) === DEFAULT_HTTP_PORT,
    `client origin port ${m[1]} != server DEFAULT_HTTP_PORT ${DEFAULT_HTTP_PORT}`
  )
})

test('client bundle does not hard-depend on betterSidebar', () => {
  const captured = {}
  const moduleLoader = { load(opts) {
    captured.exports = opts.factory((id) => id === 'react' ? { createElement(){}, default:{createElement(){}} } : null)
  } }
  const ctx = {
    effect() {},
    inject() {},
    betterSidebar: { registerTab() {} },
  }
  const sandbox = { window: { __ModuleLoader__: moduleLoader } }
  vm.createContext(sandbox)
  const code = readFileSync(resolve(pkgRoot, 'lib/client.js'), 'utf8')
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
  ok(typeof captured.exports.apply === 'function', 'exports.apply is a function')
  ok(Array.isArray(captured.exports.inject), 'exports.inject is an array')
  ok(
    captured.exports.inject.length === 0,
    `exports.inject declares nothing, got ${JSON.stringify(captured.exports.inject)}`
  )
  ok(
    !captured.exports.inject.includes('betterSidebar'),
    'betterSidebar is not a hard inject — a hard inject stalls the entry with ' +
      '"pending (waiting for service: betterSidebar)" when dsh-better-sidebar is absent'
  )
})

// Regression: when a service is absent (no dsh-better-sidebar, or a host
// whose shell does not declare the dock slot), cordis never fires the
// `ctx.inject` callback — but the ENTRY still activates. apply() must
// therefore neither throw nor touch `ctx.betterSidebar` / `ctx.slots` on
// that path, otherwise the host main page breaks instead of merely losing
// one mount.
test('apply() survives a host with neither betterSidebar nor slots', () => {
  const captured = {}
  const moduleLoader = { load(opts) {
    captured.exports = opts.factory((id) => id === 'react' ? { createElement(){}, default:{createElement(){}} } : null)
  } }
  const sandbox = { window: { __ModuleLoader__: moduleLoader } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(resolve(pkgRoot, 'lib/client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })

  const lazyDeps = []
  const ctx = {
    // Reached only if apply() registers eagerly — i.e. only if a lazy
    // inject was replaced by a direct ctx.slots / ctx.betterSidebar access.
    effect() { throw new Error('apply() must not register eagerly without the service') },
    inject(deps, cb) {
      lazyDeps.push(deps)
      // Cordis leaves the child fiber pending: the callback is simply never
      // called. Deliberately do NOT invoke cb.
      void cb
    },
  }
  captured.exports.apply(ctx) // must not throw
  const sets = lazyDeps.map((d) => d.join('+')).sort()
  ok(sets.length === 2, `apply() waited for deps twice, got ${sets.length}`)
  ok(sets[0] === 'betterSidebar', `missing lazy betterSidebar wait: ${JSON.stringify(lazyDeps)}`)
  ok(sets[1] === 'slots', `missing lazy slots wait: ${JSON.stringify(lazyDeps)}`)
})

// The manifest's dsh.client.inject carries PACKAGE-ROW names (as every
// official bundle does), not cordis service names. `betterSidebar` is a
// service, so listing it there was meaningless; it must not come back.
test('package.json dsh.client.inject declares no service name', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'))
  ok(pkg.dsh && pkg.dsh.client, 'package.json declares dsh.client')
  ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject is an array')
  for (const name of pkg.dsh.client.inject) {
    ok(
      !['betterSidebar', 'slots', 'sessions', 'locale'].includes(name),
      `dsh.client.inject must list package rows, not the service "${name}"`
    )
  }
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
