//! Daybook sync relay — one self-contained binary (docs/02-architecture.md §7.1).
//!
//! ```text
//! daybook-relay --data-dir /var/lib/daybook
//! ```
//!
//! Behind a TLS reverse proxy that is a complete backend: Axum + embedded SQLite
//! op log + filesystem blob store + in-relay magic-link auth. **Hard sizing
//! target: comfortable on 1 shared vCPU / 512 MB RAM.**
//!
//! The relay is deliberately dumb — append, fan out, issue blob tickets. It
//! performs no merging and holds no business logic; conflict resolution is
//! entirely client-side.
//!
//! **Phase 0 scope:** the binary boots, serves `/health`, and fixes the storage
//! trait boundary that keeps Postgres and S3 as a config change rather than a
//! rewrite. The op-log channel, auth, and blob tickets are Phase 2.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

mod storage;

use storage::{OpLogStore, SqliteOpLogStore};

#[derive(Debug, Clone)]
struct Config {
    data_dir: PathBuf,
    addr: SocketAddr,
}

impl Config {
    /// Minimal hand-rolled parsing — a $5-VPS binary should not pull a CLI crate
    /// for two flags.
    fn from_args() -> Result<Self, String> {
        let mut data_dir = PathBuf::from("./daybook-data");
        let mut addr: SocketAddr = "127.0.0.1:8787".parse().expect("valid default addr");

        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--data-dir" => {
                    data_dir = args.next().ok_or("--data-dir needs a path")?.into();
                }
                "--addr" => {
                    addr = args
                        .next()
                        .ok_or("--addr needs host:port")?
                        .parse()
                        .map_err(|e| format!("invalid --addr: {e}"))?;
                }
                "--help" | "-h" => {
                    println!(
                        "daybook-relay [--data-dir <path>] [--addr <host:port>]\n\
                         \n\
                         Defaults: --data-dir ./daybook-data --addr 127.0.0.1:8787"
                    );
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        Ok(Self { data_dir, addr })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "daybook_relay=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_args().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    std::fs::create_dir_all(&config.data_dir)?;

    // Backup is "snapshot this one directory" — that is the whole ops story.
    let db_path = config.data_dir.join("relay.sqlite");
    let mut store = SqliteOpLogStore::open(&db_path)?;
    store.init_schema()?;
    tracing::info!(data_dir = %config.data_dir.display(), "op-log store ready");

    let app = Router::new()
        .route("/health", get(health))
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(config.addr).await?;
    tracing::info!(addr = %config.addr, "daybook-relay listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "daybook-relay",
        "version": env!("CARGO_PKG_VERSION"),
        "phase": "0 — skeleton; op-log channel lands in Phase 2",
    }))
}
