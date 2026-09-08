# dsh-answer-reviewer

A dsh host plugin: every time the agent is about to close a turn, the
plugin extracts the assistant's final user-facing text and asks a dedicated
review model to grade it on a 1-100 scale. If the score is below the
configured `threshold` (default `80`), the plugin steers the agent back
into the same turn with the reviewer's single most important finding as
concrete feedback. Once a turn has been steered `maxChallenges` times
(default `5`), the agent's reply is allowed to close the turn as-is — the
cap is a leak guard, not the real gate; the score threshold is.

Tune the gate, switch the reviewer on/off, change the max-challenges cap,
or pick a dedicated review model — all live, no host restart — through a
self-hosted config UI on **`http://127.0.0.1:3987`** (or via the same
JSON API from `curl`). The on-disk config lives at
`~/.dsh/answer-reviewer.json` (override with `REVIEWER_CONFIG_PATH`);
turns of the host go through with the defaults if the file is absent.

The review model sees **every real user prompt** the user has issued in
the session (any `user/message` event whose `source.kind` is not
`'plugin'`), tagged `<all_user_prompts>`, plus the assistant's final
reply under `<reply>`. Plugin-injected context (file-change notices,
AGENTS.md, skill content, system reminders) is filtered out so the
reviewer scores against what the user actually asked, not against the
context the harness happened to be carrying.

The review model is independent from the agent's working model when
`reviewProvider` / `reviewModel` are configured; otherwise the plugin
falls back to the agent's current route so it works out of the box.

## Why a separate model?

The review model uses a strict JSON-only grader prompt (`{score, reason}`)
that the agent never sees directly. The findings are injected back as a
`user/message` with `source: { kind: 'plugin', plugin:
'dsh-answer-reviewer' }`, so the agent treats them as user input — but
the agent is explicitly told not to mention the review to the user. A
different provider/model reduces the chance that a self-graded check
rubber-stamps its own work, and the explicit numerical gate means a
well-tuned model that returns 80+ will not trigger any re-attempt.

## Live config (since 0.4.0)

The plugin starts a tiny `node:http` server bound to `127.0.0.1:3987`
(no external access). Open it in a browser to see the form, the on-disk
config path, and a rolling list of the last 15 review outcomes. The same
JSON API is reachable from the shell:

```bash
# Read current effective config + overrides + file path
curl -s http://127.0.0.1:3987/api/config

# Tweak the threshold (only the fields you POST are written)
curl -s -X POST http://127.0.0.1:3987/api/config \
  -H 'content-type: application/json' \
  -d '{"threshold": 90}'

# Disable the reviewer
curl -s -X POST http://127.0.0.1:3987/api/config \
  -H 'content-type: application/json' \
  -d '{"enabled": false}'

# Wipe overrides back to defaults (also removes the on-disk file)
curl -s -X DELETE http://127.0.0.1:3987/api/config

# See the last 20 review outcomes
curl -s http://127.0.0.1:3987/api/recent
```

Disable the server with `REVIEWER_HTTP=0`. Change the port with
`REVIEWER_HTTP_PORT=<n>`. Move the on-disk file with
`REVIEWER_CONFIG_PATH=<abs path>`. The next turn picks up the new value
with no host restart.

## Install

Add the package to your profile's `dependencies` and to
`dsh.profile.bundles`, then refresh the host.

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-answer-reviewer": "file:/Users/bycall/Downloads/workbuddy/Claw/dsh-answer-reviewer"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-answer-reviewer"
      ]
    }
  }
}
```

Then `dsh plugin --profile web install` and restart the host.

## Configuration

| key               | type      | default | meaning                                                          |
| ----------------- | --------- | ------- | ---------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`  | Kill switch. Set to `false` to disable without uninstalling.     |
| `threshold`       | `number`  | `80`    | Inclusive 1-100 score gate. Below this, the plugin steers.       |
| `maxChallenges`   | `number`  | `5`     | Hard cap on steers per (session, turn). Hard-capped at `8`.      |
| `maxReviewTokens` | `number`  | `512`   | Output cap for the review model.                                 |
| `timeoutMs`       | `number`  | `60000` | Wall-clock cap on the review call.                               |
| `reviewProvider`  | `string`  | agent's | Provider for the dedicated review model. Must pair with model.   |
| `reviewModel`     | `string`  | agent's | Model id for the dedicated review model. Must pair with provider. |

`threshold` must be an integer in `[1, 100]`; out-of-range values fall
back to the default rather than being silently clamped (so a mis-set
config does not quietly change the gate from "80" to "100").

`reviewProvider` and `reviewModel` must be supplied together; supplying
one without the other is a configuration error and the plugin will
refuse to mount.

## Behaviour

- **Subagent turns are skipped.** The plugin only reviews the user-facing
  agent. `agent.session.header.origin === 'subagent'` is filtered out.
- **Empty / interrupted assistant output is skipped.** No review means no
  steer.
- **Review call failures are fail-open.** Network errors, timeouts, parse
  failures, or model-side errors all log a warning and let the turn close
  normally. A flaky reviewer must never wedge the host.
- **Aborted signals short-circuit.** If the user paused or cancelled the
  turn, the review is cancelled mid-flight and the turn is left alone.
- **Out-of-band scores fail closed.** The review model must return an
  integer in `[1, 100]` with a non-empty `reason`. Anything else (model
  returns "1.5", "99.9%", "I score this ...", etc.) is treated as a
  parse failure — failing open would let a misbehaving reviewer buy a
  pass by returning garbage.
- **Per-turn counter is capped.** Once a turn has been steered
  `maxChallenges` times, subsequent turn boundaries inside the same turn
  are allowed to close without review. With the default `5` you will
  see at most five steered re-attempts before the agent's reply goes to
  the user as-is, even if the review model still scores it below the
  threshold — the cap is a hard budget, not a soft hint.
- **The agent is told not to mention the review.** The steer message
  explicitly instructs the agent to address the finding silently.

## Test

```
node test/smoke.mjs
```

The smoke test exercises every pure helper plus the fail-open,
skip-subagent, below-threshold, and cap-exhausted branches of
`onTurnStopping` with mock objects (mocked `BlockAssembler`-shaped stream
chunks). It does not boot a dsh host.

## Files

- `lib/index.js` — cordis `apply`, wires the listener and orchestrates the
  review call. Imports from `./internal.js`.
- `lib/internal.js` — barrel re-export so `lib/index.js` and tests import
  from one place.
- `lib/review.js` — pure helpers: `resolveConfig`, `extractAssistantText`,
  `extractUserPrompts`, `buildReviewPrompt`, `parseScore`,
  `isScoreAcceptable`, `buildSteerMessage`, `createChallengeCounter`,
  and the public `Config` zod schema.
- `lib/config-store.js` — `createConfigStore` (persistent, hot-reloadable),
  `defaultConfigPath`, env-var constants for the HTTP server.
- `lib/server.js` — `startServer(store, opts)` — the 127.0.0.1-only
  `node:http` instance (HTML form + JSON API).
- `cordis.patch.yml` — cordis bundle entry that mounts the plugin.
- `test/smoke.mjs` — node ESM smoke test (39 cases).
- `CONFIGURE.md` — detailed configuration guide (default vs independent
  review model, threshold tuning, fail-closed/fail-open matrix).
- `CHANGELOG.md` — versioned release history.

## Further reading

- **`CONFIGURE.md`** — answers "how do I configure an independent
  reviewer model", "how should I pick a threshold", and "what does this
  plugin do on bad config". Read it before tuning `threshold` or wiring
  up a second provider.
- **`CHANGELOG.md`** — the breaking change in `0.3.0` is the
  threshold/maxChallenges split; if you are upgrading from `0.2.x`, read
  the migration note there.

