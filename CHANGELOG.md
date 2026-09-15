# Changelog

All notable changes to `dsh-answer-reviewer` are documented here. The plugin
follows [Semantic Versioning](https://semver.org/); every release bumps
both `package.json#version` and this file in the same commit.

## 0.7.2 — 2026-09-15

### Changed
- **Host contract widened to DeepSeek Harness 0.1.6-alpha.1.** The two host
  packages this plugin imports at runtime — `@deepseek-ai/dsh-llm` and
  `@deepseek-ai/dsh-session` — now accept `^0.1.6-alpha.1` alongside the
  previously supported lines.

  The range has to *name* the new line rather than widen to something like
  `>=0.1.5-rc.1`: npm evaluates the prerelease rule per comparator set, so a
  prerelease version only satisfies a set when some comparator in it shares the
  version's `[major, minor, patch]` tuple. `0.1.6-alpha.1` shares a tuple with
  none of the earlier comparators, so without an explicit `^0.1.6-alpha.1`
  alternative the plugin is reported incompatible with the current host.

- **No code change was needed for 0.1.6.** The one hook 0.1.6 removed,
  `agent/session-start`, was never used here; the plugin hooks `onTurnStopping`
  and the LLM seam only.

  `Session.snapshotEvents()` — read at `lib/index.js` — is deprecated as of
  0.1.6 (see the *deprecate-synchronous-session-event-reads* Agent Note), but
  the deprecation explicitly tolerates existing callers
  (*"Existing logic may remain unmigrated for now, but new calls are
  prohibited"*), and the read was already written as `typeof
  session.snapshotEvents === 'function'` with a `session.events` fallback, so it
  degrades to no-transcript rather than throwing if the method is ever dropped.
  Migrating to the async read path is tracked as a follow-up, not a 0.1.6
  requirement.

### Fixed
- **`@deepseek-ai/schemastery` is now declared.** `lib/review.js` imports it for
  the `z.object({...})` config schema that backs the live gate settings, but the
  specifier appeared in no dependency field. It resolved only because the host's
  module fallback symlinks every `@deepseek-ai/*` package it owns into each
  plugin's own `node_modules` — that is the host being generous, not a contract
  the plugin had subscribed to. The peer is now declared at `^3.18.1`, the same
  upstream line `dsh-builtin-browser` declares.

## 0.7.1 — 2026-09-11

### Fixed
- **The turn's final answer is now scored even when the retry cap is spent.**
  `onTurnStopping` used to `return` early once `maxChallenges` was reached,
  which skipped the review entirely. But a turn's final answer is the *only*
  one `conversation.chat.assistant-actions` binds to — the intermediate answers
  produced by steering are never the `closing.finalNode` the shell renders. So
  a turn that exhausted its retries ended with the answer the user actually
  reads being the one answer with no score, and the chip silently never
  appeared.

  The cap now suppresses **steering only**. A below-threshold answer at the cap
  is still reviewed and published, recorded with `decision: "capped"` so the
  tooltip can say *"未达标，重试次数已用尽"* instead of claiming a retry that
  never happened. The activity ring still logs `cap-exhausted`.

  Observed live: a turn that produced four answers (`024cdb59`, `80497c7c`,
  `9221c72e`, `ee8cf4e9`) recorded scores only for the first three, and the
  transcript — which shows only `ee8cf4e9` — showed no chip at all.

## 0.7.0 — 2026-09-11

### Added
- **The review score is now shown in the conversation.** Every finalized
  assistant message gets a score chip in its action row, beside the shipped
  copy/retry and Like/Dislike buttons: a tinted pill reading `评分 92`, with a
  state-coloured dot, and a tooltip carrying the gate, the verdict and the
  reviewer's own reason.

  The chip registers into `conversation.chat.assistant-actions` — the shell's
  `list` slot documented as *"Ordered actions for one finalized assistant
  message"*, `replaceRisk: "none"`, so it sits beside the shipped entries
  rather than shadowing them. Registration is
  `{ name, id: "answer-reviewer:score", order: 100 }`; the shipped feedback
  entry keeps the default order, so the score lands to its right.

  It renders **nothing** until a score exists for that exact message, so an
  install where the reviewer never runs (disabled plugin, no review route,
  unparseable reply, exhausted retry cap) looks byte-identical to stock dsh.

- **A same-origin score feed on the host webserver.**
  `GET /api/dsh-answer-reviewer/reviews` (`REVIEWS_ROUTE_PATH`) returns
  `{ entries, at }`, newest first. It is registered through
  `ctx.webServer.register({ kind: 'exact', path, handler })` — the same idiom
  `dsh-host-open-in-app` uses — so it lives on the page's own origin and is
  guarded by the composition's `connection.requestRejection` fence (Host and
  Origin check plus the login-token cookie). Registered through a lazy
  `ctx.inject(['webServer', 'connection'])`, so a non-web host loses only the
  chip and does not stall the plugin's activation.

  This deliberately avoids relaxing CORS on the `127.0.0.1:3987` sidecar: a
  page on the host origin cannot read a different port without an
  `Access-Control-Allow-Origin` the sidecar does not grant, and granting one
  would let any site the user visits read and rewrite their reviewer config.
  The sidecar still serves the same payload at `/api/reviews` for `curl`.

- **Scores are recorded per assistant message.** `ConfigStore.recordReview`
  keeps a message-id-keyed ring (200 entries) alongside the existing activity
  ring (50), because the UI looks a score up on scroll-back for every visible
  completed turn. `reviewsPayload` shapes the wire form and strips
  `sessionId`, which is diagnostics-only.

### Changed
- **`onTurnStopping` now also records the durable id of the answer it graded.**
  `latestAssistantMessageId(events, turn)` reads `assistant/message` →
  `data.message.id`, which is exactly the identity ui-chat hands to
  `conversation.chat.assistant-actions`
  (`messageId: close.finalNode.messageId`). Recording under that same key is
  what stops the displayed score and the gating score from drifting apart. The
  record also carries the threshold in force at review time, so a later
  threshold edit cannot retroactively recolour old chips, and the attempt
  number, so a retried turn can say `评分 61 · 第2次`.

### Notes
- Test count 53 → 59. New coverage: `latestAssistantMessageId` turn
  selection (including skipping interrupted and id-less messages), the
  message-keyed ring and its eviction, `reviewsPayload` shaping and trimming,
  `createReviewsHandler` (GET/405, the refusal short-circuit, an abstaining
  fence), the chip's label/band/tooltip and its deliberate silence, and an
  `onTurnStopping` integration test proving the score lands under the answer
  it graded — including that a retry's new answer id does not overwrite the
  failed one, and that an id-less answer is still gated but publishes nothing.
- The client bundle exposes `exports.__test` (`setScores`, `scoreBand`,
  `scoreLabel`, `scoreTooltip`). The score feed is module-private state with no
  cordis service to reach through, so the harness needs a seam.
- The chip's colours come from dsh's own `--dsw-alias-state-success-*` and
  `--dsw-alias-state-warn-*` tokens, so both themes resolve with no local
  palette.

## 0.6.1 — 2026-09-11

### Fixed
- **The dock is no longer crushed to a ~10px sliver.** `conversation.input.dock`
  entries are rendered as *direct flex children of dsh's fixed-height
  `.composerStack`*. With the default `flex-shrink: 1` the strip was squeezed
  until only a few pixels remained, and its own `overflow: hidden` then clipped
  the label — the row rendered as an unreadable broken sliver. The root now
  sets `flex: none`, exactly like dsh's own `QueueDock`.
- **The dock no longer stretches across the whole conversation column.** It now
  repeats dsh's own width formula
  (`width: calc(100% - 2*clearance - 2*inset)` +
  `max-width: calc(card-max - 2*inset)` + `margin: 0 auto calc(0 - gap - 3px)`),
  read off `QueueDock.module.css`, so it lines up with the composer card.

### Changed
- **Restyled to match dsh's native dock entries.** The strip is now a single
  32px button row (sliders glyph + 13px/500 label + rotating caret) on the
  native `--dsw-specific-tip` panel with a `12px 12px 0 0` radius and a
  `--dsw-alias-border-l1` hairline on three sides, so it reads as part of the
  composer's chrome instead of a floating widget. The previous bordered
  "展开" pill is gone.
- **Opening the dock no longer reflows the transcript.** The config panel is
  now an absolutely positioned overlay anchored at `bottom: 100%` of the strip
  (with `z-index: 30`, a 12px radius and a soft shadow) instead of an inline
  block. The old inline panel grew inside the fixed composer column, shoving
  the composer down and reflowing every message.
- **Smaller footprint when open.** The overlay is capped at
  `min(38vh, 340px)` (previously `min(56vh, 440px)`), and the collapsed strip
  hides the address and the `新标签` deep link, which now only appear while the
  panel is open.

### Notes
- Test count 51 → 53. The two new tests are regression guards for exactly the
  two defects above: `dock geometry cannot be crushed by the composer column`
  asserts `flex: none` plus the composer-aligned width/max-width, and
  `expanded dock overlays instead of reflowing the transcript` asserts there
  is exactly one absolutely positioned panel, anchored at `bottom: 100%` with
  a viewport-capped height, containing the iframe.
- The two dock tests now aggregate text with a `textOf()` helper instead of
  asserting on `button.children === '展开'`, because the whole strip is one
  button and the disclosure affordance is the caret rather than a text label.
  They assert `aria-expanded` and the open-only address/deep-link instead.

## 0.6.0 — 2026-09-11

### Added
- **A config dock on the conversation page.** The bundle now registers into
  the shell's `conversation.input.dock` slot: a collapsed strip above the
  composer that expands into the same config iframe the sidebar tab and the
  standalone server already use. Collapsed by default, and collapsing
  *unmounts* the iframe so a closed dock never runs the page's poll timers.
  The expanded/collapsed choice is remembered in `localStorage`.

  This is the **primary** mount because it needs nothing beyond the core
  `slots` client service, so it works on every install — the sidebar tab
  remains an optional add-on for people who prefer the sidebar, and the
  standalone `127.0.0.1:3987` page is unchanged.

  When the expanded dock cannot reach the config server (e.g.
  `REVIEWER_HTTP=0`) it swaps the frame for an actionable hint instead of
  leaving a blank box.

### Changed
- The sidebar tab and the dock now share one `ConfigFrame` helper, so both
  mounts embed byte-identical URLs and cannot drift apart.

### Fixed
- **`test/smoke.mjs` no longer hardcodes the managed Node runtime path.**
  It pinned the peer-resolution root at
  `.../node/versions/22.22.2-2/...`, which stopped existing when the
  WorkBuddy runtime was swapped to `22.22.2-3` on 2026-09-11 — the harness
  then failed to locate `cordis` / `dsh-llm` / `dsh-session` / `schemastery`
  and could not run at all. The root is now discovered from
  `versions/current`, a sweep of `versions/*`, the profile's `dsh-tools`
  symlink target, and finally the profile's own `node_modules`.

### Notes
- Registration uses `{ name, id, priority }`. Two non-obvious facts about
  the slot registry, both read off the shipped shell bundle:
  `kind: "list"` slots **throw** without `options.id`
  (`list slot "<name>" requires options.id`), and list ordering sorts by
  `(options.priority ?? 0)` first and `(options.order ?? 0)` only as a
  tie-break — so `priority` is the primary key and `order` is still a
  usable secondary one (dsh's own dock entries use `order: 0` / `order: 20`).
- `locale` is not validated by the registry and is deliberately omitted, so
  the dock adds no i18n surface; its few labels stay hardcoded Chinese.
- Test count 48 → 51. New coverage: both mounts registered through the lazy
  path, the dock descriptor shape (`id` / `priority`), collapsed mounts no
  iframe, expanded mounts exactly one, dock and tab embed the same URL, and
  the client's duplicated port literal stays in sync with
  `DEFAULT_HTTP_PORT`.

## 0.5.3 — 2026-09-10

### Fixed
- **A host without dsh-better-sidebar no longer shows a "Failed to load
  plugins" banner.** The client entry declared `exports.inject =
  ["betterSidebar"]`, a *hard* service dependency. `dsh-better-sidebar` is
  an optional add-on (the actual reviewing is host-side, and the config page
  is also served standalone on 127.0.0.1:3987), so on any host where its
  service was absent the entry stayed `pending (waiting for service:
  betterSidebar)` forever. The web boot audit reports every pending entry —
  `web boot: 1 entry did not activate` — and the shell renders that as a
  "Failed to load plugins" notice across the whole main page, blaming a
  plugin that was merely missing its optional companion.

  The tab is now registered lazily through `ctx.inject(["betterSidebar"],
  scope => ...)` — the same idiom the official client bundles use for
  late-arriving services. The entry activates unconditionally; when
  better-sidebar is present the tab appears exactly as before, and when it
  is absent nothing is registered and nothing breaks.

### Changed
- `package.json#dsh.client.inject` is now `[]` (was `["betterSidebar"]`).
  That field carries **package-row** names — every official bundle lists
  packages such as `@deepseek-ai/dsh-client-ui-conversation` — while
  `betterSidebar` is a Cordis *service*. The bundle needs no dynamic package
  rows at all: `react` / `react-dom` are static seed words in the shell's
  module table.

### Notes
- Test count 46 → 48. The old `inject=["betterSidebar"]` assertion is
  replaced by three: no hard inject, `apply()` reaches the lazy path and
  stays silent when the service never arrives, and `dsh.client.inject` lists
  no service name.

## 0.5.2 — 2026-09-09

### Added
- **The recent-activity list now refreshes itself.** The "最近 15 条审查
  活动" table polls `/api/recent` every 3 seconds and swaps only the table
  DOM — no more manual 「重新加载」 clicks, and unsaved config edits in the
  form above are never disturbed (a full `location.reload()` used to be
  required to see a new review). The poll fires immediately again when the
  tab/iframe regains visibility or the window refocuses, and a short fade
  animation highlights newly landed rows.
- The table is rendered client-side now; session ids are shown as the first
  8 chars of the uuid tail (e.g. `b6d12535`) instead of the ambiguous
  `session-` prefix.

### Notes
- Test count 45 → 46: a `GET /` page test asserting the poller, the client
  row renderer, and its local-time formatter are present.

## 0.5.1 — 2026-09-08

### Fixed
- **Activity timestamps rendered 8 hours behind on GMT+8 hosts.** Times are
  stored in UTC (`new Date().toISOString()`), but the "最近 15 条审查活动"
  table sliced the raw ISO string (`slice(11, 19)`) and showed the UTC
  wall-clock. Introduced `fmtLocalTime()` — the table now renders the
  host's local timezone (`HH:MM:SS`), e.g. a `12:26:19Z` event shows as
  `20:26:19` in GMT+8.
- **Clean passes were misrecorded as `parse-fail`.** `parseScore` rejected
  any reply with an empty `reason`, but the review prompt explicitly lets
  the model leave `reason` empty when the score clears the threshold — so
  a pass on a good answer was classified as `parse-fail` (score `—`). The
  parser is now threshold-aware: an empty reason is accepted when
  `score >= threshold` (pass needs no feedback) and still fails closed
  below the gate, where concrete feedback is mandatory. `parseScore` keeps
  its strict contract when no threshold is passed.
- **`parse-fail` rows now carry a diagnostic snippet.** The recorded entry
  includes the first 120 chars of the unparseable reply, so future
  parse failures are debuggable from the activity table instead of being
  an opaque `—`.

### Notes
- Test count 41 → 45: empty-reason pass/reject/no-threshold cases, a local
  time formatting regression guard, and the "does not steer on pass" case
  now also asserts the activity is a real `pass` (it previously passed for
  the wrong reason — the reply was being rejected, not accepted).

## 0.5.0 — 2026-09-08

### Added
- **Native right-sidebar tab in dsh-better-sidebar.** The config panel is
  now exposed as a host-native side card under the title "Reviewer
  配置" — click the sidebar's `+` menu, pick the entry, and the form
  mounts in the right column next to Files / Terminal / Browser.
- **`lib/client.js`** — new client bundle. Uses the standard
  `window.__ModuleLoader__.load({ id, factory })` contract. The
  component is a small header strip plus a flex iframe pointing at the
  same `http://127.0.0.1:3987/` endpoint the standalone server
  serves — no second source of truth, no React form logic. When the
  tab is not active the iframe unmounts (live views pause).
- **`dsh.client` declaration in `package.json`** — `inject: ['betterSidebar']`
  so the host guarantees `ctx.betterSidebar` is live when our `apply`
  runs.
- **Smoke coverage for the client bundle** — `vm.createContext` + a
  mini-React `createElement` mock exercises the full `apply` path:
  effect fires, `registerTab` is called with the expected descriptor,
  the rendered tree contains the iframe with the local server's URL,
  `exports.apply` and `exports.inject = ['betterSidebar']` are
  exposed. (2 new cases, 41 total.)

### Changed
- `package.json`:
  - `version` 0.4.0 → 0.5.0
  - new export `.`/`./client`
  - new `dsh.client` block alongside the existing `dsh.bundle`
  - `description` mentions the side card

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