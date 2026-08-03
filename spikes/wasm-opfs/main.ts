/**
 * Spike 2 page shell (throwaway) — spawns the worker that does the real work and
 * renders its verdicts.
 */

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const results = document.getElementById("results") as HTMLTableElement;
const summary = document.getElementById("summary") as HTMLElement;
const envEl = document.getElementById("env") as HTMLElement;

function render(checks: Check[], env: string) {
  results.innerHTML = checks
    .map(
      (c) => `<tr>
        <td class="verdict ${c.passed ? "pass" : "fail"}">${c.passed ? "PASS" : "FAIL"}</td>
        <td>${c.name}<pre>${escapeHtml(c.detail)}</pre></td>
      </tr>`,
    )
    .join("");

  const failed = checks.filter((c) => !c.passed);
  summary.textContent = failed.length
    ? `${failed.length} of ${checks.length} checks FAILED`
    : `All ${checks.length} checks passed`;
  summary.className = failed.length ? "fail" : "pass";
  envEl.textContent = env;

  (window as unknown as Record<string, unknown>).__SPIKE_RESULT__ = {
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function start() {
  summary.textContent = "running…";
  summary.className = "";
  results.innerHTML = "";

  const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (ev: MessageEvent) => {
    render(ev.data.checks as Check[], String(ev.data.env ?? ""));
    worker.terminate();
  });
  worker.addEventListener("error", (ev) => {
    render(
      [{ name: "worker failed to start", passed: false, detail: ev.message }],
      navigator.userAgent,
    );
  });
  worker.postMessage("run");
}

document.getElementById("rerun")?.addEventListener("click", start);

// Escape hatch: OPFS is persistent, so a bad run can otherwise wedge the file.
document.getElementById("wipe")?.addEventListener("click", async () => {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
    summary.textContent = "OPFS wiped — re-run to rebuild.";
    summary.className = "warn";
  } catch (e) {
    summary.textContent = `wipe failed: ${e instanceof Error ? e.message : String(e)}`;
    summary.className = "fail";
  }
});

start();
