/**
 * The engine port — the single seam between the UI and the Rust core.
 *
 * One interface, two implementations (docs/02-architecture.md §3):
 *
 *   Tauri shell  →  IPC `invoke()`  →  daybook-core compiled natively
 *   Browser PWA  →  direct WASM call →  daybook-core compiled to wasm32
 *
 * Nothing above this file knows which one is live. That is the whole point: the
 * UI bundle is byte-identical on both hosts, so a WebView divergence can never be
 * an *engine* divergence.
 *
 * This module is part of the framework-agnostic plain-TS core. Alpine may read it;
 * it must never reach into Alpine.
 */

/** A Phase 0 probe outcome, mirrored from `ProbeResult` in the Rust shell. */
export interface ProbeResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EnginePort {
  /** Which implementation is live, e.g. `tauri/linux` or `wasm/browser`. */
  runtime(): Promise<string>;
  /** Round-trips a string through Rust — the thinnest possible liveness check. */
  echo(input: string): Promise<string>;
  /** Concurrent `Y.Text` edits from two replicas, merged in Rust. */
  bodyProbe(): Promise<ProbeResult>;
  /** A SQLite write followed by a read-back, through whichever backend is live. */
  storeProbe(): Promise<ProbeResult>;
}

/**
 * True when running inside the Tauri shell. Tauri v2 injects this before any app
 * script runs, so it is safe to read at module scope.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Native half of the port: every call crosses Tauri IPC into `daybook-core`. */
class TauriEnginePort implements EnginePort {
  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  runtime(): Promise<string> {
    return this.invoke<string>("core_runtime");
  }

  echo(input: string): Promise<string> {
    return this.invoke<string>("core_echo", { input });
  }

  bodyProbe(): Promise<ProbeResult> {
    return this.invoke<ProbeResult>("core_body_probe");
  }

  storeProbe(): Promise<ProbeResult> {
    return this.invoke<ProbeResult>("core_store_probe");
  }
}

/**
 * Browser half of the port: the same `daybook-core`, compiled to wasm32, called
 * directly — no IPC hop.
 *
 * **Phase 0 status.** The wasm build and its OPFS-backed store are proven in
 * `spikes/wasm-opfs/`, which is deliberately throwaway; wiring the generated
 * package in as a permanent dependency of `app/` is Phase 1 work. Until then this
 * implementation reports its own absence rather than pretending to succeed —
 * a probe that silently returns `passed: true` would defeat the gate.
 */
class WasmEnginePort implements EnginePort {
  private readonly pending: ProbeResult = {
    name: "wasm engine port",
    passed: false,
    detail:
      "Not wired into app/ yet — Phase 1. The wasm32 core + sqlite-wasm/OPFS path " +
      "is proven in spikes/wasm-opfs (see spikes/README.md).",
  };

  async runtime(): Promise<string> {
    return "wasm/browser (engine pending — see spikes/wasm-opfs)";
  }

  async echo(input: string): Promise<string> {
    return `no wasm engine bound; echo not evaluated: ${input}`;
  }

  async bodyProbe(): Promise<ProbeResult> {
    return { ...this.pending, name: "yrs Y.Text converges (wasm)" };
  }

  async storeProbe(): Promise<ProbeResult> {
    return { ...this.pending, name: "SQLite write/read (sqlite-wasm + OPFS)" };
  }
}

let cached: EnginePort | null = null;

/** The engine port for this host. Resolved once, then reused. */
export function engine(): EnginePort {
  if (!cached) cached = isTauri() ? new TauriEnginePort() : new WasmEnginePort();
  return cached;
}
