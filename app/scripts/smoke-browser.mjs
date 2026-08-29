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

/** Read a node's stored body straight from the engine's tree, by tree position. */
function nodeBody(page, index) {
  return page.evaluate(
    (i) => window.Alpine.$data(document.getElementById("app")).state.nodes[i]?.bodyMd ?? "",
    index,
  );
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
    .locator("[data-runtime]")
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
  await page.keyboard.type("Book the dentist appointment");
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
    titles[0] === "Book the dentist appointment",
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
  await page.keyboard.type("errands");
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

  // --- the detail view ----------------------------------------------------
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.waitForTimeout(300);
  const bodyBeforeDetail = await nodeBody(page, 0);
  await page.keyboard.press("v");
  await page.waitForTimeout(900);

  const detail = await page.evaluate(() => {
    const d = window.Alpine.$data(document.getElementById("app"));
    return { id: d.state.detailId, title: d.detail?.title, subItems: d.rows().length };
  });
  check("v opens the detail view on the focused todo", Boolean(detail.id), JSON.stringify(detail));
  check(
    "the detail body editor is mounted",
    await page.locator("[data-detail-body] .cm-content").isVisible(),
  );

  // The regression that matters here: closing the roving editor while the list
  // has moved on used to flush its *stale* document over the focused row,
  // emptying a todo nobody had opened.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const bodyAfterDetail = await nodeBody(page, 0);
  check(
    "opening and leaving the detail view does not blank the body",
    bodyAfterDetail === bodyBeforeDetail && bodyAfterDetail.length > 0,
    `${JSON.stringify(bodyBeforeDetail)} → ${JSON.stringify(bodyAfterDetail)}`,
  );

  // --- accessibility contract ---------------------------------------------
  // The list is a single focus stop that moves `aria-activedescendant`, because
  // making every row focusable would fight the single-keystroke verbs. That
  // means the attribute IS how a screen reader learns the cursor moved.
  const a11y = await page.evaluate(() => {
    const ul = document.querySelector("[data-list]");
    const rows = [...ul.querySelectorAll("li[role=treeitem]")];
    return {
      active: ul.getAttribute("aria-activedescendant"),
      ids: rows.map((r) => r.id),
      levels: rows.map((r) => r.getAttribute("aria-level")),
      labelled: rows.every((r) => (r.getAttribute("aria-label") ?? "").length > 0),
      skip: Boolean(document.querySelector("a.skip-link")),
    };
  });
  check(
    "the focused row is announced via aria-activedescendant",
    Boolean(a11y.active) && a11y.ids.includes(a11y.active),
    JSON.stringify(a11y).slice(0, 200),
  );
  check(
    "every row carries a level and a label",
    a11y.labelled && a11y.levels.every(Boolean),
    JSON.stringify(a11y.levels),
  );
  check("there is a skip link past the sidebar", a11y.skip);

  // Overlays are dialogs, and closing one hands focus back to the list rather
  // than dropping it on <body>, where the next keystroke would reach nothing.
  await page.keyboard.press("t");
  await page.waitForTimeout(500);
  const dialog = await page.evaluate(() => {
    const open = [...document.querySelectorAll("[role=dialog]")].find((d) => d.offsetParent);
    return open ? { modal: open.getAttribute("aria-modal"), label: open.getAttribute("aria-label") } : null;
  });
  check("the tag editor is a labelled modal dialog", dialog?.modal === "true" && Boolean(dialog?.label), JSON.stringify(dialog));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const refocused = await page.evaluate(() => document.activeElement?.hasAttribute("data-list"));
  check("closing an overlay returns focus to the list", refocused === true);

  // --- the EOD report -----------------------------------------------------
  await page.keyboard.press("Control+Shift+E");
  await page.waitForTimeout(1200);
  const report = await page.evaluate(() => {
    const d = window.Alpine.$data(document.getElementById("app"));
    return { day: d.state.reportDay, markdown: d.state.report?.markdown ?? "" };
  });
  check(
    "Ctrl+Shift+E generates a report for today",
    report.markdown.startsWith(`# EOD — ${report.day}`),
    JSON.stringify(report).slice(0, 200),
  );
  check(
    "the report names the work that was captured",
    report.markdown.includes("Book the dentist appointment"),
    report.markdown.slice(0, 200),
  );
  // The report is a pure function of the log, so asking twice must not change
  // the answer — this is the property the whole feature rests on.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+Shift+E");
  await page.waitForTimeout(1200);
  const again = await page.evaluate(
    () => window.Alpine.$data(document.getElementById("app")).state.report?.markdown ?? "",
  );
  check("the report is deterministic across runs", again === report.markdown);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

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
  check("the captured todo is still there", bodyText.includes("Book the dentist appointment"));

  // --- drag to reorder ----------------------------------------------------
  // The keyboard path is covered above; this is the only way a mouse can
  // reorder or re-parent at all.
  const orderBefore = await page.evaluate(() =>
    window.Alpine.$data(document.getElementById("app")).state.nodes.map((n) => n.title),
  );
  if (orderBefore.length >= 2) {
    const treeRows = page.locator("li[role=treeitem]");
    const last = orderBefore.length - 1;
    await treeRows.nth(last).hover();
    await page.waitForTimeout(300);
    const grip = await treeRows.nth(last).locator('[draggable="true"]').boundingBox();
    const target = await treeRows.nth(0).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    // Settle in the top band, which means "put it before this row".
    await page.mouse.move(target.x + 250, target.y + target.height * 0.15, { steps: 10 });
    // No assertion on the drop indicator here. Chromium does not service CDP
    // evaluations while a native drag loop is running, so the class cannot be
    // observed mid-drag from this harness — and a check that cannot see its
    // subject is just a flaky test. The indicator is verified by screenshot;
    // what *is* checkable is that the band the pointer settled in produced the
    // right move, which the two assertions below do.
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const orderAfter = await page.evaluate(() =>
      window.Alpine.$data(document.getElementById("app")).state.nodes.map((n) => n.title),
    );
    check(
      "dropping a row above another reorders it",
      orderAfter[0] === orderBefore[last] && orderAfter.length === orderBefore.length,
      `${JSON.stringify(orderBefore)} → ${JSON.stringify(orderAfter)}`,
    );

    // A structural move has to put the row back where it came from, not just
    // under the right parent.
    await page.keyboard.press("u");
    await page.waitForTimeout(1500);
    const undone = await page.evaluate(() =>
      window.Alpine.$data(document.getElementById("app")).state.nodes.map((n) => n.title),
    );
    check(
      "a drag can be undone",
      JSON.stringify(undone) === JSON.stringify(orderBefore),
      `${JSON.stringify(orderBefore)} → ${JSON.stringify(undone)}`,
    );
  }

  // --- image attachments --------------------------------------------------
  // Bytes never enter the body; it carries `![](attachment:<sha256>)` and the
  // blob table holds the image under that hash.
  await page.keyboard.press("n");
  await page.waitForTimeout(700);
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("Postcard from the trip");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    // A 1x1 PNG is enough: what is under test is the path, not the decoder.
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    document
      .querySelector(".cm-content")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2500);

  const attached = await page.evaluate(() => {
    const d = window.Alpine.$data(document.getElementById("app"));
    const node = d.state.nodes.find((n) => n.bodyMd.includes("attachment:"));
    return node?.bodyMd ?? "";
  });
  check(
    "a pasted image becomes a content-addressed reference",
    /!\[\]\(attachment:[0-9a-f]{64}\)/.test(attached),
    JSON.stringify(attached).slice(0, 120),
  );

  const rendered = await page.evaluate(
    () => document.querySelectorAll(".cm-md-image img").length,
  );
  check("the attachment renders inline as an image", rendered > 0, `${rendered} images`);

  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);

  // --- the time model -----------------------------------------------------
  // `s` then `t` plans the focused todo for today; digit 1 opens the Today
  // view, which must contain exactly that todo. This drives the popover, the
  // scheduled_for column (including its migration on an existing database),
  // and the rail filtering in one pass.
  await page.keyboard.press("s");
  await page.waitForTimeout(400);
  await page.keyboard.press("t");
  await page.waitForTimeout(900);
  await page.keyboard.press("1");
  await page.waitForTimeout(700);
  const todayView = await page.evaluate(() => {
    const d = window.Alpine.$data(document.getElementById("app"));
    return {
      view: d.state.activeView,
      rows: d.rows().length,
      scheduled: d.rows().some((r) => r.scheduledFor !== null),
    };
  });
  check(
    "s→t plans a todo and the Today view shows it",
    todayView.view === "today" && todayView.rows >= 1 && todayView.scheduled,
    JSON.stringify(todayView),
  );
  await page.keyboard.press("4");
  await page.waitForTimeout(700);
  const backToAll = await page.evaluate(
    () => window.Alpine.$data(document.getElementById("app")).state.activeView,
  );
  check("digit 4 returns to the All tree", backToAll === "all", backToAll);

  // --- user-defined statuses ----------------------------------------------
  // The vocabulary is data now. This drives the wasm boundary: create a custom
  // status, see it come back typed, apply it, and confirm `x` still finishes a
  // task by category rather than by the id "done".
  const statusRoundTrip = await page.evaluate(async () => {
    const mod = await import("/src/core/engine-port.ts");
    const port = mod.engine();
    const made = await port.createStatus("Errand", "open", null);
    const listed = await port.listStatuses();
    const node = await port.createNode(null, "Pick up the parcel", null);
    await port.setStatus(node.id, made.id);
    const applied = await port.node(node.id);
    await port.toggleDone(node.id);
    const finished = await port.node(node.id);
    await port.deleteNode(node.id);
    await port.deleteStatus(made.id);
    return {
      created: made.category === "open" && made.id.length > 10,
      listed: listed.some((s) => s.name === "Errand"),
      applied: applied.status === made.id && applied.statusCategory === "open",
      finished: finished.statusCategory === "done",
    };
  });
  check(
    "a custom status round-trips the wasm boundary and x completes by category",
    Object.values(statusRoundTrip).every(Boolean),
    JSON.stringify(statusRoundTrip),
  );

  // --- link chips ---------------------------------------------------------
  // A ticket URL in a body renders as a short reference chip, not a wall of
  // URL — Daybook points at trackers, it does not become one.
  await page.keyboard.press("n");
  await page.waitForTimeout(700);
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("Chase the plumber quote");
  await page.keyboard.press("Enter");
  await page.keyboard.type("context: https://github.com/acme/house/issues/12");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await page.keyboard.press("v");
  await page.waitForTimeout(1200);
  const chip = await page.evaluate(() => {
    const el = document.querySelector(".cm-link-chip");
    return el ? { label: el.textContent, href: el.getAttribute("href") } : null;
  });
  check(
    "a ticket URL renders as a reference chip",
    chip?.label === "acme/house#12" && chip?.href?.startsWith("https://github.com"),
    JSON.stringify(chip),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // --- a second tab -------------------------------------------------------
  // OPFS grants its database lock to one context per origin, so this used to
  // fail to boot outright. The second tab now finds the first through a Web
  // Lock and calls it instead of opening its own database.
  const second = await context.newPage();
  const secondErrors = [];
  second.on("pageerror", (e) => secondErrors.push(e.message));
  second.on("console", (m) => m.type() === "error" && secondErrors.push(m.text()));
  await second.goto(BASE, { waitUntil: "load" });
  await second.locator("li[role=treeitem]").first().waitFor({ timeout: 60_000 });
  await second.waitForTimeout(1500);

  const secondRows = await second.locator("li[role=treeitem]").count();
  check("a second tab opens and sees the same data", secondRows > 0, `${secondRows} rows`);
  check(
    "the second tab reports no engine error",
    secondErrors.filter((e) => !e.includes("favicon")).length === 0,
    secondErrors.slice(0, 2).join(" | "),
  );

  // A write from the follower has to reach the leader's database, and the leader
  // has to notice without being touched.
  const beforeCrossTab = await page.locator("li[role=treeitem]").count();
  await second.keyboard.press("Escape");
  await second.waitForTimeout(300);
  await second.keyboard.press("n");
  await second.waitForTimeout(700);
  await second.locator(".cm-content").first().click();
  await second.keyboard.type("Written in the second tab");
  await second.keyboard.press("Control+Enter");
  await second.waitForTimeout(700);
  await second.keyboard.press("Escape");
  await second.waitForTimeout(1800);

  const afterCrossTab = await page.locator("li[role=treeitem]").count();
  check(
    "a write in one tab shows up in the other",
    afterCrossTab === beforeCrossTab + 1,
    `${beforeCrossTab} → ${afterCrossTab}`,
  );
  await second.close();
  await page.waitForTimeout(500);

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
