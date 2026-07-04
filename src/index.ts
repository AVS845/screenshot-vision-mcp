#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync } from "fs";
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

async function ensureModel(model: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return; // Ollama unreachable — let the generate call surface the error
  }
  if (!res.ok) return;
  const data = (await res.json()) as { models?: { name: string }[] };
  const available = (data.models ?? []).map(m => m.name);
  const found = available.some(name => name === model || name.startsWith(`${model}:`));
  if (!found) {
    throw new Error(
      `Model "${model}" is not available in Ollama. Run: ollama pull ${model}\n` +
      `Available models: ${available.length ? available.join(", ") : "(none)"}`
    );
  }
}

async function queryOllama(imageBase64: string | string[], question: string, model: string): Promise<string> {
  await ensureOllama();
  await ensureModel(model);

  const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
  // Allow 60 s base + 30 s per image so multi-slice full-page requests don't time out.
  const timeoutMs = (60 + images.length * 30) * 1000;

  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: question,
        images,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
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

async function queryOllamaJson<T>(imageBase64: string, prompt: string, model: string): Promise<T> {
  await ensureOllama();
  await ensureModel(model);

  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        images: [imageBase64],
        stream: false,
        format: "json",
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

  try {
    return JSON.parse(data.response) as T;
  } catch {
    throw new Error(`Ollama returned invalid JSON: ${data.response.slice(0, 200)}`);
  }
}

// Brings appName to the front only if it isn't already frontmost, runs fn (which should
// call screencapture), then immediately restores the previous frontmost app so the user's
// focus is not disrupted. Restores before Ollama processing, not after, so the window
// flash is as short as possible.
async function withFocus<T>(appName: string, fn: () => Promise<T>): Promise<T> {
  let previousApp: string | null = null;

  try {
    const result = await execFileAsync("osascript", [
      "-e", "tell application \"System Events\" to return name of first process whose frontmost is true",
    ]);
    const current = result.stdout.trim();
    if (current.toLowerCase() !== appName.toLowerCase()) {
      previousApp = current;
      await execFileAsync("osascript", ["-e", `tell application "${appName}" to activate`]);
      // Brief wait for the window to finish coming forward before screencapture fires.
      await new Promise(r => setTimeout(r, 150));
    }
  } catch {
    // If we can't determine the frontmost app, activate unconditionally.
    await execFileAsync("osascript", ["-e", `tell application "${appName}" to activate`]);
  }

  try {
    return await fn();
  } finally {
    if (previousApp) {
      try {
        await execFileAsync("osascript", ["-e", `tell application "${previousApp}" to activate`]);
      } catch {
        // Ignore — restoring focus is best-effort.
      }
    }
  }
}

// Tool 1: Screenshot a URL in a fresh headless browser (no session/cookies)
server.tool(
  "analyze_screenshot",
  "Take a screenshot of a URL in a headless browser and analyze it with a local Ollama vision model. Good for public pages. For pages requiring login, use capture_window instead. Use full_page: true to capture content below the fold — the page is sliced into segments and sent as multiple images so no detail is lost.",
  {
    url: z.string().url().describe("URL to screenshot (e.g. http://localhost:3004)"),
    question: z.string().describe("What to analyze or look for in the screenshot"),
    model: z.string().optional().default("gemma4:e4b").describe("Ollama vision model to use"),
    viewport_width: z.number().int().positive().optional().default(1280).describe("Viewport width in pixels"),
    viewport_height: z.number().int().positive().optional().default(800).describe("Viewport height in pixels"),
    wait_ms: z.number().int().min(0).optional().default(2000).describe("Milliseconds to wait after page load for JS rendering"),
    full_page: z.boolean().optional().default(false).describe("Capture the full page height, not just the visible viewport. Long pages are sliced into segments sent as multiple images so detail is preserved at every scroll depth."),
    max_slices: z.number().int().min(1).max(20).optional().default(8).describe("Maximum number of slices when full_page is true. Slices are distributed evenly across the page height. Default 8 covers most pages well."),
  },
  async ({ url, question, model, viewport_width, viewport_height, wait_ms, full_page, max_slices }) => {
    const browser = await chromium.launch({ headless: true });
    let images: string[];
    let sliceCount = 1;

    try {
      const context = await browser.newContext({
        viewport: { width: viewport_width!, height: viewport_height! },
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (wait_ms! > 0) await page.waitForTimeout(wait_ms!);

      if (!full_page) {
        const buffer = await page.screenshot({ type: "png" });
        images = [buffer.toString("base64")];
      } else {
        // Scroll through the page in viewport-height steps before capturing so that
        // lazy-loaded images and sections have a chance to load. Then scroll back to
        // the top so the final screenshot starts from position 0.
        const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
        const step = viewport_height!;
        for (let y = step; y < scrollHeight; y += step) {
          await page.evaluate((pos) => window.scrollTo(0, pos), y);
          await page.waitForTimeout(150);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);

        const fullBuffer = await page.screenshot({ type: "png", fullPage: true });
        const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-mcp-full-"));
        try {
          const fullPagePath = join(tmpDir, "full.png");
          writeFileSync(fullPagePath, fullBuffer);

          const sipsInfo = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", fullPagePath]);
          const wMatch = sipsInfo.stdout.match(/pixelWidth: (\d+)/);
          const hMatch = sipsInfo.stdout.match(/pixelHeight: (\d+)/);
          const imgWidth = wMatch ? parseInt(wMatch[1]) : viewport_width!;
          const pageHeight = hMatch ? parseInt(hMatch[1]) : viewport_height!;
          const sliceH = viewport_height!;

          if (pageHeight <= sliceH) {
            // Page fits in one viewport — no slicing needed
            images = [fullBuffer.toString("base64")];
          } else {
            // Distribute N slices evenly across the full page height.
            // Ollama locks Gemma 4 to a 280-token image budget, so a single tall image
            // loses most of its detail. Sending N properly-proportioned slices avoids this.
            const N = Math.min(max_slices!, Math.ceil(pageHeight / sliceH));
            const stride = N > 1 ? Math.floor((pageHeight - sliceH) / (N - 1)) : 0;

            const sliceBase64s: string[] = [];
            for (let i = 0; i < N; i++) {
              const offsetY = i === N - 1 ? Math.max(0, pageHeight - sliceH) : i * stride;
              const actualH = Math.min(sliceH, pageHeight - offsetY);
              const slicePath = join(tmpDir, `slice_${i}.png`);
              copyFileSync(fullPagePath, slicePath);
              await execFileAsync("sips", [
                "--cropToHeightWidth", String(actualH), String(imgWidth),
                "--cropOffset", String(offsetY), "0",
                slicePath, "--out", slicePath,
              ]);
              sliceBase64s.push(readFileSync(slicePath).toString("base64"));
            }
            images = sliceBase64s;
            sliceCount = N;
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    } finally {
      await browser.close();
    }

    // Prepend slice context so the model knows it's reading a sequence of page segments.
    const effectiveQuestion = sliceCount > 1
      ? `You are analyzing ${sliceCount} slices of a full web page, ordered top to bottom. Slice 1 is the topmost portion and slice ${sliceCount} is the bottommost.\n\n${question}`
      : question;

    const analysis = await queryOllama(images, effectiveQuestion, model!);
    const label = sliceCount > 1 ? ` [full-page, ${sliceCount} slices]` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `**Screenshot analysis of ${url}**${label}\n\n**Question:** ${question}\n\n**Analysis (${model!}):**\n\n${analysis}`,
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

    const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-mcp-"));
    const screenshotPath = join(tmpDir, "window.png");

    try {
      // Activate only if needed; restore previous focus immediately after capture.
      await withFocus(app_name, () =>
        execFileAsync("screencapture", ["-x", "-R", region, screenshotPath])
      );

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

// Tool 3: Find a UI element and return click coordinates — Claude never sees the image
server.tool(
  "locate_element",
  "Find a UI element in an app window and return its click coordinates. Uses a local Ollama vision model — Claude never sees the image. " +
  "For Google Chrome, pass viewport_bounds (computed from javascript_tool: {x: screenX, y: screenY + outerHeight - innerHeight, width: innerWidth, height: innerHeight}) " +
  "to get viewport-relative coordinates usable directly with the Chrome computer tool. Without viewport_bounds, returns absolute screen coordinates.",
  {
    app_name: z.string().describe("Exact macOS app name, e.g. 'Google Chrome', 'Safari', 'Terminal', 'Cursor'"),
    element_description: z.string().describe("Natural language description of the element to find, e.g. 'the X close button in the top-right of the modal'"),
    model: z.string().optional().default("gemma4:e4b").describe("Ollama vision model to use"),
    window_index: z.number().int().min(1).optional().default(1).describe("Which window to capture if the app has multiple (1 = frontmost)"),
    zoom: z.boolean().optional().default(false).describe("Two-pass zoom: first locate a rough bounding box, then crop and refine. More accurate for small elements like close buttons or icons."),
    viewport_bounds: z.object({
      x: z.number().describe("Left edge of viewport in screen coordinates"),
      y: z.number().describe("Top edge of viewport in screen coordinates"),
      width: z.number().describe("Viewport width in logical pixels"),
      height: z.number().describe("Viewport height in logical pixels"),
    }).optional().describe(
      "Screen-coordinate bounds of the region to capture (e.g. Chrome's content area). " +
      "For Chrome: compute as {x: screenX, y: screenY + outerHeight - innerHeight, width: innerWidth, height: innerHeight} " +
      "using window.screenX/Y/outerWidth/outerHeight/innerWidth/innerHeight from javascript_tool. " +
      "When provided, returned coordinates are relative to this region's (0,0) — viewport-relative for Chrome."
    ),
  },
  async ({ app_name, element_description, model, window_index, zoom, viewport_bounds }) => {
    // --- Determine capture region ---
    // If viewport_bounds is provided, capture exactly that region and return coords relative to its (0,0).
    // Otherwise, fall back to full window bounds and return absolute screen coordinates.

    let captureLeft: number;
    let captureTop: number;
    let captureWidth: number;
    let captureHeight: number;
    let coordinateMode: "viewport" | "screen";

    if (viewport_bounds) {
      captureLeft = viewport_bounds.x;
      captureTop = viewport_bounds.y;
      captureWidth = viewport_bounds.width;
      captureHeight = viewport_bounds.height;
      coordinateMode = "viewport";
    } else {
      let boundsStr: string;
      try {
        const result = await execFileAsync("osascript", [
          "-e", `tell application "${app_name}" to return bounds of window ${window_index!}`,
        ]);
        boundsStr = result.stdout.trim();
      } catch (err) {
        throw new Error(
          `Could not get window bounds for "${app_name}". Is it open? App name must match exactly. ${String(err)}`
        );
      }
      const p = boundsStr.split(",").map(s => parseInt(s.trim(), 10));
      if (p.length !== 4 || p.some(isNaN)) throw new Error(`Unexpected bounds format: "${boundsStr}"`);
      captureLeft = p[0]; captureTop = p[1];
      captureWidth = p[2] - p[0]; captureHeight = p[3] - p[1];
      coordinateMode = "screen";
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-mcp-locate-"));
    const screenshotPath = join(tmpDir, "capture.png");

    try {
      const region = `${captureLeft},${captureTop},${captureWidth},${captureHeight}`;
      // Activate only if needed; restore previous focus immediately after capture.
      await withFocus(app_name, () =>
        execFileAsync("screencapture", ["-x", "-R", region, screenshotPath])
      );

      // Physical pixel dimensions (Retina = 2× logical)
      const sipsInfo = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", screenshotPath]);
      const wMatch = sipsInfo.stdout.match(/pixelWidth: (\d+)/);
      const hMatch = sipsInfo.stdout.match(/pixelHeight: (\d+)/);
      const imgWidth = wMatch ? parseInt(wMatch[1]) : captureWidth;
      const imgHeight = hMatch ? parseInt(hMatch[1]) : captureHeight;

      let fracX: number;
      let fracY: number;
      let confidence: string | undefined;

      if (zoom) {
        // Pass 1 — rough bounding box
        const roughPrompt =
          `Find this UI element in the screenshot: "${element_description}"\n\n` +
          `Return ONLY valid JSON (no other text):\n` +
          `{"x": <left edge 0-1>, "y": <top edge 0-1>, "width": <width 0-1>, "height": <height 0-1>}\n\n` +
          `x=0 is left, x=1 is right, y=0 is top, y=1 is bottom. Cover the element with some padding.`;

        const rough = await queryOllamaJson<{ x: number; y: number; width: number; height: number }>(
          readFileSync(screenshotPath).toString("base64"), roughPrompt, model!
        );

        const rx = Math.max(0, Math.min(0.99, rough.x ?? 0));
        const ry = Math.max(0, Math.min(0.99, rough.y ?? 0));
        const rw = Math.max(0.01, Math.min(1 - rx, rough.width ?? 0.1));
        const rh = Math.max(0.01, Math.min(1 - ry, rough.height ?? 0.1));

        // Crop to the rough region for a closer look
        const cropX = Math.round(rx * imgWidth);
        const cropY = Math.round(ry * imgHeight);
        const cropW = Math.max(1, Math.round(rw * imgWidth));
        const cropH = Math.max(1, Math.round(rh * imgHeight));

        const croppedPath = join(tmpDir, "cropped.png");
        copyFileSync(screenshotPath, croppedPath);
        await execFileAsync("sips", [
          "--cropToHeightWidth", String(cropH), String(cropW),
          "--cropOffset", String(cropY), String(cropX),
          croppedPath, "--out", croppedPath,
        ]);

        // Pass 2 — precise center within the crop
        const precisePrompt =
          `This is a zoomed-in region of a UI screenshot. Find: "${element_description}"\n\n` +
          `Return ONLY valid JSON (no other text):\n` +
          `{"found": true|false, "x": <center x 0-1>, "y": <center y 0-1>, "confidence": "high"|"medium"|"low"}\n\n` +
          `x=0 is left, x=1 is right, y=0 is top, y=1 is bottom of THIS cropped image. Return the CENTER of the element. ` +
          `Set found to false if the element is not visible.`;

        const precise = await queryOllamaJson<{ found?: boolean; x: number; y: number; confidence?: string }>(
          readFileSync(croppedPath).toString("base64"), precisePrompt, model!
        );

        if (precise.found === false) {
          throw new Error(`Element not found: "${element_description}"`);
        }

        const px = Math.max(0, Math.min(1, precise.x ?? 0.5));
        const py = Math.max(0, Math.min(1, precise.y ?? 0.5));

        // Convert crop-relative fractions back to full-capture fractions
        fracX = rx + px * rw;
        fracY = ry + py * rh;
        confidence = precise.confidence;
      } else {
        // Single pass
        const prompt =
          `Find this UI element in the screenshot: "${element_description}"\n\n` +
          `Return ONLY valid JSON (no other text):\n` +
          `{"found": true|false, "x": <center x 0-1>, "y": <center y 0-1>, "confidence": "high"|"medium"|"low"}\n\n` +
          `x=0 is left, x=1 is right, y=0 is top, y=1 is bottom. Return the CENTER point of the element. ` +
          `Set found to false if the element is not visible.`;

        const result = await queryOllamaJson<{ found?: boolean; x: number; y: number; confidence?: string }>(
          readFileSync(screenshotPath).toString("base64"), prompt, model!
        );

        if (result.found === false) {
          throw new Error(`Element not found: "${element_description}"`);
        }

        fracX = Math.max(0, Math.min(1, result.x ?? 0.5));
        fracY = Math.max(0, Math.min(1, result.y ?? 0.5));
        confidence = result.confidence;
      }

      // Convert fractions to output coordinates.
      // Retina scale cancels out: fractions of physical pixels = fractions of logical pixels.
      let x: number;
      let y: number;

      if (coordinateMode === "viewport") {
        // Relative to the captured region's (0,0) — viewport coordinates for Chrome
        x = Math.round(fracX * captureWidth);
        y = Math.round(fracY * captureHeight);
      } else {
        // Absolute screen coordinates
        x = Math.round(captureLeft + fracX * captureWidth);
        y = Math.round(captureTop + fracY * captureHeight);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ x, y, coordinate_mode: coordinateMode, ...(confidence ? { confidence } : {}) }),
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
