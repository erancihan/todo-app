/**
 * Phase 0 headless runner (throwaway).
 *
 * Boots the spike dev server, drives both pages in Chromium, and reports the
 * assertions they made. Exits non-zero if any check failed, so this is usable as
 * a gate rather than something a human has to eyeball.
 *
 *   npm run test:headless            # both pages
 *   npm run test:headless -- cm6     # one page
 *
 * Chromium only here — that covers the Chromium engine family (WebView2, Android
 * System WebView, evergreen Chrome/Edge). **WebKit (WKWebView, iOS/macOS) is not
 * covered by this runner** and must be driven by hand; see spikes/mobile-README.md.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

/**
 * Find a usable Chromium without downloading one.
 *
 * Set CHROMIUM_PATH to override. Otherwise we look for a browser already on the
 * machine — Playwright pins an exact build number per release, and a preinstalled
 * Chromium is usually a different one; the engine is what matters here, not the
 * revision, so we point at whatever is present.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (existsSync(root)) {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("chromium"))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const candidate = join(root, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
  }
  return null; // fall back to Playwright's own resolution
}

const PORT = 5174;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES = {
  cm6: { path: "/cm6-keymap/", label: "Spike 3 — CodeMirror 6 keymap" },
  wasm: { path: "/wasm-opfs/", label: "Spike 2 — core on wasm32 + sqlite-wasm/OPFS" },
};

const requested = process.argv.slice(2).filter((a) => a in PAGES);
const selected = requested.length ? requested : Object.keys(PAGES);

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`dev server did not come up at ${url}`);
}

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

let exitCode = 0;

try {
  await waitForServer(BASE + PAGES[selected[0]].path);

  const executablePath = findChromium();
  console.log(`chromium: ${executablePath ?? "(playwright default)"}`);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--enable-features=FileSystemAccessAPI"],
  });

  for (const name of selected) {
    const { path, label } = PAGES[name];
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await page.goto(BASE + path, { waitUntil: "load" });

    let result = null;
    try {
      await page.waitForFunction(() => window.__SPIKE_RESULT__ !== undefined, { timeout: 45_000 });
      result = await page.evaluate(() => window.__SPIKE_RESULT__);
    } catch {
      /* handled below */
    }

    console.log(`\n=== ${label} ===`);
    console.log(`    ${BASE}${path}`);

    if (!result) {
      console.log("    NO RESULT — the page never published __SPIKE_RESULT__");
      consoleErrors.forEach((e) => console.log(`    console: ${e}`));
      exitCode = 1;
      await context.close();
      continue;
    }

    for (const c of result.checks) {
      console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
      if (!c.passed && c.detail) {
        console.log(
          c.detail
            .split("\n")
            .map((l) => `        ${l}`)
            .join("\n"),
        );
      }
    }
    console.log(`  -> ${result.total - result.failed}/${result.total} passed`);

    if (result.failed > 0) exitCode = 1;
    if (consoleErrors.length) {
      console.log("  console errors:");
      consoleErrors.forEach((e) => console.log(`    ${e}`));
    }

    await context.close();
  }

  await browser.close();
} catch (err) {
  console.error(`\nharness error: ${err.message}`);
  exitCode = 1;
} finally {
  server.kill("SIGTERM");
}

console.log(exitCode === 0 ? "\nAll selected spike pages passed." : "\nFAILURES — see above.");
process.exit(exitCode);
