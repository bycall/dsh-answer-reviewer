// dsh-answer-reviewer — client bundle.
//
// Registers three surfaces.
//
//   1. `conversation.chat.assistant-actions` — the SCORE CHIP. One entry in the
//      finalized assistant message's action row showing the review score for
//      that exact answer, read from the same-origin feed the host publishes at
//      /api/dsh-answer-reviewer/reviews. Renders nothing until a score exists.
//      See ReviewScoreBadge below.
//
//   2. `conversation.input.dock` — the CONFIG STRIP. A collapsed strip tucked
//      above the composer that expands into the config iframe as an OVERLAY (so
//      opening it never reflows the transcript). Styled to match dsh's own dock
//      entries. See ReviewerConfigDock below.
//
// Both of those need nothing beyond the core `slots` service, so they work on
// every install.
//
//   3. a right-sidebar tab via dsh-better-sidebar — OPTIONAL, an add-on
//      for users who prefer the sidebar. Absent plugin => no tab, no error.
//
// Surfaces 2 and 3 both embed the same standalone page served by lib/server.js
// (127.0.0.1:3987 by default), so there is still exactly ONE form
// implementation and ONE ConfigStore. The score chip is different: it is plain
// React reading a small JSON feed, because it must sit inside the message
// action row where an iframe would be absurd, and because a score is one
// number plus one sentence.
//
// dsh-better-sidebar is OPTIONAL and is never a declared dependency; the
// plugin's actual work — reviewing every turn — is host-side and unaffected.
//
// Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the
// lazy-CJS table contract consumed by dsh-web-app. The factory requires
// only `react` (the host's shared client module table), so this file stays
// self-contained. No relative require, no JSX, no build step.
//
// Why an iframe (not a React form)?
//   * The standalone HTML page is already styled, already working, and
//     already tested by the smoke harness. Re-implementing it in React
//     would be a second source of truth that could drift.
//   * The HTTP API and both UI mounts share the same ConfigStore via
//     the host process, so a save through a mount is observable to the
//     standalone server (and vice versa) on the very next GET.
//   * When `REVIEWER_HTTP=0` the iframe cannot load; the dock detects
//     that and swaps in an actionable hint instead of a dead frame.

window.__ModuleLoader__.load({
  id: "dsh-answer-reviewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ── react (defensive default interop) ────────────────────────────────
    var reactModule = require("react");
    var react = reactModule && reactModule.default ? reactModule.default : reactModule;
    var createElement = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    // ── config server (lib/server.js) ────────────────────────────────────
    // Port override: REVIEWER_HTTP_PORT. Kept in sync with DEFAULT_HTTP_PORT
    // in lib/config-store.js by the smoke test.
    var CONFIG_ORIGIN = "http://127.0.0.1:3987";
    var CONFIG_URL = CONFIG_ORIGIN + "/";
    var HEALTH_URL = CONFIG_ORIGIN + "/api/health";

    var DOCK_SLOT = "conversation.input.dock";
    // `id` is REQUIRED for a `kind: "list"` slot (the registry throws
    // `list slot "..." requires options.id`), and it is what makes a second
    // registration at the same priority an error instead of a duplicate.
    var DOCK_ID = "answer-reviewer:config";
    var DOCK_OPEN_KEY = "dsh-answer-reviewer:dock-open";

    // ── score badge ──────────────────────────────────────────────────────
    // `conversation.chat.assistant-actions` is a list slot declared by
    // ui-chat's turn-tail node: "Ordered actions for one finalized assistant
    // message". Each entry receives `messageId` — the durable id of the
    // answer being acted on, which is exactly what the host records its
    // review against. `replaceRisk: "none"`, so our entry sits beside the
    // shipped feedback buttons instead of shadowing them.
    var SCORE_SLOT = "conversation.chat.assistant-actions";
    var SCORE_ID = "answer-reviewer:score";
    // The shipped Like/Dislike entry registers at the default order, so a
    // positive order parks the score to its right.
    var SCORE_ORDER = 100;
    // Same-origin route mounted by the host half (lib/server.js
    // REVIEWS_ROUTE_PATH). Relative, so it follows whatever origin the page
    // was served from — no port or host is hardcoded here.
    var REVIEWS_URL = "/api/dsh-answer-reviewer/reviews";
    var SCORE_POLL_MS = 2000;

    // dsh design tokens. The fallbacks only matter if the bundle is ever
    // rendered outside a dsh page.
    var BORDER = "var(--dsw-alias-border-l2, rgba(0,0,0,0.12))";
    var BORDER_L1 = "var(--dsw-alias-border-l1, rgba(0,0,0,0.06))";
    var LABEL_PRIMARY = "var(--dsw-alias-label-primary, #1b2434)";
    var LABEL_SECONDARY = "var(--dsw-alias-label-secondary, #6b6b70)";
    var LABEL_TERTIARY = "var(--dsw-alias-label-tertiary, #999)";
    var LAYER = "var(--dsw-alias-bg-layer-1, #fff)";
    // The soft "chrome" fill dsh's own dock entries use (QueueDock.module.css).
    var TIP = "var(--dsw-specific-tip, rgba(0,0,0,0.035))";
    // Caution colour for the "server down" hint. No dsh token exists for it.
    var WARN = "var(--dsw-alias-label-warning, #c2500f)";
    // Semantic state pairs for the score chip. Both themes resolve through
    // these tokens, so the chip tracks the host theme with no local palette.
    var OK_TINT = "var(--dsw-alias-state-success-tertiary, #e6faed)";
    var OK_MARK = "var(--dsw-alias-state-success-primary, #22c55e)";
    var LOW_TINT = "var(--dsw-alias-state-warn-tertiary, #fef5e7)";
    var LOW_MARK = "var(--dsw-alias-state-warn-primary, #f59e0b)";

    // ── composer-aligned geometry ────────────────────────────────────────
    // `conversation.input.dock` is a `kind: "list"` slot rendered as a direct
    // flex child of dsh's `.composerStack`. Two consequences, both learned
    // from dsh's own queue dock:
    //   1. A dock entry MUST set `flex: none`. With the default
    //      `flex-shrink: 1` it competes for space in that fixed-height column,
    //      gets crushed to a few pixels, and then its own `overflow: hidden`
    //      clips the row into an unreadable sliver.
    //   2. It must repeat the width formula below, otherwise it stretches
    //      across the whole conversation column instead of lining up with the
    //      composer card.
    var GAP_VAR = "var(--dsh-composer-stack-gap, 6px)";
    var INSET_VAR = "var(--dsh-composer-dock-inset, 8px)";
    var CLEARANCE_VAR = "var(--dsh-composer-side-clearance, 16px)";
    var CARD_MAX_VAR = "var(--dsh-composer-card-max-width, 100%)";

    /** Persisted expanded/collapsed state. Never throws in a bare sandbox. */
    function readStoredOpen() {
      try {
        return window.localStorage.getItem(DOCK_OPEN_KEY) === "1";
      } catch (e) {
        return false;
      }
    }

    function storeOpen(open) {
      try {
        window.localStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0");
      } catch (e) {
        /* private mode / storage disabled — state simply does not persist */
      }
    }

    /**
     * The shared config iframe. `fill` picks a filling height (sidebar tab)
     * over a fixed one (dock); everything else is identical.
     */
    function ConfigFrame(props) {
      return createElement("iframe", {
        src: CONFIG_URL,
        title: "dsh-answer-reviewer config",
        style: {
          flex: props && props.fill ? "1 1 auto" : "none",
          height: props && props.fill ? "100%" : props && props.height ? props.height : "320px",
          width: "100%",
          minHeight: 0,
          border: "0",
          background: "transparent",
          display: "block",
        },
      });
    }

    /**
     * The sidebar tab: a tiny header strip + a flex iframe. When
     * `props.visible` is false the iframe is unmounted so background tabs
     * don't keep polling.
     */
    function ReviewerConfigTab(props) {
      var mounted = useState(true);
      var isMounted = mounted[0];
      var setMounted = mounted[1];
      useEffect(function () {
        // Better-sidebar pauses live views when the tab is not active.
        // Mirroring that here means a non-active tab does not run fetch
        // timers in the iframe.
        setMounted(Boolean(props.visible));
      }, [props.visible]);

      return createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            minHeight: 0,
            background: "var(--color-background-primary, #fff)",
          },
        },
        createElement(
          "div",
          {
            style: {
              flex: "none",
              padding: "8px 12px",
              fontSize: "12px",
              color: LABEL_SECONDARY,
              borderBottom: "0.5px solid " + BORDER,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            },
          },
          createElement("span", { style: { fontWeight: 500 } }, "dsh-answer-reviewer"),
          createElement("span", null, "·"),
          createElement("span", null, "实时配置"),
          createElement(
            "span",
            { style: { marginLeft: "auto", opacity: 0.7 } },
            "本地 127.0.0.1:3987"
          )
        ),
        isMounted
          ? createElement(ConfigFrame, { fill: true })
          : createElement(
              "div",
              {
                style: {
                  flex: "1 1 auto",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "12px",
                  color: LABEL_TERTIARY,
                },
              },
              "(tab 失活 · 切回可见自动加载)"
            )
      );
    }

    /** A small "sliders" glyph marking the row as a settings entry. */
    function DockIcon() {
      return createElement(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
        createElement("path", {
          d: "M1.75 4.5h10.5M1.75 9.5h10.5",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
        }),
        createElement("circle", { cx: 5, cy: 4.5, r: 1.5, fill: "currentColor" }),
        createElement("circle", { cx: 9, cy: 9.5, r: 1.5, fill: "currentColor" })
      );
    }

    /** The disclosure caret. Rotated by CSS when the panel is open. */
    function DockCaret() {
      return createElement(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
        createElement("path", {
          d: "M4 8.5 7 5.5l3 3",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        })
      );
    }

    /**
     * Conversation input dock.
     *
     * Collapsed (default) it is a single quiet strip tucked above the
     * composer. Expanded it overlays the config panel ABOVE the strip rather
     * than growing inline: the strip is inside dsh's fixed-height composer
     * column, so an inline panel would shove the composer down and reflow the
     * whole transcript. Overlaying keeps the conversation perfectly still —
     * the panel floats over the bottom of the message list (z-index above the
     * composer seat) and disappears again on collapse.
     *
     * Collapsing UNMOUNTS the iframe, so a closed dock never runs the page's
     * poll timers.
     *
     * The slot's props are deliberately ignored: the dock needs nothing from
     * the session, which keeps it decoupled from slot prop shape changes.
     */
    function ReviewerConfigDock() {
      var pair = useState(readStoredOpen());
      var open = pair[0];
      var setOpen = pair[1];

      // "unknown" | "ok" | "down" — probed only while expanded.
      var healthPair = useState("unknown");
      var health = healthPair[0];
      var setHealth = healthPair[1];

      useEffect(function () {
        storeOpen(open);
        if (!open) {
          setHealth("unknown");
          return undefined;
        }
        var cancelled = false;
        // `no-cors` yields an opaque response, but it still RESOLVES when
        // the port answers and REJECTS when nothing is listening — enough
        // to tell "REVIEWER_HTTP=0 / server down" from "still loading".
        fetch(HEALTH_URL, { mode: "no-cors", cache: "no-store" })
          .then(function () {
            if (!cancelled) setHealth("ok");
          })
          .catch(function () {
            if (!cancelled) setHealth("down");
          });
        return function () {
          cancelled = true;
        };
      }, [open]);

      // The whole strip is ONE button, exactly like dsh's own dock headers.
      var header = createElement(
        "button",
        {
          type: "button",
          onClick: function () {
            setOpen(!open);
          },
          title: open ? "收起 Reviewer 配置" : "展开 Reviewer 配置",
          "aria-expanded": open,
          style: {
            boxSizing: "border-box",
            width: "100%",
            height: "32px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "0 12px",
            minWidth: 0,
            font: "inherit",
            fontFamily: "Inter, var(--dsw-font-family, inherit)",
            color: LABEL_PRIMARY,
            textAlign: "left",
            cursor: "pointer",
            background: "transparent",
            border: "none",
            borderRadius: "8px",
          },
        },
        createElement(
          "span",
          {
            style: {
              flex: "none",
              display: "grid",
              placeItems: "center",
              width: "14px",
              height: "14px",
              color: LABEL_TERTIARY,
            },
          },
          createElement(DockIcon, null)
        ),
        createElement(
          "span",
          {
            style: {
              flex: "auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "13px",
              fontWeight: 500,
              lineHeight: "20px",
            },
          },
          "Reviewer 配置"
        ),
        // Address and deep link only while OPEN — the collapsed strip stays a
        // single quiet line so it barely registers above the composer.
        open
          ? createElement(
              "span",
              {
                style: {
                  flex: "none",
                  fontSize: "12px",
                  lineHeight: "20px",
                  color: LABEL_TERTIARY,
                  fontVariantNumeric: "tabular-nums",
                },
              },
              "127.0.0.1:3987"
            )
          : null,
        open
          ? createElement(
              "a",
              {
                href: CONFIG_URL,
                target: "_blank",
                rel: "noreferrer",
                onClick: function (event) {
                  event.stopPropagation();
                },
                style: {
                  flex: "none",
                  fontSize: "12px",
                  lineHeight: "20px",
                  color: LABEL_SECONDARY,
                  textDecoration: "none",
                },
              },
              "新标签"
            )
          : null,
        health === "down"
          ? createElement(
              "span",
              {
                style: {
                  flex: "none",
                  fontSize: "12px",
                  lineHeight: "20px",
                  color: WARN,
                },
              },
              "服务未就绪"
            )
          : null,
        createElement(
          "span",
          {
            style: {
              flex: "none",
              display: "grid",
              placeItems: "center",
              width: "14px",
              height: "14px",
              color: LABEL_TERTIARY,
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 120ms ease",
            },
          },
          createElement(DockCaret, null)
        )
      );

      var panel = createElement(
        "div",
        {
          style: {
            boxSizing: "border-box",
            width: "100%",
            background: TIP,
            borderRadius: "12px 12px 0 0",
            border: "0.5px solid " + BORDER_L1,
            borderBottom: "none",
            padding: "2px 0",
            position: "relative",
            overflow: "hidden",
          },
        },
        header
      );

      // Expanded panel — absolutely positioned so it NEVER reflows the
      // transcript. `bottom: 100%` anchors it just above the strip; the
      // left/right offsets equal the root padding, so it lines up exactly with
      // the strip and therefore with the composer card.
      var overlay = null;
      if (open) {
        overlay = createElement(
          "div",
          {
            style: {
              position: "absolute",
              left: INSET_VAR,
              right: INSET_VAR,
              bottom: "100%",
              marginBottom: "8px",
              zIndex: 30,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              overflow: "hidden",
              // Deliberately shorter than the old inline panel: the point of
              // the overlay is to stay out of the way.
              height: "min(38vh, 340px)",
              minHeight: "180px",
              borderRadius: "12px",
              border: "0.5px solid " + BORDER_L1,
              background: LAYER,
              boxShadow:
                "0 12px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)",
            },
          },
          health === "down"
            ? createElement(
                "div",
                {
                  style: {
                    padding: "14px 16px",
                    fontSize: "12px",
                    lineHeight: "20px",
                    color: LABEL_TERTIARY,
                  },
                },
                "配置服务未监听 127.0.0.1:3987。若设过 REVIEWER_HTTP=0 请先取消；" +
                  "否则查看宿主启动日志里的端口占用，或在终端执行 dsh --profile web 复现。"
              )
            : createElement(ConfigFrame, { fill: true })
        );
      }

      return createElement(
        "div",
        {
          style: {
            boxSizing: "border-box",
            // Same formula as dsh's QueueDock.module.css so the strip matches
            // the composer card width and stays centred.
            width:
              "calc(100% - " +
              CLEARANCE_VAR +
              " - " +
              CLEARANCE_VAR +
              " - " +
              INSET_VAR +
              " - " +
              INSET_VAR +
              ")",
            maxWidth: "calc(" + CARD_MAX_VAR + " - " + INSET_VAR + " - " + INSET_VAR + ")",
            margin: "0 auto calc(0px - " + GAP_VAR + " - 3px)",
            padding: "0 " + INSET_VAR,
            // CRITICAL: without `flex: none` the composer column crushes this
            // row and `overflow: hidden` clips it to a sliver.
            flex: "none",
            position: "relative",
            minWidth: 0,
          },
        },
        overlay,
        panel
      );
    }

    // ── score feed (one poller for every badge on the page) ──────────────
    // A transcript can hold dozens of badges and they all read the same tiny
    // payload, so there is exactly ONE request in flight and ONE map. Badges
    // subscribe; none of them fetches.
    var scores = {}; // messageId -> review record
    var scoreSubs = new Set();
    var scoreTimer = null;
    var scoreInFlight = false;

    function publishScores(next) {
      scores = next;
      scoreSubs.forEach(function (fn) {
        try {
          fn();
        } catch (e) {
          /* one bad subscriber must not starve the rest */
        }
      });
    }

    /** Same keys, same score, same `at` on every record => nothing to do. */
    function scoresUnchanged(prev, next) {
      var keys = Object.keys(next);
      if (keys.length !== Object.keys(prev).length) return false;
      for (var i = 0; i < keys.length; i += 1) {
        var rec = next[keys[i]];
        var old = prev[keys[i]];
        if (!old || old.at !== rec.at || old.score !== rec.score) return false;
      }
      return true;
    }

    function fetchScores() {
      if (scoreInFlight || typeof fetch !== "function") return;
      scoreInFlight = true;
      fetch(REVIEWS_URL, { cache: "no-store", credentials: "same-origin" })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.entries)) return;
          var next = {};
          for (var i = 0; i < data.entries.length; i += 1) {
            var entry = data.entries[i];
            if (entry && typeof entry.messageId === "string") next[entry.messageId] = entry;
          }
          if (!scoresUnchanged(scores, next)) publishScores(next);
        })
        .catch(function () {
          /* host restarting or route absent: keep the last known scores */
        })
        .then(function () {
          scoreInFlight = false;
        });
    }

    /** Start the single shared poller. Idempotent, and a no-op in a bare vm. */
    function startScorePolling() {
      if (scoreTimer !== null) return;
      if (typeof window === "undefined" || typeof fetch !== "function") return;
      fetchScores();
      scoreTimer = setInterval(fetchScores, SCORE_POLL_MS);
      // Navigating between sessions swaps the whole badge set; refresh the
      // moment the page is visible again instead of waiting out a poll tick.
      window.addEventListener("focus", fetchScores);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) fetchScores();
      });
    }

    /**
     * Subscribe one badge to the feed for its own message id.
     * @returns the record, or `null` while this message has no score.
     */
    function useScore(messageId) {
      var pair = useState(messageId && scores[messageId] ? scores[messageId] : null);
      var record = pair[0];
      var setRecord = pair[1];
      useEffect(function () {
        if (!messageId) return undefined;
        var sync = function () {
          setRecord(scores[messageId] || null);
        };
        scoreSubs.add(sync);
        sync();
        startScorePolling();
        return function () {
          scoreSubs.delete(sync);
        };
      }, [messageId]);
      return record;
    }

    /** "ok" when the answer cleared the gate, "low" when it did not. */
    function scoreBand(record) {
      if (!record) return "none";
      if (typeof record.threshold === "number") {
        return record.score >= record.threshold ? "ok" : "low";
      }
      return record.decision === "pass" ? "ok" : "low";
    }

    /** Chip text: `评分 92`, or `评分 61 · 第2次` on a retried turn. */
    function scoreLabel(record) {
      var text = "评分 " + record.score;
      if (typeof record.attempt === "number" && record.attempt > 1) {
        text += " · 第" + record.attempt + "次";
      }
      return text;
    }

    /** Hover explanation: the gate, the verdict, and the reviewer's reason. */
    function scoreVerdict(decision) {
      if (decision === "pass") return "通过";
      if (decision === "steer") return "未达标，已打回让 agent 重做";
      if (decision === "capped") return "未达标，重试次数已用尽";
      if (decision === "steer-fail") return "未达标，打回失败";
      return String(decision || "已审查");
    }

    function scoreTooltip(record) {
      var parts = [];
      if (typeof record.threshold === "number") parts.push("阈值 " + record.threshold);
      parts.push(scoreVerdict(record.decision));
      if (typeof record.turn === "number") parts.push("第 " + record.turn + " 轮");
      var head = parts.join(" · ");
      return record.reason ? head + "\n" + record.reason : head;
    }

    /**
     * The score chip, rendered into the finalized assistant message's action
     * row next to the shipped copy/retry and Like/Dislike buttons.
     *
     * Renders NOTHING until a score exists for this exact message, so it never
     * reserves space nor shows a placeholder for answers the reviewer skipped
     * (plugin disabled, no review route, unparseable reply, exhausted retry
     * cap). That keeps the ribbon identical to stock dsh for anyone who has
     * not opted in.
     */
    function ReviewScoreBadge(props) {
      var record = useScore(props && props.messageId);
      if (!record || typeof record.score !== "number") return null;
      var ok = scoreBand(record) === "ok";
      return createElement(
        "span",
        {
          // Read by the smoke-less DOM checks and by anyone inspecting the
          // row; also makes the value selectable without opening the tooltip.
          "data-answer-reviewer-score": String(record.score),
          title: scoreTooltip(record),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            height: "20px",
            padding: "0 8px",
            borderRadius: "999px",
            background: ok ? OK_TINT : LOW_TINT,
            font: "inherit",
            fontFamily: "Inter, var(--dsw-font-family, inherit)",
            fontSize: "11px",
            fontWeight: 500,
            lineHeight: "20px",
            color: LABEL_PRIMARY,
            whiteSpace: "nowrap",
            flex: "none",
            cursor: "default",
            userSelect: "none",
          },
        },
        createElement("span", {
          "aria-hidden": "true",
          style: {
            flex: "none",
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: ok ? OK_MARK : LOW_MARK,
          },
        }),
        scoreLabel(record)
      );
    }

    /**
     * Plugin entry (client side).
     *
     * Both mounts use OPTIONAL, lazily-waited services rather than declared
     * dependencies. Declaring them in `exports.inject` would leave this entry
     * "pending (waiting for service: ...)" forever on a host that lacks one,
     * which the web boot audit reports as `N entry did not activate` and the
     * host renders as a "Failed to load plugins" banner over the main page.
     *
     * So the entry activates unconditionally and each mount is registered
     * through `ctx.inject([...], scope => ...)` — the same idiom the official
     * client bundles use for late-arriving services. When a service is absent
     * nothing is registered and nothing breaks.
     */
    function apply(rawContext) {
      var ctx = rawContext;

      // 1) Conversation surfaces. `slots` is a core client service, so both of
      //    these work on every install — no companion plugin required.
      ctx.inject(["slots"], function (scope) {
        scope.effect(function () {
          // Input dock: the config strip above the composer.
          var disposeDock = scope.slots.inject(DOCK_SLOT, function () {
            return scope.slots.register(
              { name: DOCK_SLOT, id: DOCK_ID, priority: 30 },
              ReviewerConfigDock
            );
          });
          // Assistant actions: the score chip beside the shipped Like/Dislike
          // entry, one per finalized assistant message.
          var disposeScore = scope.slots.inject(SCORE_SLOT, function () {
            return scope.slots.register(
              { name: SCORE_SLOT, id: SCORE_ID, order: SCORE_ORDER },
              ReviewScoreBadge
            );
          });
          return function () {
            try {
              if (typeof disposeScore === "function") disposeScore();
            } catch (e) {
              /* one disposer must not strand the other */
            }
            try {
              if (typeof disposeDock === "function") disposeDock();
            } catch (e) {
              /* ignore */
            }
          };
        }, "dsh-answer-reviewer: register conversation surfaces");
      });

      // 2) Optional right-sidebar tab.
      ctx.inject(["betterSidebar"], function (scope) {
        scope.effect(function () {
          return scope.betterSidebar.registerTab({
            id: "dsh-answer-reviewer:config",
            title: "Reviewer 配置",
            order: 50,
            single: true,
            component: function (props) {
              return createElement(ReviewerConfigTab, props);
            },
          });
        }, "dsh-answer-reviewer: register betterSidebar config tab");
      });
    }

    exports.apply = apply;
    // No hard service dependency — both mounts wait lazily in apply() so a
    // host without dsh-better-sidebar (or without the dock slot) cannot
    // stall this entry.
    exports.inject = [];

    // Test seam: the score feed is module-private state with no cordis service
    // to reach through, so the smoke harness needs a way to seed it. Pure
    // helpers are exposed alongside for direct assertions.
    exports.__test = {
      setScores: function (map) {
        publishScores(map && typeof map === "object" ? map : {});
      },
      getScores: function () {
        return scores;
      },
      scoreBand: scoreBand,
      scoreLabel: scoreLabel,
      scoreVerdict: scoreVerdict,
      scoreTooltip: scoreTooltip,
    };

    return module.exports;
  },
});
