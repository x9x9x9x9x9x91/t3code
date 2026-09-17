# Preview automation on a hidden tab

The preview tools (`preview_snapshot`, `preview_resize`, `preview_evaluate`, …)
drive a real Electron `WebContentsView` through CDP. With the preview panel
closed the tab still exists and still runs script, so `preview_evaluate` keeps
working: script execution needs no composited frame. `preview_snapshot` works on
a hidden tab as well; what defeats it is a page that blocks its own main thread.

CDP answers a result JSON cannot carry — `1n`, `NaN`, `Infinity`, `-0`, a symbol
— with `unserializableValue` or a bare type and no `value`, and a non-null object
that stays in the page with a remote handle that has no `value` either, which is
what a `returnByValue: false` call gets back for such an object. A primitive is
not a handle: a number, string or boolean still arrives as its `value` under
either flag. `preview_evaluate` fails every handle instead of reading the missing
`value` and reporting a successful `null`; only an expression that genuinely
returns `undefined`, or `null` itself, answers `null`. The failure names the
handle's type, subtype and class, and at most 160 characters of CDP's
`description` — it is the page's own error message and stack, and that cause
becomes the action-timeline entry a later `preview_snapshot` returns.

`preview_resize` resizes the host view and waits for the renderer to report the
new viewport. That wait is bounded by the request's host deadline, so a renderer
that never reports costs the wait rather than the whole request, and the agent
gets the viewport timeout instead of the broker's generic one.

## A snapshot timeout is a blocked page

Measured on 2026-09-17 against the installed build, with the panel closed: four
`preview_snapshot` calls returned a PNG in about 20 ms of desktop time each, so
the offscreen-guest story was wrong. Automation holds a surface activity lease
for the whole operation and waits for `data-preview-rendering="active"` before
it probes (`acquireBrowserSurfaceActivity` in
`apps/web/src/components/preview/PreviewAutomationHosts.tsx`), and that activity
is what keeps a hidden guest paintable:
`resolveHostedBrowserWebviewWrapperStyle`
(`apps/web/src/browser/hostedBrowserWebviewStyle.ts`) parks a rendering-active
guest at `(0,0)` behind the app rather than fully outside the window, which is
where Electron stops compositing.

The same run against a page holding its main thread in a 25 s `while` loop is
the failure: the desktop capture span `PreviewManager.automationSnapshot` ran
24,142 ms and then succeeded, while the broker had already failed the request at
its 15,000 ms timeout. The host's answer reached
`PreviewAutomationBroker.respond` 9 s after that and was dropped, so the agent
saw one sentence with no class in it.

Both halves of that are now bounded. Every post-readiness bridge call spends
what the readiness waits left of the request's host deadline (`raceBridgeCall`
in `apps/web/src/components/preview/previewAutomationHostBudget.ts`), so the
agent gets `PreviewAutomationBridgeTimeoutError` naming the operation and the
budget it had instead of the broker's generic timeout, and the snapshot tool
quotes our own failure message rather than hiding it
(`apps/server/src/mcp/McpHttpServer.ts`).

What the deadline does not do is cancel the capture. It only decides who answers
the agent: the guest keeps working, finishes on its own, and the broker drops the
late response. A page that blocks its main thread past the request budget still
cannot be snapshotted, and that is the page's problem to fix, not the host's.

The render check below is a measurement, not a screenshot.

## The render-check shape: a hidden 390 px iframe

Instead of resizing the tab to a phone width, mount a 390 px iframe inside the
page, point it at the same origin, and measure from inside it. The iframe gets
its own layout viewport, so CSS breakpoints, container queries, and wrapping all
resolve at 390 px without touching the host view.

```js
(async () => {
  const frame = document.createElement("iframe");
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:390px;height:844px;border:0;visibility:hidden";
  frame.src = location.pathname + location.search;
  document.body.appendChild(frame);
  try {
    await new Promise((resolve, reject) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.addEventListener("error", () => reject(new Error("iframe load failed")), {
        once: true,
      });
    });
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    await new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
    const box = (selector) => {
      const el = doc.querySelector(selector);
      if (!el) return null;
      const { x, y, width, height } = el.getBoundingClientRect();
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
    };
    return {
      viewport: { width: win.innerWidth, height: win.innerHeight },
      overflowX: doc.documentElement.scrollWidth > win.innerWidth,
      header: box("header"),
      cta: box("[data-testid='primary-cta']"),
    };
  } finally {
    frame.remove();
  }
})();
```

The expression is awaited (`awaitPromise` defaults to true) and the result is
returned as `{value: …}`. Keep what you return small: the serialized value is
capped at 64 KB, so measure the handful of elements the change is about rather
than dumping the tree.

Rules that make this recipe hold:

- **Same origin only.** `contentDocument` is null across origins. Point the
  iframe at a path on the page's own origin; a dev server preview always
  satisfies this.
- **Always remove the frame.** The check runs against the page the user is
  looking at. Leaving a frame mounted changes what they see and leaks a second
  copy of the app.
- **One `requestAnimationFrame` after load** is what makes the measurements
  post-layout. Anything longer is a sleep, and a check that needs a sleep to
  pass is measuring the wrong thing — wait on an element instead.

## What it does not cover

The iframe is a layout viewport, not a visual one. `100vh`/`100dvh` resolve to
the iframe's height, the URL bar and safe-area insets are absent, `position:
fixed` is relative to the frame, and code that reads `window.top` or
`visualViewport` sees the host page. It also produces no pixels, so it cannot
catch a colour, a font fallback, or a z-order mistake.

For those, take a real `preview_snapshot`. The panel does not have to be open.
