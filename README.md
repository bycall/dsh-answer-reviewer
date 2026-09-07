# dsh-answer-reviewer

A dsh host plugin: every time the agent is about to close a turn, the
plugin extracts the assistant's final user-facing text and asks a dedicated
review model to grade it. If the verdict is `fail`, the plugin steers the
agent back into the same turn with concrete findings so it produces a
corrected reply. Each turn is capped at `maxChallenges` challenges
(default `3`); once the cap is reached, the agent is allowed to close the
turn.

The review model is independent from the agent's working model when
`reviewProvider` / `reviewModel` are configured; otherwise the plugin falls
back to the agent's current route so it works out of the box.

## Why a separate model?

The review model uses a strict JSON-only grader prompt (`verdict` +
`reasons`) that the agent never sees directly. The findings are injected
back as a `user/message` with `source: { kind: 'plugin', plugin:
'dsh-answer-reviewer' }`, so the agent treats them as user input — but the
agent is explicitly told not to mention the review to the user. A different
provider/model reduces the chance that a self-graded check rubber-stamps
its own work.

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

| key               | type      | default  | meaning                                                        |
| ----------------- | --------- | -------- | -------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`   | Kill switch. Set to `false` to disable without uninstalling.   |
| `maxChallenges`   | `number`  | `3`      | Steer count per turn. Hard-capped at `8`.                      |
| `maxReviewTokens` | `number`  | `512`    | Output cap for the review model.                               |
| `timeoutMs`       | `number`  | `60000`  | Wall-clock cap on the review call.                             |
| `reviewProvider`  | `string`  | agent's  | Provider for the dedicated review model. Must pair with model. |
| `reviewModel`     | `string`  | agent's  | Model id for the dedicated review model. Must pair with provider. |

`reviewProvider` and `reviewModel` must be supplied together; supplying one
without the other is a configuration error and the plugin will refuse to
mount.

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
- **Per-turn counter is capped.** Once a turn has been steered
  `maxChallenges` times, subsequent turn boundaries inside the same turn
  are allowed to close without review.
- **The agent is told not to mention the review.** The steer message
  explicitly instructs the agent to address the findings silently.

## Test

```
node test/smoke.mjs
```

The smoke test exercises every pure helper plus the fail-open and
skip-subagent branches of `onTurnStopping` with mock objects. It does not
boot a dsh host.

## Files

- `lib/index.js` — cordis `apply`, wires the listener and orchestrates the
  review call.
- `lib/review.js` — pure helpers: `resolveConfig`, `extractAssistantText`,
  `buildReviewPrompt`, `parseVerdict`, `buildSteerMessage`,
  `createChallengeCounter`, and the public `Config` zod schema.
- `cordis.patch.yml` — cordis bundle entry that mounts the plugin.
- `test/smoke.mjs` — node ESM smoke test.
