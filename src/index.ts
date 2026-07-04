#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: "screenshot-vision",
  version: "1.0.0",
});

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function startOllama(): Promise<void> {
  // MCP server processes inherit a minimal PATH from Claude Code that omits Homebrew.
  // Prepend common macOS install locations so the `ollama` binary can be found.
  const augmentedPath = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(":");

  let child;
  try {
    child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: augmentedPath },
    });
  } catch (err) {
    throw new Error(`Could not start Ollama (is it installed?): ${String(err)}`);
  }
  child.unref();

  // Poll until Ollama responds, up to 30 s.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await isOllamaRunning()) return;
  }
  throw new Error("Ollama did not become ready within 30 s after being started.");
}

async function ensureOllama(): Promise<void> {
  if (await isOllamaRunning()) return;
  await startOllama();
}

async function queryOllama(imageBase64: string, question: string, model: string): Promise<string> {
  await ensureOllama();

  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: question,
        images: [imageBase64],
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new Error(`Ollama request failed: ${String(err)}`);
  }

  if (!ollamaResponse.ok) {
    const body = await ollamaResponse.text();
    throw new Error(`Ollama returned ${ollamaResponse.status}: ${body}`);
  }

  const data = (await ollamaResponse.json()) as { response: string; error?: string };
  if (data.error) throw new Error(`Ollama model error: ${data.error}`);
  return data.response;
}

// Tool 1: Screenshot a URL in a fresh headless browser (no session/cookies)
server.tool(
  "analyze_screenshot",
  "Take a screenshot of a URL in a headless browser and analyze it with a local Ollama vision model. Good for public pages. For pages requiring login, use capture_window instead.",
  {
    url: z.string().url().describe("URL to screenshot (e.g. http://localhost:3004)"),
    question: z.string().describe("What to analyze or look for in the screenshot"),
    model: z.string().optional().default("gemma4:e4b").describe("Ollama vision model to use"),
    viewport_width: z.number().int().positive().optional().default(1280).describe("Viewport width in pixels"),
    viewport_height: z.number().int().positive().optional().default(800).describe("Viewport height in pixels"),
    wait_ms: z.number().int().min(0).optional().default(2000).describe("Milliseconds to wait after page load for JS rendering"),
  },
  async ({ url, question, model, viewport_width, viewport_height, wait_ms }) => {
    const browser = await chromium.launch({ headless: true });
    let imageBase64: string;

    try {
      const context = await browser.newContext({
        viewport: { width: viewport_width!, height: viewport_height! },
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (wait_ms! > 0) await page.waitForTimeout(wait_ms!);
      const buffer = await page.screenshot({ type: "png" });
      imageBase64 = buffer.toString("base64");
    } finally {
      await browser.close();
    }

    const analysis = await queryOllama(imageBase64, question, model!);
    return {
      content: [
        {
          type: "text" as const,
          text: `**Screenshot analysis of ${url}**\n\n**Question:** ${question}\n\n**Analysis (${model!}):**\n\n${analysis}`,
        },
      ],
    };
  }
);

// Tool 2: Capture a real on-screen app window (sees your actual logged-in session)
server.tool(
  "capture_window",
  "Capture a specific app window currently visible on screen and analyze it with a local Ollama vision model. Unlike analyze_screenshot, this sees your real browser with your logged-in session and live state — ideal for testing local apps.",
  {
    app_name: z.string().describe("Exact macOS app name, e.g. 'Google Chrome', 'Safari', 'Terminal', 'Cursor'"),
    question: z.string().describe("What to analyze or look for in the screenshot"),
    model: z.string().optional().default("gemma4:e4b").describe("Ollama vision model to use"),
    window_index: z.number().int().min(1).optional().default(1).describe("Which window to capture if the app has multiple (1 = frontmost)"),
    scale: z.number().int().min(1).max(4).optional().default(1).describe("Upscale factor applied before sending to the vision model. Use 2 or 3 for small terminal text or dense UIs."),
    crop: z.object({
      x: z.number().min(0).max(1).describe("Left edge as a fraction of window width (0–1)"),
      y: z.number().min(0).max(1).describe("Top edge as a fraction of window height (0–1)"),
      width: z.number().min(0).max(1).describe("Crop width as a fraction of window width (0–1)"),
      height: z.number().min(0).max(1).describe("Crop height as a fraction of window height (0–1)"),
    }).optional().describe("Crop to a sub-region before analysis. All values are fractions 0–1. E.g. bottom half: {x:0, y:0.5, width:1, height:0.5}"),
  },
  async ({ app_name, question, model, window_index, scale, crop }) => {
    // Ask macOS for the window's bounds: {left, top, right, bottom}
    let boundsStr: string;
    try {
      const result = await execFileAsync("osascript", [
        "-e",
        `tell application "${app_name}" to return bounds of window ${window_index!}`,
      ]);
      boundsStr = result.stdout.trim();
    } catch (err) {
      throw new Error(
        `Could not get window bounds for "${app_name}". Is it open? App name must match exactly (e.g. "Google Chrome" not "Chrome"). ${String(err)}`
      );
    }

    const parts = boundsStr.split(",").map(s => parseInt(s.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) {
      throw new Error(`Unexpected bounds format from osascript: "${boundsStr}"`);
    }
    const [left, top, right, bottom] = parts;
    const region = `${left},${top},${right - left},${bottom - top}`;

    // Bring the window to front, then capture just its region
    await execFileAsync("osascript", ["-e", `tell application "${app_name}" to activate`]);

    const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-mcp-"));
    const screenshotPath = join(tmpDir, "window.png");

    try {
      // -x suppresses the shutter sound/animation, -R captures a specific region
      await execFileAsync("screencapture", ["-x", "-R", region, screenshotPath]);

      // Get actual pixel dimensions of the captured image (Retina = 2x logical size)
      const sipsInfo = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", screenshotPath]);
      const widthMatch = sipsInfo.stdout.match(/pixelWidth: (\d+)/);
      const heightMatch = sipsInfo.stdout.match(/pixelHeight: (\d+)/);
      let imgWidth = widthMatch ? parseInt(widthMatch[1]) : right - left;
      let imgHeight = heightMatch ? parseInt(heightMatch[1]) : bottom - top;

      // Crop first so the scale step works on the smaller region
      if (crop) {
        const cropX = Math.round(crop.x * imgWidth);
        const cropY = Math.round(crop.y * imgHeight);
        const cropW = Math.round(crop.width * imgWidth);
        const cropH = Math.round(crop.height * imgHeight);
        await execFileAsync("sips", [
          "--cropToHeightWidth", String(cropH), String(cropW),
          "--cropOffset", String(cropY), String(cropX),
          screenshotPath, "--out", screenshotPath,
        ]);
        imgWidth = cropW;
        imgHeight = cropH;
      }

      // Scale up for better OCR on small text
      if (scale && scale > 1) {
        await execFileAsync("sips", [
          "-z", String(imgHeight * scale), String(imgWidth * scale),
          screenshotPath, "--out", screenshotPath,
        ]);
      }

      const imageBase64 = readFileSync(screenshotPath).toString("base64");
      const analysis = await queryOllama(imageBase64, question, model!);

      const modifiers = [
        crop ? `crop(x=${crop.x},y=${crop.y},w=${crop.width},h=${crop.height})` : null,
        scale && scale > 1 ? `scale=${scale}x` : null,
      ].filter(Boolean).join(", ");

      return {
        content: [
          {
            type: "text" as const,
            text: `**Window capture of "${app_name}"**${modifiers ? ` [${modifiers}]` : ""}\n\n**Question:** ${question}\n\n**Analysis (${model!}):**\n\n${analysis}`,
          },
        ],
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
