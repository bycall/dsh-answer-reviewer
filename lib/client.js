// dsh-answer-reviewer — client bundle.
//
// Registers ONE right-side tab in dsh-better-sidebar: a live config panel
// that loads the local HTTP config server (lib/server.js, bound to
// 127.0.0.1:3987 by default) inside an iframe. The iframe reuses the
// exact same HTML form the standalone /api/config server renders — no
// React form logic, no second source of truth, no API shape drift.
//
// Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the
// lazy-CJS table contract consumed by dsh-web-app. The factory requires
// only `react` / `react-dom` (the host's shared client module table),
// so this file stays self-contained over the shared table. No relative
// require, no JSX, no build step.
//
// Why an iframe (not a React form)?
//   * The standalone HTML page is already styled, already working, and
//     already tested by the smoke harness. Re-implementing it in React
//     would be a second source of truth that could drift.
//   * The HTTP API and the React tab share the same ConfigStore via
//     the host process, so a save through the tab is observable to the
//     standalone server (and vice versa) on the very next GET.
//   * When `REVIEWER_HTTP=0` the iframe silently fails to load; the
//     small hint strip below the meta line tells the user where to
//     re-enable it.

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

    /**
     * The tab component: a tiny header strip + a flex iframe pointing at
     * the local config server. When `props.visible` is false the iframe
     * is unmounted so background tabs don't keep polling.
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
              color: "var(--color-text-secondary, #6b6b70)",
              borderBottom: "0.5px solid var(--color-border-tertiary, rgba(0,0,0,0.12))",
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
          ? createElement("iframe", {
              src: "http://127.0.0.1:3987/",
              title: "dsh-answer-reviewer config",
              style: {
                flex: "1 1 auto",
                minHeight: 0,
                width: "100%",
                border: "0",
                background: "transparent",
                display: "block",
              },
            })
          : createElement(
              "div",
              {
                style: {
                  flex: "1 1 auto",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "12px",
                  color: "var(--color-text-tertiary, #999)",
                },
              },
              "(tab 失活 · 切回可见自动加载)"
            )
      );
    }

    /**
     * Plugin entry (client side). Declared in package.json under
     * `dsh.client.inject` so better-sidebar's `ctx.betterSidebar` is
     * guaranteed to be live when this runs.
     */
    function apply(rawContext) {
      var ctx = rawContext;
      ctx.effect(function () {
        return ctx.betterSidebar.registerTab({
          id: "dsh-answer-reviewer:config",
          title: "Reviewer 配置",
          order: 50,
          single: true,
          component: function (props) {
            return createElement(ReviewerConfigTab, props);
          },
        });
      }, "dsh-answer-reviewer: register betterSidebar config tab");
    }

    exports.apply = apply;
    exports.inject = ["betterSidebar"];
    return module.exports;
  },
});
