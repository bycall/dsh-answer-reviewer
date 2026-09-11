/**
 * Pure helpers for the dsh-answer-reviewer plugin.
 *
 * Everything that has no dependency on cordis / a live Session lives here so
 * the smoke test can exercise it without booting a host.
 *
 * Review model = 1-100 score:
 *   * The review model grades the assistant's final reply on quality
 *     (correctness, completeness, helpfulness, format compliance).
 *   * A score >= `threshold` (default 80) closes the turn.
 *   * A score < `threshold` is fed back to the agent via `agent.steer()`,
 *     with the model's reason as concrete feedback. The agent re-runs a
 *     step in the same turn (the `agent/turn-stopping` serial hook lets
 *     a listener `steer()` instead of letting the turn close).
 *   * `maxChallenges` is a defensive hard cap: after N failed attempts
 *     in the same turn, the plugin stops asking and lets the agent's
 *     reply through as-is. The threshold is the real gate; the cap is
 *     just a leak-prevention guard against runaway loops.
 *
 * Conversation context the review model sees:
 *   * Every `user/message` event with `source.kind` other than `'plugin'`
 *     (i.e. real user prompts, not dsh-context-injected reminders).
 *   * The full final assistant text for the current turn.
 * Concatenated and tagged so the review model can score against every
 * instruction the user has given in the session, not just the most
 * recent one.
 *
 * @module dsh-answer-reviewer/review
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Plugin namespace used for `user/message.source.plugin` on steer input. */
export const PLUGIN_NAME = 'dsh-answer-reviewer'

/** Hard cap on `maxChallenges`; never review-loop beyond this. */
export const MAX_CHALLENGES_HARD_CAP = 8

/** Default threshold above which a reply is allowed to close the turn. */
export const DEFAULT_THRESHOLD = 80

/** Inclusive bounds the score must lie in. Out-of-band scores are clamped. */
export const MIN_SCORE = 1
export const MAX_SCORE = 100

/**
 * Normalize plugin configuration supplied through the cordis entry, applying
 * defaults. The cordis schema layer is intentionally bypassed so the plugin
 * works whether or not a host has applied zod-style validation upstream.
 * @param raw - untrusted configuration object (or absent).
 * @returns validated configuration with defaults applied.
 */
export function resolveConfig(raw) {
  const config = (raw !== null && typeof raw === 'object') ? raw : {}
  const maxChallenges = clampPositiveInt(config.maxChallenges, 5, MAX_CHALLENGES_HARD_CAP)
  const maxReviewTokens = clampPositiveInt(config.maxReviewTokens, 512, 4096)
  const timeoutMs = clampPositiveInt(config.timeoutMs, 60_000, 600_000)
  const enabled = config.enabled !== false
  const threshold = clampScore(config.threshold, DEFAULT_THRESHOLD)
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
    threshold,
    reviewProvider: hasProvider ? config.reviewProvider : undefined,
    reviewModel: hasModel ? config.reviewModel : undefined,
  })
}

/**
 * Extract every real (non-plugin) `user/message` event from the session,
 * concatenated as plain text. Plugin-injected context (file-change
 * notices, AGENTS.md, skill content, system reminders) is filtered out
 * so the review model only sees prompts the actual user typed.
 * @param events - raw events from `Session.snapshotEvents()` / `Session.events`.
 * @returns concatenated user prompts, or `null` if no real prompts were issued.
 */
export function extractUserPrompts(events) {
  if (!Array.isArray(events)) return null
  const parts = []
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const data = event.data
    if (!data || !data.source || data.source.kind === 'plugin') continue
    const message = data.message
    if (!message || !Array.isArray(message.content)) continue
    const text = concatTextBlocks(message.content)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return null
  return parts.join('\n\n---\n\n')
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
    parts.push(concatTextBlocks(message.content))
  }
  const text = parts.join('\n\n')
  if (text.length === 0) return null
  return text
}

/**
 * Read the durable message id of the LAST assistant message in the given turn.
 *
 * This is the id the shell itself uses to address a finalized answer: ui-chat
 * builds its turn-tail node with `messageId: event.data.message.id` and hands
 * that value to every `conversation.chat.assistant-actions` entry. Recording
 * the review against the same id is what lets a client badge bind a score to
 * the exact answer it graded, without inventing a parallel identity.
 *
 * @param events - raw events from `Session.snapshotEvents()` / `Session.events`.
 * @param turn - turn number to filter on.
 * @returns the message id string, or `null` when the turn has no addressable
 *          assistant message (or the events carry no id).
 */
export function latestAssistantMessageId(events, turn) {
  if (!Array.isArray(events) || typeof turn !== 'number') return null
  let latest = null
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue
    const data = event.data
    if (!data || data.turn !== turn) continue
    if (data.interrupted === true) continue
    const message = data.message
    if (!message) continue
    if (typeof message.id !== 'string' || message.id.length === 0) continue
    latest = message.id
  }
  return latest
}

/**
 * Build the system + user prompts sent to the dedicated review model.
 * The system prompt asks for a 1-100 score; the user prompt carries the
 * conversation so the model can grade against every user instruction.
 * @param args - context bundle (`{ userPrompts, assistantText, threshold }`).
 * @returns frozen `{ system, messages }` ready for `ctx.llm.stream()`.
 */
export function buildReviewPrompt({ userPrompts, assistantText, threshold }) {
  if (typeof assistantText !== 'string' || assistantText.length === 0) {
    throw new Error('buildReviewPrompt: assistantText is required')
  }
  const safeThreshold = clampScore(threshold, DEFAULT_THRESHOLD)
  const system = [
    'You are a strict independent judge. Score the FINAL assistant reply on a 1-100 integer scale.',
    '',
    'Scoring axes (weighted roughly equal, you decide the breakdown):',
    '  * correctness — no factual, technical, or logical errors;',
    '  * completeness — every prompt the user issued in this conversation is addressed;',
    '  * relevance — answers the actual ask, not adjacent topics;',
    '  * clarity — well-structured, idiomatic, no broken markdown or linter noise;',
    '  * safety — no destructive shell, no fabricated paths/signatures, no leaked secrets;',
    '  * constraint-compliance — respects any explicit length / language / format requests.',
    '',
    'CRITICAL — user constraints trump completeness:',
    '  If the user EXPLICITLY asked for a short answer, a specific format, or a specific',
    '  length limit, then satisfying that request IS the requirement. A reply that is',
    '  deliberately brief BECAUSE the user asked for briefness is NOT incomplete — do',
    '  not penalise it for lacking detail or substance. Score such a reply on whether',
    '  it followed the constraint exactly, not on how much prose it added.',
    '  Examples: "只回复OK两个字" means only reply "OK"; that is a 100, not a 40.',
    '  A one-word answer to a one-word request is a perfect score.',
    '',
    'Quality bands:',
    '  95-100  exceptional, ship as-is (including a perfect, constraint-exact short reply).',
    '  80-94   solid, satisfies all important user requirements.',
    '  60-79   usable but missing real detail or has visible defects.',
    '  40-59   substantially incomplete or wrong.',
    '  1-39    fails outright.',
    `Threshold for "good enough" in this host is ${safeThreshold}.`,
    '',
    'Reply with exactly ONE JSON object, no markdown fences, no surrounding prose:',
    '{"score": <integer 1-100>, "reason": "<<=240 chars, names the ONE most important improvement if score < threshold; empty string if score >= threshold>"}',
    '',
    'Rules:',
    '  * score must be an integer in [1, 100];',
    `  * reason is required when score < ${safeThreshold}, otherwise empty string;`,
    `  * when score < ${safeThreshold}, the reason names a single SPECIFIC, observable defect the agent can act on (cite text or omission);`,
    '  * do NOT invent missing context — score only what the reply actually delivers.',
  ].join('\n')
  const sectionUser = userPrompts && userPrompts.length > 0
    ? `<all_user_prompts>\n${userPrompts}\n</all_user_prompts>`
    : '<all_user_prompts>(none extracted — score the reply only)</all_user_prompts>'
  const userText = `${sectionUser}\n\n<reply>\n${assistantText}\n</reply>\n\nScore now and return your JSON object.`
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, note: 'review-request' },
    }),
  ]
  return Object.freeze({ system, messages })
}

/**
 * Parse the review model's text reply into a strict score shape. Tolerant of
 * accidental markdown fences and surrounding prose but rejects anything that
 * doesn't reduce to `{score, reason}`.
 * @param raw - raw text reply from the review model.
 * @returns frozen `{ score, reason }` or `null` if the reply could not be parsed.
 */
export function parseScore(raw, threshold) {
  if (typeof raw !== 'string' || raw.length === 0) return null
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
  // Use NaN as the "out of band" sentinel: clampScore returns the fallback
  // only for non-finite OR out-of-range inputs. NaN is then distinguishable
  // via Number.isFinite, which lets us null-reject without changing the
  // behaviour of `clampScore` for valid thresholds.
  const score = clampScore(parsed.score, NaN)
  if (!Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) return null
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  // A reason is only mandatory when the score is BELOW the gate: the agent
  // needs concrete feedback to act on. On a pass (score >= threshold) an
  // empty reason is legitimate — the review prompt explicitly allows it —
  // and rejecting it used to misclassify clean passes as parse failures
  // (recorded `parse-fail` with no score). When no threshold is supplied
  // (older callers) we keep the strict fail-closed behaviour.
  const atOrAboveGate = typeof threshold === 'number' && Number.isFinite(threshold) && score >= threshold
  if (reason.length === 0 && !atOrAboveGate) return null
  let trimmed = reason
  if (trimmed.length > 240) trimmed = `${trimmed.slice(0, 237)}...`
  return Object.freeze({ score, reason: trimmed })
}

/**
 * Convenience: returns `true` when a parsed score is at or above the
 * configured threshold. Defensive against a `null` review.
 * @param score - parsed score or `null`.
 * @param threshold - inclusive gate.
 * @returns boolean.
 */
export function isScoreAcceptable(score, threshold) {
  if (!score || typeof score.score !== 'number') return false
  return score.score >= clampScore(threshold, DEFAULT_THRESHOLD)
}

/**
 * Compose the user-facing steer message injected back into the conversation
 * when the review model's score is below the threshold. Capped by the
 * per-turn challenge counter enforced by the caller; this helper only
 * formats the prose.
 * @param args - `{ score, reason, attempt, maxAttempts }`.
 * @returns frozen `UserMessage` ready for `agent.steer()`.
 */
export function buildSteerMessage({ score, reason, attempt, maxAttempts }) {
  const safeScore = clampScore(score, 0)
  const safeAttempt = clampPositiveInt(attempt, 1, MAX_CHALLENGES_HARD_CAP)
  const safeCap = clampPositiveInt(maxAttempts, 1, MAX_CHALLENGES_HARD_CAP)
  const remaining = Math.max(0, safeCap - safeAttempt)
  const trimmedReason = typeof reason === 'string' && reason.length > 0
    ? reason
    : '(no specific defect was named)'
  const text = [
    `An independent review model scored your previous reply ${safeScore}/100, which is below the quality gate. Do NOT argue with the review. Fix the issue and reply again.`,
    '',
    'Most important defect named by the reviewer:',
    `  ${trimmedReason}`,
    '',
    `This is retry ${safeAttempt} of ${safeCap} for the current turn${remaining > 0 ? ` (${remaining} remaining after this one).` : ' (this is the last retry; the next reply will go to the user as-is).'}`,
    'Do not mention this review process to the user. Address the defect, then produce the corrected final answer.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, note: `steer-${safeAttempt}/${safeCap}` },
  })
}

/** Clamp an integer into `[lo, hi]`, falling back to `fallback` for non-ints. */
function clampPositiveInt(value, fallback, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  const rounded = Math.floor(value)
  return rounded > hi ? hi : rounded
}

/** Clamp a number into [1, 100]. Returns `fallback` when value is non-finite
 *  OR out of range (does NOT silently clamp out-of-range inputs — that would
 *  hide scoring bugs and let the review model "buy" a pass by returning -1). */
function clampScore(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < MIN_SCORE || rounded > MAX_SCORE) return fallback
  return rounded
}

/** Flatten a message content block list into plain text. */
function concatTextBlocks(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/** Zod schema mirroring `resolveConfig`; published for tooling. Schemastery
 *  treats every field as optional unless `required()` is called, which
 *  matches the "all defaults are valid" contract of `resolveConfig`. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  maxChallenges: z.number().default(5),
  maxReviewTokens: z.number().default(512),
  timeoutMs: z.number().default(60_000),
  threshold: z.number().default(80),
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
