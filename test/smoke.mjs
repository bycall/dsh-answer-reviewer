#!/usr/bin/env node
/**
 * Smoke test for dsh-answer-reviewer.
 *
 * Runs without a live dsh host. Self-bootstraps node_modules symlinks for
 * the plugin's peer dependencies (resolved against the active dsh install)
 * so the ESM `import '@deepseek-ai/...'` statements work, then dynamically
 * imports the plugin and exercises every pure helper plus the fail-open
 * and skip-subagent branches of onTurnStopping with mock objects.
 *
 * Exit code 0 = all green.
 */

import { existsSync, mkdirSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
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
  extractAssistantText,
  name,
  onTurnStopping,
  parseVerdict,
  resolveConfig,
} = plugin

const tests = []
const test = (label, fn) => tests.push({ label, fn })
const ok = (cond, message) => { if (!cond) throw new Error(`assertion failed: ${message}`) }

test('name exports the right plugin id', () => {
  ok(name === 'dsh-answer-reviewer', `name=${name}`)
})

test('resolveConfig applies defaults', () => {
  const c = resolveConfig(undefined)
  ok(c.enabled === true, 'enabled defaults to true')
  ok(c.maxChallenges === 3, 'maxChallenges defaults to 3')
  ok(c.maxReviewTokens === 512, 'maxReviewTokens defaults to 512')
  ok(c.timeoutMs === 60_000, 'timeoutMs defaults to 60_000')
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

test('resolveConfig clamps out-of-range integers', () => {
  const c = resolveConfig({ maxChallenges: 999, maxReviewTokens: 0, timeoutMs: -1 })
  ok(c.maxChallenges === 8, `clamped to cap, got ${c.maxChallenges}`)
  ok(c.maxReviewTokens === 512, `falls back to default, got ${c.maxReviewTokens}`)
  ok(c.timeoutMs === 60_000, `falls back to default, got ${c.timeoutMs}`)
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

test('parseVerdict accepts clean JSON', () => {
  const v = parseVerdict('{"verdict":"pass","reasons":[]}')
  ok(v && v.verdict === 'pass', `got ${JSON.stringify(v)}`)
  ok(v && v.reasons.length === 0, 'reasons empty on pass')
})

test('parseVerdict strips surrounding markdown', () => {
  const v = parseVerdict('Here you go:\n```json\n{"verdict":"fail","reasons":["short"]}\n```')
  ok(v && v.verdict === 'fail', `verdict=${v && v.verdict}`)
  ok(v && v.reasons.length === 1, `reasons=${JSON.stringify(v && v.reasons)}`)
})

test('parseVerdict fails closed on garbage', () => {
  ok(parseVerdict('not json') === null, 'garbage is rejected')
  ok(parseVerdict('') === null, 'empty is rejected')
  ok(parseVerdict('{"verdict":"maybe","reasons":[]}') === null, 'unknown verdict is rejected')
})

test('parseVerdict falls back to a single reason when fail lists none', () => {
  const v = parseVerdict('{"verdict":"fail","reasons":[]}')
  ok(v && v.verdict === 'fail', 'still fail')
  ok(v && v.reasons.length === 1, `fallback reasons len=${v && v.reasons.length}`)
})

test('buildSteerMessage renders the challenge counter and findings', () => {
  const v = { verdict: 'fail', reasons: ['truncated', 'mentions rm -rf'] }
  const m = buildSteerMessage(v, 1, 3)
  ok(m.role === 'user', 'role user')
  ok(m.source && m.source.kind === 'plugin', 'source plugin')
  ok(m.source.plugin === 'dsh-answer-reviewer', 'plugin id')
  ok(m.content[0].text.includes('challenge 1 of 3'), 'challenge position')
  ok(m.content[0].text.includes('2 remaining'), 'remaining count')
  ok(m.content[0].text.includes('truncated'), 'reasons listed')
})

test('buildSteerMessage shows zero remaining on the last challenge', () => {
  const v = { verdict: 'fail', reasons: ['x'] }
  const m = buildSteerMessage(v, 3, 3)
  ok(m.content[0].text.includes('last one'), 'last one hint')
})

test('createChallengeCounter bumps and clears', () => {
  const c = createChallengeCounter(2)
  ok(c.get('s', 1) === 0, 'starts at 0')
  c.bump('s', 1)
  c.bump('s', 1)
  ok(c.get('s', 1) === 2, 'bumped twice')
  c.bump('s', 2)
  ok(c.get('s', 2) === 1, 'separate turn key')
  c.bump('s', 3) // evicts oldest (s:1)
  ok(c.size === 2, `evicted, size=${c.size}`)
  c.clear('s', 2)
  ok(c.get('s', 2) === 0, 'cleared one turn')
  c.clear('s')
  ok(c.size === 0, 'cleared all for session')
})

test('buildReviewPrompt wraps the reply and demands JSON output', () => {
  const p = buildReviewPrompt('Here is my answer.')
  ok(p.system.includes('JSON'), 'system demands JSON output')
  ok(p.messages.length === 1, 'one user message')
  const block = p.messages[0].content[0]
  ok(block.type === 'text', 'text block')
  ok(block.text.includes('<reply>'), 'wraps in <reply>')
  ok(block.text.includes('Here is my answer.'), 'includes content')
  ok(p.messages[0].source.plugin === 'dsh-answer-reviewer', 'source plugin id')
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
  await onTurnStopping(ctx, resolveConfig({}), createChallengeCounter(), { agent, turn: 1 })
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
  await onTurnStopping(ctx, resolveConfig({}), createChallengeCounter(), { agent, turn: 1 })
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
  await onTurnStopping(ctx, resolveConfig({}), createChallengeCounter(), { agent, turn: 1 })
  ok(!steerCalled, 'no steer on review failure')
  ok(warned.includes('review call failed'), `expected fail-open warn, got: ${warned}`)
})

test('onTurnStopping fail-open on parse failure', async () => {
  let steerCalled = false
  const ctx = {
    logger: { info() {}, warn() {} },
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
  await onTurnStopping(ctx, resolveConfig({}), createChallengeCounter(), { agent, turn: 1 })
  ok(!steerCalled, 'no steer on parse failure')
})

test('Config schema covers the same fields as resolveConfig', () => {
  ok(typeof Config === 'function', 'Config is exported')
  const parsed = Config({})
  ok(parsed.enabled === true, 'schema default enabled')
  ok(parsed.maxChallenges === 3, 'schema default maxChallenges')
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
