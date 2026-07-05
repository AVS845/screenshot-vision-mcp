# screenshot-vision-mcp

When reviewing a PR locally, you need to see if the UI looks right. Normally that means Claude takes a screenshot — which burns vision tokens and sends your screen contents to Anthropic. This MCP server routes screenshots through a **local Ollama vision model** instead: zero token cost, nothing leaves your machine.

| Tool | When to use |
|---|---|
| `analyze_screenshot` | Public or local URLs — headless browser, no session needed |
| `capture_window` | Any app window on screen — sees your real logged-in session |
| `locate_element` | Native macOS apps only — returns click coordinates without Claude seeing the image |

> **Chrome automation:** for clicking elements in Chrome, prefer `javascript_tool + getBoundingClientRect` — it's exact and requires no vision at all. See [Clicking in Chrome](#clicking-in-chrome).

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
npx playwright install chromium
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

Two optional env vars let you configure the server without touching call sites:

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama host |
| `OLLAMA_MODEL` | `gemma4:e4b` | Default vision model for all tools |

---

## Tools

### `analyze_screenshot`

Takes a screenshot of a URL in a headless Playwright browser and analyzes it with Ollama.

```
analyze_screenshot(
  url: "http://localhost:3004/dashboard",
  question: "Does the revenue chart render correctly? Are there any layout issues?"
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | URL to screenshot |
| `question` | string | — | What to analyze |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `viewport_width` | number | `1280` | Viewport width in px |
| `viewport_height` | number | `800` | Viewport height in px |
| `wait_ms` | number | `2000` | Wait after page load (ms) |
| `full_page` | boolean | `false` | Capture full page height, not just the visible viewport |
| `max_slices` | number | `8` | Max slices when `full_page` is true (1–20) |

When `full_page: true`, the page is sliced into `viewport_height`-tall segments and sent as multiple images. This matters because Gemma 4's image token budget is ~280 tokens — a single tall screenshot gets crushed into noise, while properly-proportioned slices each get full detail.

---

### `capture_window`

Captures an app window currently on screen and analyzes it. Use this when the page requires a login — it sees your real browser session.

```
capture_window(
  app_name: "Google Chrome",
  question: "Is the form validation error displaying correctly under the email field?"
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `app_name` | string | — | Exact macOS app name, e.g. `"Google Chrome"` |
| `question` | string | — | What to analyze |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `window_index` | number | `1` | Which window (1 = frontmost) |
| `scale` | number | `1` | Upscale factor (2–3 helps with small text) |
| `crop` | object | — | Crop to a sub-region before analysis |

The `crop` parameter uses fractional values (0–1). To inspect just the bottom half of the window:

```json
{ "x": 0, "y": 0.5, "width": 1, "height": 0.5 }
```

---

### `locate_element`

Finds a UI element in a native macOS app window and returns its click coordinates. Designed for apps where DOM access isn't available — Terminal, Figma, Xcode, etc.

> **Not recommended for Chrome.** Chrome's DOM gives exact coordinates with no vision model involved. See [Clicking in Chrome](#clicking-in-chrome).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `app_name` | string | — | Exact macOS app name, e.g. `"Figma"`, `"Terminal"` |
| `element_description` | string | — | Natural language description of the element |
| `model` | string | `gemma4:e4b` | Ollama vision model |
| `window_index` | number | `1` | Which window (1 = frontmost) |
| `viewport_bounds` | object | — | Screen-coordinate bounds of the region to capture |

Returns `{ x, y, coordinate_mode, clamped }`. `clamped: true` means the model returned out-of-range coordinates that were corrected — treat as low confidence.

**Accuracy note:** `gemma4:e4b` has a ~280-token image budget, which limits spatial precision. Elements in the center of the screen locate reliably; elements near edges may have 50–150px errors. Use a larger model (e.g. `gemma4:26b`) if precision matters, at the cost of slower inference.

---

## Clicking in Chrome

For Chrome browser automation, skip `locate_element` entirely. Use `javascript_tool` to get exact coordinates from the DOM:

```javascript
// In javascript_tool — returns perfect viewport coordinates, no vision needed
const el = document.querySelector('button.submit');
const r = el.getBoundingClientRect();
JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
```

Only fall back to `locate_element` for elements that genuinely can't be DOM-queried (canvas content, rendered images, visually-composed widgets without CSS selectors). When you do, pass `viewport_bounds` so the returned coordinates are viewport-relative and work directly with the Chrome `computer` tool.

**Measure viewport bounds immediately before the call** — the Chrome automation InfoBar shifts `innerHeight`, causing ~40px errors with stale bounds:

```javascript
// javascript_tool — run right before locate_element
JSON.stringify({
  screenX: window.screenX,
  screenY: window.screenY,
  outerHeight: window.outerHeight,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
})
```

```
locate_element(
  app_name: "Google Chrome",
  element_description: "the close button on the confirmation modal",
  viewport_bounds: {
    x: screenX,
    y: screenY + outerHeight - innerHeight,
    width: innerWidth,
    height: innerHeight,
  }
)
→ { x: 891, y: 267, coordinate_mode: "viewport" }
```

---

## How it works

1. **`analyze_screenshot`** launches a headless Chromium browser via Playwright, navigates to the URL, waits for JS to settle, and captures a PNG.
2. **`capture_window`** uses AppleScript to get the window bounds, `screencapture -R` to grab exactly that region, and optionally `sips` to crop and scale.
3. **`locate_element`** captures the specified region, asks Ollama to return element coordinates as JSON fractions (0–1), then converts to pixel coordinates.
4. All tools base64-encode the PNG and POST it to Ollama's `/api/generate` endpoint.
5. If Ollama isn't running, the server spawns `ollama serve` and waits up to 30 seconds for it to become ready.

---

## Rebuilding after changes

```bash
npm run build
```

Then restart Claude Code to reload the server.
