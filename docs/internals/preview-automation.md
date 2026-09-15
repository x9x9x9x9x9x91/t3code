# Preview automation on a hidden tab

The preview tools (`preview_snapshot`, `preview_resize`, `preview_evaluate`, …)
drive a real Electron `WebContentsView` through CDP. With the preview panel
closed the tab still exists and still runs script, so `preview_evaluate` keeps
working: script execution needs no composited frame. `preview_snapshot` is the
one that fails there, and why is still open.

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

## The snapshot failure is unexplained

The obvious story — panel closed, so the guest is offscreen, so capture fails —
is not established, and the code argues against it. Automation takes a surface
activity lease for the whole operation and releases it in a `finally`
(`acquireBrowserSurfaceActivity` in `apps/web/src/components/preview/PreviewAutomationHosts.tsx`),
and it waits for the wrapper to report `data-preview-rendering="active"` before
probing. That activity is what keeps a hidden guest paintable:
`resolveHostedBrowserWebviewWrapperStyle` (`apps/web/src/browser/hostedBrowserWebviewStyle.ts`)
parks a rendering-active guest at `(0,0)` behind the app exactly because Electron
stops compositing a guest that sits fully outside the window.

What was observed, on 2026-09-14 with the panel closed: five `preview_snapshot`
calls failed in 6–14 s each and the agent saw only `Preview snapshot failed.`
The snapshot failure path puts the error class in `structuredContent` but not in
the text (`apps/server/src/mcp/McpHttpServer.ts`), and the server traces from
that day have rotated, so the class behind those five is unrecoverable. Capture
never starting, `capturePage` rejecting or stalling through all three attempts,
and the request simply losing to the broker timeout are all still open.

Settling it needs a live run against the installed app, which takes separate
authorisation: capture the same page and build twice, once hidden and once visible,
and record per capture attempt — correlated request id and runtime tab id, the
surface lease and `data-preview-rendering` state during the request, elapsed time
to overlay readiness, CDP evaluation and AX-tree time, each `capturePage` attempt
and its outcome, and the concrete desktop failure class. That distinguishes
capture that never starts from capture that fails, stalls, or succeeds after the
broker has given up. Verify any fix with a returned image, not a unit test.

Until then the render check below is a measurement, not a screenshot.

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

For those, ask the user to open the preview panel and try a real
`preview_snapshot` — whether an open panel is what makes capture work is the
open question above.
