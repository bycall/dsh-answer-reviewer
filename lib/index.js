// dsh-answer-reviewer — answer-reviewer entry point.
//
// Plugins in the dsh bundle family conform to a tiny shape: `name` declares
// their cordis identifier (matched against the entry id in the bundle's
// patch file), `inject` lists any services required before apply() runs,
// and `apply(ctx, config)` is the single entry the loader invokes after
// construction. From there the plugin owns its own service registration,
// effect schedules, and event subscriptions — the host does not poll for
// them.
//
// What this plugin does:
//   * subscribes to `agent/turn-stopping` (fires once per turn, just
//     before the turn boundary is committed)
//   * reads the assistant's final output from the session snapshot
//   * routes the assistant message to a dedicated review model via
//     `ctx.llm.stream(options)` with `BlockAssembler`
//   * on `verdict: pass`, lets the turn close
//   * on `verdict: fail`, calls `agent.steer({ kind: 'user', ... })` to
//     put a concrete fix-request back into the inbox so the machine
//     runs another step (the official hook the host exposes for
//     review-style reinjection of the same turn)
//   * caps retries per (session, turn) with a small LRU counter so the
//     loop can't overshoot
//
// Defensive defaults:
//   * subagent turns are skipped — their output is intermediate
//   * a throwing or aborted review returns control to the host (fail-open)
//   * the challenge counter evicts the oldest entry when full

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import {
  buildReviewPrompt,
  buildSteerMessage,
  createChallengeCounter,
  extractAssistantText,
  extractUserPrompts,
  isScoreAcceptable,
  parseScore,
  resolveConfig,
} from './review.js'

/** Identifier matched against the cordis entry options; exports for tooling. */
export const name = 'dsh-answer-reviewer'

/** Cordis services the plugin touches. `llm` is needed for the review-model
 *  stream call. Other `agent.*` references in the codebase come from the
 *  `agent/turn-stopping` payload, not from ctx. */
export const inject = ['llm']

export { Config, resolveConfig, extractAssistantText, extractUserPrompts, parseScore, buildSteerMessage, buildReviewPrompt, isScoreAcceptable, createChallengeCounter } from './review.js'

/**
 * Mount the plugin onto a host cordis context.
 * @param ctx - cordis context provided by the loader.
 * @param rawConfig - untrusted configuration from the cordis entry.
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new Error('dsh-answer-reviewer: cordis context is required')
  }
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    ctx.logger?.('dsh-answer-reviewer: invalid config, plugin disabled')?.(error)
    return
  }
  if (!config.enabled) {
    ctx.logger?.info?.('dsh-answer-reviewer: disabled by config')
    return
  }
  const counter = createChallengeCounter()
  ctx.on('agent/turn-stopping', async (payload) => {
    await onTurnStopping(ctx, config, counter, payload).catch((error) => {
      ctx.logger?.warn?.(`dsh-answer-reviewer: review crashed, allowing turn to close: ${String(error)}`)
    })
  })
  ctx.logger?.info?.(`dsh-answer-reviewer: mounted (threshold=${config.threshold}, maxChallenges=${config.maxChallenges})`)
}

/**
 * Review-and-steer pipeline for one turn boundary. Pulled out so the unit
 * test can call it with a mocked ctx and observer.
 * @param ctx - cordis context (or a mock for tests).
 * @param config - resolved plugin configuration.
 * @param counter - per-(session,turn) challenge counter.
 * @param payload - `agent/turn-stopping` payload from the host.
 */
export async function onTurnStopping(ctx, config, counter, payload) {
  if (!payload) return
  const { agent, turn, signal } = payload
  if (!agent) return
  if (signal && typeof signal.throwIfAborted === 'function' && signal.aborted) return

  // Skip subagents: their output is intermediate, not user-facing.
  const header = agent.session?.header
  if (header && header.origin === 'subagent') return

  const session = agent.session
  if (!session) return
  const sessionId = session.id ?? 'unknown-session'

  // Hard cap: after `maxChallenges` rounds the plugin gives up for this
  // turn and lets whatever the agent has through. Not the same as the
  // quality threshold (which is the real gate), just a leak guard.
  const used = counter.get(sessionId, turn)
  if (used >= config.maxChallenges) return

  // Pull both the assistant text for THIS turn and the full set of user
  // prompts so the review model can grade against every instruction the
  // user has issued, not just the most recent one.
  const events = readEvents(session)
  if (!events) return
  const assistantText = extractAssistantText(events, turn)
  if (assistantText === null || assistantText.length === 0) return
  const userPrompts = extractUserPrompts(events) ?? ''

  // Ask the review model.
  const route = resolveReviewRoute(ctx, config, agent)
  if (!route) {
    ctx.logger?.warn?.('dsh-answer-reviewer: no review route available, allowing turn to close')
    return
  }
  const prompt = buildReviewPrompt({ userPrompts, assistantText, threshold: config.threshold })
  const deadline = makeDeadline(signal, config.timeoutMs)
  let rawReply
  try {
    rawReply = await streamToText(ctx, route, sessionId, prompt, config.maxReviewTokens, deadline.signal)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-answer-reviewer: review call failed, allowing turn to close: ${String(error)}`)
    return
  }
  if (deadline.signal.aborted) return

  const score = parseScore(rawReply)
  if (!score) {
    ctx.logger?.warn?.('dsh-answer-reviewer: review reply was not parseable, allowing turn to close')
    return
  }
  if (isScoreAcceptable(score, config.threshold)) return
  if (signal && signal.aborted) return

  // Below threshold: bump the per-(session, turn) counter and steer the
  // agent back into the same turn with concrete feedback.
  const newCount = counter.bump(sessionId, turn)
  const message = buildSteerMessage({
    score: score.score,
    reason: score.reason,
    attempt: newCount,
    maxAttempts: config.maxChallenges,
  })
  try {
    agent.steer(message)
    ctx.logger?.info?.(`dsh-answer-reviewer: steered session=${sessionId} turn=${turn} score=${score.score}/${config.threshold} (retry ${newCount}/${config.maxChallenges})`)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-answer-reviewer: steer failed: ${String(error)}`)
  }
}

/**
 * Resolve the dedicated review route. Explicit config wins; otherwise fall
 * back to the current agent's route so the plugin works out of the box.
 * @returns frozen `{ provider, model }` or `null` when no route is available.
 */
function resolveReviewRoute(ctx, config, agent) {
  if (config.reviewProvider && config.reviewModel) {
    return Object.freeze({ provider: config.reviewProvider, model: config.reviewModel })
  }
  const options = agent && agent.options
  if (!options || typeof options.provider !== 'string' || typeof options.model !== 'string') {
    return null
  }
  return Object.freeze({ provider: options.provider, model: options.model })
}

/**
 * Drain `ctx.llm.stream()` into a single text reply string. Defensive against
 * stream payloads that contain only non-text blocks (returns empty string in
 * that case; the verdict parser will reject it and the turn will close).
 */
async function streamToText(ctx, route, sessionId, prompt, maxTokens, abortSignal) {
  const options = {
    provider: route.provider,
    model: route.model,
    messages: prompt.messages,
    system: prompt.system,
    maxTokens,
    sessionId,
    purpose: 'answer-review',
    signal: abortSignal,
  }
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
    throw new Error('ctx.llm.stream is not available')
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    if (abortSignal && abortSignal.aborted) break
    assembler.push(chunk)
  }
  if (assembler.finish && (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted')) {
    throw new Error(assembler.finish.failure?.message ?? 'review stream failed')
  }
  const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** Read events via the modern API and fall back to legacy `session.events`. */
function readEvents(session) {
  if (typeof session.snapshotEvents === 'function') {
    try {
      const out = session.snapshotEvents()
      if (Array.isArray(out)) return out
    } catch { /* fall through to legacy */ }
  }
  if (Array.isArray(session.events)) return session.events
  return null
}

/**
 * Build a deadline helper that ties the review call to either the caller's
 * `signal` (when present) or a fresh controller. Returns `{ signal, cancel }`.
 */
function makeDeadline(externalSignal, timeoutMs) {
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    // Use AbortSignal.timeout when available; the host signal will also abort us.
    const controller = new AbortController()
    const onAbort = () => controller.abort(externalSignal.reason)
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('review timeout')), timeoutMs)
    return {
      signal: controller.signal,
      cancel() {
        clearTimeout(timer)
        externalSignal.removeEventListener('abort', onAbort)
      },
    }
  }
  return {
    signal: AbortSignal.timeout(timeoutMs),
    cancel() { /* nothing to cancel */ },
  }
}
