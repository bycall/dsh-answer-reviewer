# Changelog

All notable changes to `dsh-answer-reviewer` are documented here. The plugin
follows [Semantic Versioning](https://semver.org/); every release bumps
both `package.json#version` and this file in the same commit.

## 0.4.0 — 2026-09-08

### Added
- **Live config via a self-hosted HTTP server on `http://127.0.0.1:3987`.**
  Tune the gate, switch the reviewer on/off, set the max-challenges cap,
  etc. from a browser form without restarting the host. The same JSON
  API is reachable from `curl` for automation.
- **ConfigStore (new `lib/config-store.js`)** — persistent, hot-reloadable
  config layer. Reads on startup, validates partials through the same
  `resolveConfig` path mount uses (no shape drift), persists overrides
  atomically to `~/.dsh/answer-reviewer.json` (or `REVIEWER_CONFIG_PATH`).
  Reset via `DELETE /api/config` removes the file so a missing file =
  defaults.
- **Review activity ring buffer (50 entries).** The config UI surfaces the
  last 15 review outcomes (pass / steer / parse-fail / cap-exhausted /
  no-text / no-route / review-error) so you can see what the gate did
  without grepping the host log.
- **HTTP routes**
  - `GET /` — HTML form + recent activity table
  - `GET /api/health` — `{ ok, at }`
  - `GET /api/config` — `{ config, overrides, source, path }`
  - `POST /api/config` — body: partial JSON; 200 on success, 400 on validation
  - `DELETE /api/config` — wipe overrides; file is removed
  - `GET /api/recent` — newest-first ring dump
- **Env vars** — `REVIEWER_HTTP=0` disables the server; `REVIEWER_HTTP_PORT`
  overrides the bind port; `REVIEWER_CONFIG_PATH` overrides the on-disk
  file path.

### Changed
- `onTurnStopping(ctx, store, counter, payload)` — the second arg is now a
  ConfigStore (was: a frozen Config). `store.get()` is the source of
  truth for the live config so a hot-reload between turns takes effect on
  the next turn with no restart.
- `lib/internal.js` is the new internal barrel so `lib/index.js` and tests
  both import from one place.

### Internal
- New files: `lib/config-store.js`, `lib/server.js`, `lib/internal.js`.
- Smoke test extended from 27 to 39 cases; the new ones cover load /
  update / reset / subscribe / activity / default-path / all 5 HTTP
  routes (including bad JSON and mismatched provider/model).

## 0.3.0 — 2026-09-07

### Breaking
- **`threshold` is the gate, `maxChallenges` is a leak guard.** Previously
  the plugin behaved as "ask the reviewer at most N times, let the turn
  close on any verdict". It is now "ask once per turn attempt; steer while
  the score is below `threshold`; stop steering after `maxChallenges` even
  if the score is still low". The defaults change too: `threshold` defaults
  to `80` and `maxChallenges` to `5` (was `3`). Migration: existing
  configs that set `maxChallenges: 3` continue to work — the cap is still
  enforced, just no longer conflated with the verdict.

### Added
- `extractUserPrompts(session, turn)` — walks the session's `user/message`
  events and concatenates every one whose `source.kind` is not `'plugin'`.
  Plugin-injected context (file-change notices, AGENTS.md, skill content,
  system reminders) is dropped so the reviewer scores against what the
  user actually asked. The result is tagged `<all_user_prompts>` in
  `buildReviewPrompt`.
- `parseScore(raw)` (replaces `parseVerdict`) — reads
  `{ "score": <int 1..100>, "reason": <string> }`. Returns a frozen
  `{ score, reason }` object. **Out-of-band scores are REJECTED, not
  clamped**: a reviewer that returns `-1`, `9999`, `"1.5"`, or
  `"ninety-eight"` is treated as a parse failure, not a free pass.
- `isScoreAcceptable(score, threshold)` — the inclusive gate predicate.
- `buildReviewPrompt` now embeds `<all_user_prompts>` and an explicit
  "user constraints trump completeness" rule (see below).
- `CONFIGURE.md` — detailed configuration guide covering the
  default-vs-independent model question, threshold tuning, and the
  fail-closed/fail-open matrix.

### Changed
- `parseVerdict` → `parseScore`. **The reviewer prompt asks for an
  integer 1-100 plus a single reason, not a `verdict/reasons` pair.**
  Hosts pinned to a review model that cannot follow JSON-only output
  should set `maxReviewTokens` higher (and pre-test the reviewer prompt
  with a smoke run).
- `buildSteerMessage` takes `{score, reason, attempt, maxAttempts}` and
  phrases the re-injection around "scored X/100, below the gate", so
  the agent knows the score is the gate it failed, not a vague failure.
- `resolveConfig` rejects out-of-range `threshold` values and falls
  back to the default. A mis-set config no longer quietly moves the gate
  from 80 to 100 behind the user's back.
- `maxChallenges` is hard-capped at `8` (was implicit-unbounded). Past
  that the config value silently falls back to the cap, not the default.

### Fixed
- **Reviewer no longer punishes explicitly-brief answers.** Without the
  fix, asking the agent for a short reply (e.g. "只回复OK两个字") led to
  the reviewer scoring 40 ("reply is too thin") and steering the agent
  into more prose. The prompt now states, as a CRITICAL rule, that
  "satisfying an explicit user constraint IS the requirement" with a
  worked example. End-to-end: "只回复OK两个字符" now scores ≥ 80 and
  closes in one step (was 6 steps / 5 steers).

## 0.2.0 — 2026-09-03

### Added
- Subagent filtering: turns whose session header has `origin === 'subagent'`
  are skipped. Subagent output is intermediate, not user-facing.
- Abort-signal short-circuit: if the user pauses or cancels the turn, the
  review call is cancelled mid-flight and the turn is left alone.
- `createChallengeCounter` — per-(session, turn) counter that drives the
  `maxChallenges` cap. Frozen `{ get, bump, reset }` API.
- Smoke harness (`test/smoke.mjs`) covering parse, prompt, steer message,
  counter, and the fail-open/skip-subagent/cap-exhausted branches.
- `apply()` declares `inject: ['llm']` so the cordis loader guarantees
  `ctx.llm` is mounted before the review listener attaches.

### Changed
- `apply()` routes all diagnostics through `ctx.logger` instead of
  `console.log`/`console.error`, so the host's logging policy (level,
  redaction, sink) governs plugin output. Stderr stays clean.

## 0.1.0 — 2026-09-01

### Added
- Initial release.
- `lib/review.js`: `resolveConfig`, `extractAssistantText`, `buildReviewPrompt`,
  `parseVerdict`, `buildSteerMessage`, `createChallengeCounter`, public
  `Config` zod schema.
- `lib/index.js`: cordis `apply()` with `agent/turn-stopping` listener,
  LLM route resolver (`ctx.llm.stream` with `reviewProvider`/`reviewModel`
  fallback), `BlockAssembler`-shaped stream-to-text collection with
  abort-signal short-circuit and deadline, and `agent.steer(...)` injection.
- `cordis.patch.yml`: bundle entry.
- `README.md`: install, config, behaviour.