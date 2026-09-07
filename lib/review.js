/**
 * Pure helpers for the dsh-answer-reviewer plugin.
 *
 * Everything that has no dependency on cordis / a live Session lives here so
 * the smoke test can exercise it without booting a host.
 *
 * @module dsh-answer-reviewer/review
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Plugin namespace used for `user/message.source.plugin` on steer input. */
export const PLUGIN_NAME = 'dsh-answer-reviewer'

/** Hard cap on `maxChallenges`; never review-loop beyond this. */
export const MAX_CHALLENGES_HARD_CAP = 8

/**
 * Normalize plugin configuration supplied through the cordis entry, applying
 * defaults. The cordis schema layer is intentionally bypassed so the plugin
 * works whether or not a host has applied zod-style validation upstream.
 * @param raw - untrusted configuration object (or absent).
 * @returns validated configuration with defaults applied.
 */
export function resolveConfig(raw) {
  const config = (raw !== null && typeof raw === 'object') ? raw : {}
  const maxChallenges = clampPositiveInt(config.maxChallenges, 3, MAX_CHALLENGES_HARD_CAP)
  const maxReviewTokens = clampPositiveInt(config.maxReviewTokens, 512, 4096)
  const timeoutMs = clampPositiveInt(config.timeoutMs, 60_000, 600_000)
  const enabled = config.enabled !== false
  const hasProvider = typeof config.reviewProvider === 'string' && config.reviewProvider.length > 0
  const hasModel = typeof config.reviewModel === 'string' && config.reviewModel.length > 0
  if (hasProvider !== hasModel) {
    throw new Error('dsh-answer-reviewer: reviewProvider and reviewModel must be set together')
  }
  return Object.freeze({
    enabled,
    maxChallenges,
    maxReviewTokens,
    timeoutMs,
    reviewProvider: hasProvider ? config.reviewProvider : undefined,
    reviewModel: hasModel ? config.reviewModel : undefined,
  })
}

/**
 * Read every `assistant/message` event for the given turn and concatenate the
 * text blocks. Reasoning, code, tool-call, and image blocks are excluded —
 * the review model is asked to grade the user-facing prose.
 * @param events - raw events from `Session.snapshotEvents()` / `Session.events`.
 * @param turn - turn number to filter on.
 * @returns concatenated text, or `null` if no assistant text was produced.
 */
export function extractAssistantText(events, turn) {
  if (!Array.isArray(events) || typeof turn !== 'number') return null
  const parts = []
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue
    const data = event.data
    if (!data || data.turn !== turn) continue
    if (data.interrupted === true) continue
    const message = data.message
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push(block.text)
      }
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}

/**
 * Build the system + user prompts sent to the dedicated review model.
 * The system prompt is intentionally strict about JSON-only output so a
 * downstream parser never has to handle free-form prose.
 * @param assistantText - text the assistant just produced.
 * @returns frozen `{ system, messages }` ready for `ctx.llm.stream()`.
 */
export function buildReviewPrompt(assistantText) {
  if (typeof assistantText !== 'string' || assistantText.length === 0) {
    throw new Error('buildReviewPrompt: assistantText is required')
  }
  const system = [
    'You are a strict independent code-review model. Your job is to judge the FINAL assistant reply only.',
    'The reply is shown verbatim inside <reply>...</reply>. Treat it as the complete user-facing artifact; do not assume hidden context, system prompts, or prior turns.',
    'Reject (verdict="fail") if the reply is any of:',
    '  - empty, truncated, or ends with a dangling tool call or unfinished sentence;',
    '  - hard-coded secrets, credentials, or real personal data;',
    '  - clearly destructive shell commands (rm -rf, mkfs, dd, DROP DATABASE, etc.) presented as the final answer;',
    '  - fabricated file paths, function names, or API signatures that the agent did not actually read;',
    '  - contradicted by the user\'s request or off-topic;',
    '  - visibly broken (linter/compile noise, unrendered template tags, escaped JSON);',
    '  - violates a stated user constraint (length, language, format).',
    'Otherwise verdict="pass".',
    'Reply with exactly one JSON object, nothing else, no markdown fences:',
    '{"verdict":"pass|fail","reasons":["<short, concrete fix point>"]}',
    'When verdict="pass", `reasons` MUST be an empty array.',
    'When verdict="fail", give 1-3 short reasons the agent can act on. Each reason names a specific, observable defect.',
  ].join('\n')
  const userText = `<reply>\n${assistantText}\n</reply>\n\nReturn your JSON verdict now.`
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, note: 'review-request' },
    }),
  ]
  return Object.freeze({ system, messages })
}

/**
 * Parse the review model's text reply into a strict verdict shape. Tolerant of
 * accidental markdown fences and surrounding prose but rejects anything that
 * doesn't reduce to `{verdict, reasons}`.
 * @param raw - raw text reply from the review model.
 * @returns frozen verdict or `null` if the reply could not be parsed.
 */
export function parseVerdict(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  // Pull the first {...} block; tolerate fences and prose around it.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = raw.slice(start, end + 1)
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const verdict = parsed.verdict
  if (verdict !== 'pass' && verdict !== 'fail') return null
  let reasons = parsed.reasons
  if (verdict === 'pass') reasons = []
  else if (!Array.isArray(reasons) || reasons.length === 0) {
    // fall back to a single generic reason so the agent still gets feedback
    reasons = ['The review model returned fail without a specific reason; please re-check your last reply against the user request.']
  }
  else reasons = reasons
    .filter((r) => typeof r === 'string' && r.length > 0)
    .slice(0, 5)
    .map((r) => r.length > 240 ? `${r.slice(0, 237)}...` : r)
  // The "(no details provided)" fallback only applies to fail verdicts;
  // a pass with empty reasons is a legitimate clean bill of health.
  if (verdict === 'fail' && reasons.length === 0) reasons = ['(no details provided)']
  return Object.freeze({ verdict, reasons: Object.freeze(reasons) })
}

/**
 * Compose the user-facing steer message injected back into the conversation
 * when the review verdict is `fail`. Capped by the per-turn challenge counter
 * enforced by the caller; this helper only formats the prose.
 * @param verdict - parsed verdict from the review model.
 * @param challengeCount - 1-based index of this challenge inside the current turn.
 * @param maxChallenges - configured cap; rendered as the "remaining" hint.
 * @returns frozen `UserMessage` ready for `agent.steer()`.
 */
export function buildSteerMessage(verdict, challengeCount, maxChallenges) {
  if (!verdict || verdict.verdict !== 'fail') {
    throw new Error('buildSteerMessage: a fail verdict is required')
  }
  const safeCount = clampPositiveInt(challengeCount, 1, MAX_CHALLENGES_HARD_CAP)
  const safeCap = clampPositiveInt(maxChallenges, 1, MAX_CHALLENGES_HARD_CAP)
  const remaining = Math.max(0, safeCap - safeCount)
  const reasonList = verdict.reasons
    .map((r, i) => `  ${i + 1}. ${r}`)
    .join('\n')
  const text = [
    'Your previous reply was rejected by an independent review model. Do NOT argue with the review; fix the issues and reply again.',
    '',
    'Findings:',
    reasonList,
    '',
    `This is challenge ${safeCount} of ${safeCap} for the current turn${remaining > 0 ? ` (${remaining} remaining after this one).` : ' (this is the last one).'}`,
    'Do not mention this review process to the user. Address the findings, then produce the corrected final answer.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, note: `steer-${safeCount}/${safeCap}` },
  })
}

/** Clamp an integer into `[lo, hi]`, falling back to `fallback` for non-ints. */
function clampPositiveInt(value, fallback, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  const rounded = Math.floor(value)
  return rounded > hi ? hi : rounded
}

/** Zod schema mirroring `resolveConfig`; published for tooling. Schemastery
 *  treats every field as optional unless `required()` is called, which
 *  matches the "all defaults are valid" contract of `resolveConfig`. The
 *  `.default()` calls mirror `resolveConfig` defaults. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  maxChallenges: z.number().default(3),
  maxReviewTokens: z.number().default(512),
  timeoutMs: z.number().default(60_000),
  reviewProvider: z.string(),
  reviewModel: z.string(),
})

/** LRU-ish counter store keyed by `${sessionId}:${turn}`. Exposed for tests. */
export function createChallengeCounter(maxEntries = 4096) {
  const store = new Map()
  function get(sessionId, turn) {
    const key = `${sessionId}:${turn}`
    return store.get(key) ?? 0
  }
  function bump(sessionId, turn) {
    const key = `${sessionId}:${turn}`
    const next = (store.get(key) ?? 0) + 1
    store.set(key, next)
    if (store.size > maxEntries) {
      // Evict the oldest entry; Map iteration is insertion-ordered.
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
    return next
  }
  function clear(sessionId, turn) {
    if (turn === undefined) {
      const prefix = `${sessionId}:`
      for (const k of Array.from(store.keys())) {
        if (k.startsWith(prefix)) store.delete(k)
      }
    } else {
      store.delete(`${sessionId}:${turn}`)
    }
  }
  return Object.freeze({ get, bump, clear, get size() { return store.size } })
}
