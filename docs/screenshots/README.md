# README captures

The README uses a focused request card from the development preview, rendered
by Chrome through agent-browser. The SVGs contain vector paths, including
outlined text, so they display without local fonts or embedded HTML.

Start the Vite development server and open `/?preview` with agent-browser.
Use a 440px viewport and stage the card with the script in this directory:

```sh
agent-browser --session readme-demo set viewport 440 850
agent-browser --session readme-demo wait 'article'
agent-browser --session readme-demo eval --stdin < docs/screenshots/stage.js
```

The staging script clones the rendered card, inserts fictional release-request
metadata, and freezes its timestamps and animations. It omits the card's faint box shadow,
which Chrome rasterizes during printing. It changes only the browser
DOM. Reload the preview before staging another capture.

Capture each theme as a PDF, preserving Chrome's vector rendering:

```sh
agent-browser --session readme-demo eval 'document.documentElement.dataset.theme = "light"'
agent-browser --session readme-demo pdf /tmp/request-context-light.pdf
agent-browser --session readme-demo eval 'document.documentElement.dataset.theme = "dark"'
agent-browser --session readme-demo pdf /tmp/request-context-dark.pdf

uv run --with pymupdf python docs/screenshots/export.py \
  /tmp/request-context-light.pdf docs/images/request-context-light.svg
uv run --with pymupdf python docs/screenshots/export.py \
  /tmp/request-context-dark.pdf docs/images/request-context-dark.svg
```

The converter crops Chrome's printed page to the demo frame. To compare the
export against the screen rendering, capture the frame directly:

```sh
agent-browser --session readme-demo screenshot '#readme-capture' /tmp/request-context.png
```
