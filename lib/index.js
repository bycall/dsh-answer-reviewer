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
//   * publishes its config via a small 127.0.0.1 HTTP server (see
//     lib/server.js) so the user can tune the gate without restarting
//     the host; same JSON API is usable from `curl` for automation
//   * records every score against the durable id of the assistant message
//     it graded and serves them from the host's own origin
//     (`/api/dsh-answer-reviewer/reviews`), so the conversation UI can show
//     the score under the answer it belongs to; see the `webServer`
//     registration in apply()
//
// Defensive defaults:
//   * subagent turns are skipped — their output is intermediate
//   * a throwing or aborted review returns control to the host (fail-open)
//   * the challenge counter evicts the oldest entry when full
//   * the HTTP server binds 127.0.0.1 only; disable with REVIEWER_HTTP=0

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import {
  buildReviewPrompt,
  buildSteerMessage,
  createChallengeCounter,
  createReviewsHandler,
  defaultConfigPath,
  createConfigStore,
  DEFAULT_HTTP_PORT,
  extractAssistantText,
  extractUserPrompts,
  isScoreAcceptable,
  latestAssistantMessageId,
  parseScore,
  REVIEWS_ROUTE_PATH,
  resolveConfig,
  startServer,
} from './internal.js'

/** Identifier matched against the cordis entry options; exports for tooling. */
export const name = 'dsh-answer-reviewer'

/** Cordis services the plugin touches. `llm` is needed for the review-model
 *  stream call. Other `agent.*` references in the codebase come from the
 *  `agent/turn-stopping` payload, not from ctx. */
export const inject = ['llm']

export {
  Config,
  resolveConfig,
  extractAssistantText,
  extractUserPrompts,
  latestAssistantMessageId,
  parseScore,
  buildSteerMessage,
  buildReviewPrompt,
  isScoreAcceptable,
  createChallengeCounter,
  createConfigStore,
  defaultConfigPath,
  startServer,
  fmtLocalTime,
  DEFAULT_HTTP_PORT,
  REVIEWS_ROUTE_PATH,
  reviewsPayload,
  createReviewsHandler,
} from './internal.js'

/**
 * Mount the plugin onto a host cordis context.
 * @param ctx - cordis context provided by the loader.
 * @param rawConfig - untrusted configuration from the cordis entry.
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new Error('dsh-answer-reviewer: cordis context is required')
  }
  let initialConfig
  try {
    initialConfig = resolveConfig(rawConfig)
  } catch (error) {
    ctx.logger?.('dsh-answer-reviewer: invalid config, plugin disabled')?.(error)
    return
  }
  if (!initialConfig.enabled) {
    ctx.logger?.info?.('dsh-answer-reviewer: disabled by config')
    return
  }

  const configPath = defaultConfigPath()
  const store = createConfigStoreSync(initialConfig, configPath, ctx)
  const counter = createChallengeCounter()

  // Each turn reads the current effective config from the store. Edits
  // through the HTTP server / future settings UI flip `store.get()` and
  // the next turn picks them up without a restart.
  ctx.on('agent/turn-stopping', async (payload) => {
    await onTurnStopping(ctx, store, counter, payload).catch((error) => {
      ctx.logger?.warn?.(`dsh-answer-reviewer: review crashed, allowing turn to close: ${String(error)}`)
    })
  })

  // Local config server (also expose its lifecycle to the host so dispose
  // can close the socket cleanly). REVIEWER_HTTP=0 turns this off; the
  // ConfigStore itself stays active so the on-disk overrides still load.
  startServer(store, { logger: ctx.logger }).then((serverHandle) => {
    if (typeof ctx.on === 'function' && typeof ctx.once === 'function') {
      for (const evt of ['dispose', 'cordis/dispose', 'host/dispose']) {
        ctx.once(evt, () => { try { serverHandle?.close?.() } catch { /* ignore */ } })
      }
    }
  }).catch((error) => {
    ctx.logger?.warn?.(`dsh-answer-reviewer: config server failed to start: ${String(error)}`)
  })

  // Score feed for the conversation UI, on the HOST's own origin.
  //
  // The badge lives in the chat page, so it must read from that page's origin;
  // the 127.0.0.1:3987 sidecar above is a different origin and stays free of
  // any CORS relaxation. `webServer` is the composition's route carrier and
  // `connection` is its trust fence — `requestRejection` applies the same
  // Host/Origin + login-token gate the shipped routes use, so this route is
  // reachable by the authenticated dsh page and nothing else.
  //
  // Waited for lazily: a composition without either service (a non-web host)
  // loses only the badge, it does not stall or fail this plugin's activation.
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: REVIEWS_ROUTE_PATH,
      handler: createReviewsHandler(store, {
        reject(req, res) {
          const connection = Reflect.get(scope, 'connection')
          const rejection = connection?.requestRejection?.(req)
          if (rejection === undefined) return false
          res.statusCode = rejection
          res.end()
          return true
        },
      }),
    }), `dsh-answer-reviewer: GET ${REVIEWS_ROUTE_PATH}`)
  })

  ctx.logger?.info?.(
    `dsh-answer-reviewer: mounted (threshold=${initialConfig.threshold}, maxChallenges=${initialConfig.maxChallenges}, config=${configPath ?? '(in-memory only)'}, server=http://127.0.0.1:${DEFAULT_HTTP_PORT}, scores=${REVIEWS_ROUTE_PATH})`,
  )
}

/** Build a ConfigStore synchronously enough for the rest of apply() to
 *  proceed; the file read is awaited but the API is async-safe. Falls
 *  back to an in-memory store if no config path can be derived. */
function createConfigStoreSync(initialConfig, configPath, ctx) {
  // Wrap in a holder so the apply() function can keep a sync reference;
  // real consumers go through `get()` / `update()` which return promises.
  const ref = { current: null }
  if (!configPath) {
    // No home dir / no env override; stay in-memory and skip persistence.
    const stub = inMemoryStore(initialConfig, ctx)
    ref.current = stub
    return proxy(ref)
  }
  createConfigStore({
    defaults: initialConfig,
    filePath: configPath,
    logger: ctx.logger,
  }).then((store) => {
    ref.current = store
    // Eagerly load overrides from disk so the first turn already sees
    // the user's saved settings instead of running with defaults.
    store.load().catch((error) => {
      ctx.logger?.warn?.(`dsh-answer-reviewer: deferred load failed: ${String(error)}`)
    })
  }).catch((error) => {
    ctx.logger?.warn?.(`dsh-answer-reviewer: store init failed: ${String(error)}`)
    ref.current = inMemoryStore(initialConfig, ctx)
  })
  // Synchronous proxy returns the initial defaults until the real store
  // is ready (typically the same tick). After that all calls go to it.
  return proxy(ref)

  function proxy(r) {
    return {
      get() { return (r.current ?? { current: inMemoryStore(initialConfig, ctx) }).get() },
      // The "real" consumer (onTurnStopping + server) only calls these:
      subscribe: (fn) => { r.current?.subscribe?.(fn); return () => {} },
      recordActivity: (entry) => r.current?.recordActivity?.(entry),
      getRecent: () => r.current?.getRecent?.() ?? [],
      recordReview: (entry) => r.current?.recordReview?.(entry),
      getReviews: () => r.current?.getReviews?.() ?? [],
      update: (p) => r.current?.update?.(p),
      reset: () => r.current?.reset?.(),
      getOverrides: () => r.current?.getOverrides?.() ?? {},
      getPath: () => r.current?.getPath?.() ?? configPath,
      getSource: () => r.current?.getSource?.() ?? 'defaults',
    }
  }
}

function inMemoryStore(initialConfig, ctx) {
  // Minimal shim: same shape, no persistence. Used only when we cannot
  // derive a config path. The real store always wins when available.
  let current = initialConfig
  const subs = new Set()
  const activity = []
  const reviews = new Map()
  const reviewOrder = []
  return {
    get: () => current,
    update: async (partial) => {
      const merged = { ...current, ...partial }
      try { current = resolveConfig(merged) } catch (error) { return { error: String(error) } }
      for (const fn of subs) try { fn(current) } catch {}
      return { config: current }
    },
    reset: async () => { current = initialConfig; for (const fn of subs) try { fn(current) } catch {}; return { config: current } },
    getOverrides: () => ({}),
    getPath: () => '(in-memory)',
    getSource: () => 'defaults',
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
    recordActivity: (e) => { if (e && typeof e === 'object') { activity.push({ ...e, at: e.at ?? new Date().toISOString() }); if (activity.length > 50) activity.shift() } },
    getRecent: () => activity.slice(),
    recordReview: (e) => {
      if (!e || typeof e !== 'object') return
      if (typeof e.messageId !== 'string' || e.messageId.length === 0) return
      if (typeof e.score !== 'number') return
      if (!reviews.has(e.messageId)) reviewOrder.push(e.messageId)
      reviews.set(e.messageId, { ...e, at: e.at ?? new Date().toISOString() })
      while (reviewOrder.length > 200) reviews.delete(reviewOrder.shift())
    },
    getReviews: () => reviewOrder.slice().reverse().map((id) => reviews.get(id)).filter((e) => e !== undefined),
  }
}

/**
 * Review-and-steer pipeline for one turn boundary. Pulled out so the unit
 * test can call it with a mocked ctx and observer.
 * @param ctx - cordis context (or a mock for tests).
 * @param store - ConfigStore (or a mock for tests); `store.get()` is the
 *                source of truth for the live config.
 * @param counter - per-(session,turn) challenge counter.
 * @param payload - `agent/turn-stopping` payload from the host.
 */
export async function onTurnStopping(ctx, store, counter, payload) {
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

  // Pull the live config (a hot-reload may have happened since the last turn).
  const config = store.get()
  if (!config.enabled) {
    store.recordActivity({ sessionId, turn, decision: 'disabled' })
    return
  }

  // Hard cap: after `maxChallenges` steers the plugin stops challenging this
  // turn and lets whatever the agent has through. Not the same as the quality
  // threshold (which is the real gate), just a leak guard.
  //
  // The cap suppresses STEERING only — never the review. A turn's final answer
  // is the only one the conversation binds an action row to, so skipping its
  // review would leave the answer the user actually reads as the one answer
  // with no score.
  const used = counter.get(sessionId, turn)
  const capReached = used >= config.maxChallenges

  // Pull both the assistant text for THIS turn and the full set of user
  // prompts so the review model can grade against every instruction the
  // user has issued, not just the most recent one.
  const events = readEvents(session)
  if (!events) {
    store.recordActivity({ sessionId, turn, decision: 'no-events' })
    return
  }
  const assistantText = extractAssistantText(events, turn)
  if (assistantText === null || assistantText.length === 0) {
    store.recordActivity({ sessionId, turn, decision: 'no-text' })
    return
  }
  const userPrompts = extractUserPrompts(events) ?? ''

  // The durable id of the answer being graded. Same identity the shell hands
  // to `conversation.chat.assistant-actions`, so the score the UI shows and the
  // score this plugin gates on can never drift apart. Null when the turn has no
  // addressable message: the review still runs, it just is not publishable.
  const messageId = latestAssistantMessageId(events, turn)

  // Ask the review model.
  const route = resolveReviewRoute(ctx, config, agent)
  if (!route) {
    ctx.logger?.warn?.('dsh-answer-reviewer: no review route available, allowing turn to close')
    store.recordActivity({ sessionId, turn, decision: 'no-route' })
    return
  }
  const prompt = buildReviewPrompt({ userPrompts, assistantText, threshold: config.threshold })
  const deadline = makeDeadline(signal, config.timeoutMs)
  let rawReply
  try {
    rawReply = await streamToText(ctx, route, sessionId, prompt, config.maxReviewTokens, deadline.signal)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-answer-reviewer: review call failed, allowing turn to close: ${String(error)}`)
    store.recordActivity({ sessionId, turn, decision: 'review-error', reason: String(error).slice(0, 200) })
    return
  }
  if (deadline.signal.aborted) return

  const score = parseScore(rawReply, config.threshold)
  if (!score) {
    ctx.logger?.warn?.('dsh-answer-reviewer: review reply was not parseable, allowing turn to close')
    const snippet = typeof rawReply === 'string' ? rawReply.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    store.recordActivity({ sessionId, turn, decision: 'parse-fail', reason: snippet || undefined })
    return
  }
  if (isScoreAcceptable(score, config.threshold)) {
    store.recordActivity({ sessionId, turn, decision: 'pass', score: score.score, reason: score.reason })
    store.recordReview({
      messageId,
      sessionId,
      turn,
      decision: 'pass',
      score: score.score,
      threshold: config.threshold,
      attempt: used + 1,
      reason: score.reason,
    })
    return
  }
  if (signal && signal.aborted) return

  // Below threshold but out of challenges: publish the final answer's score and
  // stop. `capped` marks it as "the gate was failed and no retry was left",
  // which is what the chip tooltip tells the user.
  if (capReached) {
    ctx.logger?.info?.(`dsh-answer-reviewer: capped session=${sessionId} turn=${turn} score=${score.score}/${config.threshold} (no retries left)`)
    store.recordActivity({ sessionId, turn, decision: 'cap-exhausted', score: score.score, reason: score.reason })
    store.recordReview({
      messageId,
      sessionId,
      turn,
      decision: 'capped',
      score: score.score,
      threshold: config.threshold,
      attempt: used + 1,
      reason: score.reason,
    })
    return
  }

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
    store.recordActivity({ sessionId, turn, decision: 'steer', score: score.score, reason: score.reason })
    store.recordReview({
      messageId,
      sessionId,
      turn,
      decision: 'steer',
      score: score.score,
      threshold: config.threshold,
      attempt: used + 1,
      reason: score.reason,
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-answer-reviewer: steer failed: ${String(error)}`)
    store.recordActivity({ sessionId, turn, decision: 'steer-fail', score: score.score, reason: score.reason })
    store.recordReview({
      messageId,
      sessionId,
      turn,
      decision: 'steer-fail',
      score: score.score,
      threshold: config.threshold,
      attempt: used + 1,
      reason: score.reason,
    })
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
