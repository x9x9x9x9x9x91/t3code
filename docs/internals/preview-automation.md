# Preview automation on a hidden tab

The preview tools (`preview_snapshot`, `preview_resize`, `preview_evaluate`, …)
drive a real Electron `WebContentsView` through CDP. When the preview panel is
closed the tab still exists and still runs script, but it is parked offscreen and
Chromium stops compositing it. Two consequences shape every render check an agent
writes:

- `preview_snapshot` depends on a composited frame. On a hidden tab the capture
  retries and gives up, so an agent that only knows how to look at pixels is
  blocked whenever the user has the panel closed.
- `preview_resize` resizes the host view, and the host then waits for the
  renderer to report the new viewport. That wait costs the request's whole
  budget when nothing is painting.

`preview_evaluate` keeps working, because script execution does not need a
composited frame. So the interim render check is a measurement, not a screenshot.

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

For those, ask the user to open the preview panel and take a real
`preview_snapshot`.
