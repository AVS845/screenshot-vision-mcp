# screenshot-vision-mcp

An MCP server for Claude Code that takes screenshots and analyzes them with a **local Ollama vision model** — no image data ever leaves your machine, and it costs zero vision tokens.

Two tools are provided:

| Tool | When to use |
|---|---|
| `analyze_screenshot` | Public or local URLs — opens a headless browser, no session |
| `capture_window` | Any app window on screen — sees your real logged-in session |

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

---

## How it works

1. **`analyze_screenshot`** launches a headless Chromium browser via Playwright, navigates to the URL, waits for JS to settle, and captures a PNG.
2. **`capture_window`** uses AppleScript to get the window bounds, `screencapture -R` to grab exactly that region, and optionally `sips` to crop and scale.
3. Both tools base64-encode the PNG and POST it to Ollama's `/api/generate` endpoint along with your question.
4. If Ollama isn't running, the server spawns `ollama serve` and waits up to 30 seconds for it to become ready.

---

## Rebuilding after changes

```bash
npm run build
```

Then restart Claude Code to reload the server.
