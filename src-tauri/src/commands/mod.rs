//! Tauri commands — thin adapters between the frontend IPC and the domain
//! modules (`drivers`, `store`, `secrets`). Each file groups one domain;
//! everything is re-exported so `lib.rs` can register the handlers in one
//! place.

pub mod app;
pub mod connections;
pub mod files;
pub mod import;
pub mod query;
pub mod redis;
pub mod schema;
pub mod sessions;
pub mod table;

pub use app::*;
pub use connections::*;
pub use files::*;
pub use import::*;
pub use query::*;
pub use redis::*;
pub use schema::*;
pub use sessions::*;
pub use table::*;
