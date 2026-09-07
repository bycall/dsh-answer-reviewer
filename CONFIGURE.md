# Configuring dsh-answer-reviewer

This plugin is **run-ready with zero configuration**: it inherits the
agent's own route and only attaches an extra review step at each turn
boundary. Everything below is optional tuning for people who want a
*tighter* gate, a cheaper review call, or a genuinely separate reviewer.

## What "independent review" actually means here

There are two degrees of independence, and it's important to tell them
apart so you don't set the wrong expectation:

| Degree | How | What you get |
| --- | --- | --- |
| **Role isolation** (default, zero config) | review model = agent's model, but a *different system prompt* (a strict grader vs a helpful answerer) | The same weights try on a "judge" hat, which catches some self-grading bias but not all of it. |
| **Model isolation** (needs a key) | `reviewProvider`/`reviewModel` point at a different model (e.g. the agent uses kimi-k3, the reviewer uses claude/gpt/deepseek) | A genuinely separate reviewer with different inductive biases — the strongest form of independence. |

Today the host ships **only** `moonshotai/kimi-k3` in the model picker,
so model isolation is impossible until another provider's credentials are
added to the host. Until then, the plugin runs in role-isolation mode,
which is still valuable: the reviewer prompt is intentionally strict and
the score gate has been tuned (see below) so common "the model rubber-
stamps its own work" failures are caught even with the same weights.

## Defaults

| key | default | notes |
| --- | --- | --- |
| `enabled` | `true` | kill switch |
| `threshold` | `80` | inclusive 1-100 gate; below → steer |
| `maxChallenges` | `5` | hard cap per (session, turn), max 8 |
| `maxReviewTokens` | `512` | reviewer output cap |
| `timeoutMs` | `60000` | wall clock on the review call |
| `reviewProvider` | *(agent's)* | must pair with `reviewModel` |
| `reviewModel` | *(agent's)* | must pair with `reviewProvider` |

## How to tune the gate

The score gate is the real control — not `maxChallenges`, which is only a
leak guard. Two dials:

1. **`threshold`** — raise it for a stricter gate (fewer mediocre replies
   ship), lower it for a more permissive one. Because the prompt now
   hard-codes "satisfying an explicit user constraint (briefness / format
   / length) IS the requirement", a deliberately-brief *correct* answer
   still scores high; a verbose-but-wrong answer scores low. The right
   value depends on how much churn you can tolerate:
   - `70` — permissive; only obvious garbage bounces back.
   - `80` — balanced (default).
   - `90` — strict; most non-perfect replies get one more pass.

2. **`maxChallenges`** — how many times per user turn the agent may be
   bounced. `5` is a reasonable ceiling; beyond that the reply ships
   as-is even if the reviewer is still unhappy. If you raise `threshold`,
   consider raising `maxChallenges` too, otherwise you may hit the cap
   before the agent converges.

## Enabling a genuinely separate reviewer (model isolation)

Three steps, the first of which is an environment change that I cannot
complete for you right now — there is no second model or key available
in the current host.

1. **Add a second model's credentials to the host.** Concretely this is
   how the agent itself gets `moonshotai/kimi-k3`; adding e.g. a
   DeepSeek / OpenAI / Anthropic key somewhere in the dsh host's provider
   configuration makes that model appear in the model picker. Your
   provider names/keys live in your dsh environment, outside this plugin.

2. **Point the reviewer at it.** In the plugin's cordis entry (either the
   `cordis.patch.yml` config for this bundle, or a user-layer overlay in
   `~/.dsh/profiles/web/cordis.yml`), set both together:

   ```yaml
   # user-layer cordis.yml overlay
   answer-reviewer:
     reviewProvider: deepseek
     reviewModel: deepseek-chat
   ```

   or, if you prefer per-session config:

   ```jsonc
   // ~/.dsh/profiles/web/package.json → dsh section (not recommended;
   // better as a cordis overlay so your CLI/flags can override)
   ```

   Only one of the two may be set, not neither-as-a-pair: the plugin
   throws at mount if `reviewProvider` xor `reviewModel` is present.

3. **Restart the host.** `dsh` reads the cordis entry at boot; a live
   reload may pick it up depending on `patchReload` setting, but a clean
   restart is the safe path.

> Do NOT hard-code a second model in this plugin's own config file — the
> reviewer must be free to track whatever provider you add to the host.

## Performance notes

- **Latency.** Each turn boundary costs one extra LLM round-trip (the
  review call). With `timeoutMs=60_000` a slow reviewer delays every
  turn by up to that. For interactive use, keep the review model small /
  fast, or lower `maxReviewTokens`.
- **Cost.** Reviews happen at every turn boundary, so they multiply your
  token spend. A separate model at a lower tier (or the agent model with
  `maxReviewTokens` capped) keeps this affordable.
- **Fail-open.** If the review call errors, times out, or returns
  garbage, the turn closes normally — the reviewer can never wedge the
  agent.
