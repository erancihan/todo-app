//! # Daybook core
//!
//! One crate, two builds (docs/02-architecture.md §3):
//!
//! * **native** — linked into the Tauri v2 shell (iOS, macOS, Windows, Android)
//!   and, for the future server-side projection, into the relay.
//! * **wasm32** — linked into the browser PWA, where SQLite is reached through
//!   `sqlite-wasm` + OPFS in the host JS environment instead of `rusqlite`.
//!
//! The split is a single seam: [`store::Store`]. Everything above it — the op
//! log, the HLC clock, the body CRDT, ordering — is target-independent and
//! compiles identically for both.
//!
//! ## Status
//!
//! Phase 0 (proof-of-stack). [`body`], [`hlc`], [`ids`], and [`order_key`] are
//! implemented because the Phase 0 exit criteria test them. [`node`], [`event`],
//! [`op`], and [`blob`] carry the types the model needs but their engines land in
//! Phase 1 and Phase 2 — each is marked at its definition.

pub mod blob;
pub mod body;
pub mod event;
pub mod hlc;
pub mod ids;
pub mod node;
pub mod op;
pub mod order_key;
pub mod store;

pub use body::{BodyCrdt, BodyUpdate, StateVector, YrsBody};
pub use hlc::{Hlc, HlcClock};
pub use ids::{new_id, DeviceId, Id};

/// Errors surfaced across the engine port to the TypeScript core/engine layer.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("body crdt: {0}")]
    Crdt(String),
    #[error("store: {0}")]
    Store(String),
    #[error("encode/decode: {0}")]
    Codec(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// Round-trips a string through Rust. The Tauri IPC spike and the WASM spike both
/// call this to prove the engine port is wired end to end before any real work
/// crosses it (Phase 0 exit criterion: "calling one Tauri command into crates/core").
pub fn echo(input: &str) -> String {
    format!("daybook-core@{} echo: {input}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_round_trips() {
        assert!(echo("hello").ends_with("echo: hello"));
    }
}
