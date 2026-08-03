/**
 * Daybook UI boot.
 *
 * Alpine is the **view layer only** (docs/02-architecture.md ADR-001). Every piece
 * of hard state lives below it in `src/core/` — this file wires the two together
 * and does nothing else.
 *
 * **Phase 0 status.** The screen this renders is the proof-of-stack panel: it
 * reports which engine-port implementation is live and runs the core probes
 * through it. The real list/edit surfaces are Phase 1.
 */

import Alpine from "alpinejs";
import "./app.css";
import { engine, isTauri, type ProbeResult } from "./core/engine-port";
import { REQUIRED_EDIT_BINDINGS } from "./core/keymap";

interface ProbePanel {
  runtime: string;
  echo: string;
  probes: ProbeResult[];
  busy: boolean;
  allPassed: boolean;
  init(): void;
  run(): Promise<void>;
}

Alpine.data(
  "probePanel",
  (): ProbePanel => ({
    runtime: "resolving…",
    echo: "",
    probes: [],
    busy: false,
    allPassed: false,

    init() {
      void this.run();
    },

    async run() {
      this.busy = true;
      const port = engine();
      try {
        this.runtime = await port.runtime();
        this.echo = await port.echo("hello from the view layer");
        this.probes = [await port.bodyProbe(), await port.storeProbe()];
        this.allPassed = this.probes.every((p) => p.passed);
      } catch (err) {
        this.probes = [
          {
            name: "engine port",
            passed: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        ];
        this.allPassed = false;
      } finally {
        this.busy = false;
      }
    },
  }),
);

Alpine.store("host", {
  tauri: isTauri(),
  requiredBindings: REQUIRED_EDIT_BINDINGS,
});

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;
Alpine.start();
