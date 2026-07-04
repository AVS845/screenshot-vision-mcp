# screenshot-vision-mcp

An MCP server for Claude Code that takes screenshots and analyzes them with a **local Ollama vision model** — no image data ever leaves your machine, and it costs zero vision tokens.

Three tools are provided:

| Tool | When to use |
|---|---|
| `analyze_screenshot` | Public or local URLs — opens a headless browser, no session |
| `capture_window` | Any app window on screen — sees your real logged-in session |
| `locate_element` | Find a UI element and return click coordinates — Claude never sees the image |

---

## Requirements

- macOS (window capture uses `screencapture` and AppleScript)
- Node.js 22+
- [Ollama](https://ollama.com) installed (the server auto-starts it if it isn't running)
- A multimodal Ollama model — default is `gemma4:e4b`:
  ```
  ollama pull gemma4:e4b
  ```

---

## Installation

```bash
git clone git@github.com:AVS845/screenshot-vision-mcp.git
cd screenshot-vision-mcp
npm install
npm run build
```

---

## Claude Code configuration

Add this to your `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "screenshot-vision": {
      "command": "node",
      "args": ["/absolute/path/to/screenshot-vision-mcp/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/` with the actual path. Then restart Claude Code.

To use a different Ollama host, add an env override:

```json
{
  "mcpServers": {
    "screenshot-vision": {
      "command": "node",
      "args": ["/absolute/path/to/screenshot-vision-mcp/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://192.168.1.10:11434"
      }
    }
  }
}
```

---

## Tools

### `analyze_screenshot`

Takes a screenshot of a URL in a headless Playwright browser and analyzes it.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | URL to screenshot |
| `question` | string | — | What to analyze |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `viewport_width` | number | `1280` | Viewport width in px |
| `viewport_height` | number | `800` | Viewport height in px |
| `wait_ms` | number | `2000` | Wait after page load (ms) |

### `capture_window`

Captures a specific app window currently on screen and analyzes it. Useful for testing local apps where you're already logged in.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `app_name` | string | — | Exact macOS app name, e.g. `"Google Chrome"` |
| `question` | string | — | What to analyze |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `window_index` | number | `1` | Which window (1 = frontmost) |
| `scale` | number | `1` | Upscale factor (2–3 helps with small text) |
| `crop` | object | — | Crop to a sub-region before analysis |

The `crop` parameter takes fractional values (0–1):

```json
{ "x": 0, "y": 0.5, "width": 1, "height": 0.5 }
```

That example crops to the bottom half of the window.

### `locate_element`

Finds a UI element in an app window and returns its click coordinates. Ollama does the visual work — Claude never sees the image.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `app_name` | string | — | Exact macOS app name, e.g. `"Google Chrome"` |
| `element_description` | string | — | Natural language description of the element to find |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `window_index` | number | `1` | Which window (1 = frontmost) |
| `zoom` | boolean | `false` | Two-pass refinement — first finds a rough bounding box, then crops and refines. Recommended for small targets like close buttons |
| `viewport_bounds` | object | — | Screen-coordinate bounds of the region to capture (see Chrome usage below) |

Returns `{ x, y, coordinate_mode }` where `coordinate_mode` is `"viewport"` (when `viewport_bounds` is passed) or `"screen"`.

#### Usage with Google Chrome

The Chrome `computer` tool uses viewport-relative coordinates. Pass `viewport_bounds` so the returned `{x, y}` can be used directly.

**Prefer `getBoundingClientRect` for standard HTML elements** — it's exact and requires no image:

```javascript
// javascript_tool → perfect viewport coordinates, no vision needed
const el = document.querySelector('button.submit');
const r = el.getBoundingClientRect();
JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
```

Use `locate_element` for elements that can't be DOM-queried (canvas, rendered images, visually-composed widgets).

When using `locate_element` with Chrome, **measure viewport bounds immediately before the call** — the Chrome automation InfoBar temporarily reduces `innerHeight`, causing ~40px y-offset errors if you use stale bounds:

```javascript
// javascript_tool — run this right before locate_element, not once per session
JSON.stringify({
  screenX: window.screenX,
  screenY: window.screenY,
  outerHeight: window.outerHeight,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
})
```

Then call `locate_element`:

```
locate_element(
  app_name: "Google Chrome",
  element_description: "the X close button in the top-right of the modal",
  zoom: true,
  viewport_bounds: {
    x: screenX,
    y: screenY + outerHeight - innerHeight,
    width: innerWidth,
    height: innerHeight,
  }
)
→ { x: 891, y: 267, coordinate_mode: "viewport" }
```

Pass `x`/`y` directly to the Chrome `computer` tool's click action.

---

## How it works

1. **`analyze_screenshot`** launches a headless Chromium browser via Playwright, navigates to the URL, waits for JS to settle, and captures a PNG.
2. **`capture_window`** uses AppleScript to get the window bounds, `screencapture -R` to grab exactly that region, and optionally `sips` to crop and scale.
3. **`locate_element`** captures the specified region (or full window), asks Ollama to return element coordinates as JSON fractions (0–1), then converts to pixel coordinates. With `zoom: true`, it does a two-pass crop for higher accuracy.
4. All tools base64-encode the PNG and POST it to Ollama's `/api/generate` endpoint.
5. If Ollama isn't running, the server spawns `ollama serve` and waits up to 30 seconds for it to become ready.

---

## Rebuilding after changes

```bash
npm run build
```

Then restart Claude Code to reload the server.
