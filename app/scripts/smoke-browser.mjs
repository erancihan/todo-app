/**
 * Browser smoke test for the Phase 1 capture loop.
 *
 * Drives the real app in headless Chromium against the real wasm engine and real
 * OPFS — no mocks, no stubs. "It compiles" is not evidence that a keystroke
 * reaches Rust and a row comes back, and that gap is exactly where the Phase 0
 * Tauri script reported a false pass.
 *
 * Exits non-zero on any failure, so it is usable as a CI gate.
 *
 *   node scripts/smoke-browser.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const PORT = 1421;
const BASE = `http://127.0.0.1:${PORT}`;

/** Find a Chromium already on the machine rather than downloading one. */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const candidate = join(root, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail && !passed ? `\n        ${detail}` : ""}`);
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`dev server never came up at ${url}`);
}

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

let exitCode = 0;

try {
  await waitForServer(BASE);
  const executablePath = findChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(BASE, { waitUntil: "load" });

  // --- the engine boots at all -------------------------------------------
  const list = page.locator("[data-list]");
  await list.waitFor({ timeout: 60_000 });

  const runtime = await page
    .locator("header span")
    .textContent({ timeout: 30_000 })
    .catch(() => null);
  check("wasm engine reports its runtime", runtime === "wasm/browser", `got ${runtime}`);

  // The app opens a capture line on an empty store, so a row must exist.
  await page.locator("li[role=treeitem]").first().waitFor({ timeout: 30_000 });
  check("an initial capture row is open", true);

  // --- capture: type a body, Ctrl+Enter, repeat --------------------------
  const editor = page.locator(".cm-content");
  await editor.waitFor({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type("Ship EOD report v1");
  // Enter must insert a newline, not submit.
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  const twoLines = await page.locator(".cm-line").count();
  check("Enter inserts a newline in the body", twoLines >= 2, `${twoLines} lines`);

  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(700);
  const afterSubmit = await page.locator("li[role=treeitem]").count();
  check("Ctrl+Enter submits and opens the next line", afterSubmit >= 2, `${afterSubmit} rows`);

  await page.keyboard.type("Second todo");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(700);

  // --- LIST mode verbs ----------------------------------------------------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  const mode = await page.locator("[data-mode-pill]").textContent();
  check("Esc returns to LIST mode", mode === "LIST", `mode = ${mode}`);

  // Exactly two captures should leave exactly two rows. This is the check that
  // catches double-dispatch (Ctrl+Enter handled by both CodeMirror and the
  // window listener produced a spare blank row every time) and abandoned
  // capture rows.
  const rowsAfterCapture = await page.locator("li[role=treeitem]").count();
  check(
    "two captures leave exactly two rows",
    rowsAfterCapture === 2,
    `${rowsAfterCapture} rows — expected 2, extras are blank capture rows`,
  );

  const titles = await page.locator("li[role=treeitem] span.truncate").allTextContents();
  check(
    "the row title is derived without markdown syntax",
    titles[0] === "Ship EOD report v1",
    `got ${JSON.stringify(titles)}`,
  );

  // The wasm boundary must hand `null` to JS for an absent value, not
  // `undefined` — `serde_wasm_bindgen` defaults to the latter while the Tauri
  // host produces the former, and the shared UI does `=== null` tests that then
  // answer differently on each host. This is a contract check, not a UI one.
  const optionals = await page.evaluate(() => {
    const root = window.Alpine.$data(document.getElementById("app")).state.nodes[0];
    return { parentId: root.parentId, dueAt: root.dueAt, completedAt: root.completedAt };
  });
  check(
    "absent fields cross the wasm boundary as null, not undefined",
    optionals.parentId === null && optionals.dueAt === null && optionals.completedAt === null,
    `got ${JSON.stringify(Object.entries(optionals).map(([k, v]) => `${k}=${v === undefined ? "undefined" : v}`))}`,
  );

  // `x` toggles done on the focused row.
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await page.waitForTimeout(200);
  await page.keyboard.press("x");
  await page.waitForTimeout(700);
  const doneCount = await page.locator("li .line-through").count();
  check("x toggles done", doneCount >= 1, `${doneCount} struck-through rows`);

  // `t` opens the tag editor and applies a tag.
  await page.keyboard.press("t");
  await page.waitForTimeout(400);
  await page.keyboard.type("urgent");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const tagCount = await page.locator("li [class*='tag-']").count();
  check("t applies a tag", tagCount > 0, `${tagCount} chips`);

  // `d d` deletes, `u` puts it back — the two-key sequence and undo together.
  const beforeDelete = await page.locator("li[role=treeitem]").count();
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await page.waitForTimeout(900);
  const afterDelete = await page.locator("li[role=treeitem]").count();
  check("dd deletes the focused row", afterDelete === beforeDelete - 1, `${beforeDelete} → ${afterDelete}`);

  await page.keyboard.press("u");
  await page.waitForTimeout(900);
  const afterUndo = await page.locator("li[role=treeitem]").count();
  check("u restores it", afterUndo === beforeDelete, `${afterDelete} → ${afterUndo}`);

  // `/` filters.
  await page.keyboard.press("/");
  await page.waitForTimeout(400);
  // "todo" appears only in the second row's title. ("Second" would match both,
  // because the first row's body contains the line "second line".)
  await page.keyboard.type("todo");
  await page.waitForTimeout(600);
  const filtered = await page.locator("li[role=treeitem]").count();
  check("/ filters the list", filtered === 1, `${filtered} rows visible`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // `?` opens the cheat sheet, Escape closes it.
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  const cheatVisible = await page.locator("text=Keyboard").first().isVisible();
  check("? opens the cheat sheet", cheatVisible);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Ctrl+K opens the palette.
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  const paletteVisible = await page.locator("input[placeholder='Type a command…']").isVisible();
  check("Ctrl+K opens the command palette", paletteVisible);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // --- durability: reload and confirm OPFS kept everything ---------------
  const before = await page.locator("li[role=treeitem]").count();
  await page.reload({ waitUntil: "load" });
  await page.locator("li[role=treeitem]").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  const after = await page.locator("li[role=treeitem]").count();
  check(
    "state survives a reload (OPFS durable)",
    after >= before - 1 && after > 1,
    `${before} rows before, ${after} after`,
  );

  const bodyText = await page.locator("body").textContent();
  check("the captured todo is still there", bodyText.includes("Ship EOD report v1"));

  // Errors from the worker or Rust would land here.
  const realErrors = errors.filter((e) => !e.includes("favicon"));
  check("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join("\n        "));

  await browser.close();
} catch (err) {
  check("smoke run completed", false, err.stack ?? err.message);
} finally {
  server.kill("SIGTERM");
}

const failed = checks.filter((c) => !c.passed);
console.log(
  failed.length
    ? `\n${failed.length}/${checks.length} checks FAILED`
    : `\nAll ${checks.length} browser checks passed.`,
);
exitCode = failed.length ? 1 : 0;
process.exit(exitCode);
