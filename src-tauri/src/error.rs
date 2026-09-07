//! Error conventions at the command boundary.
//!
//! Commands return `Result<T, String>` on purpose: the string is an i18n
//! protocol the frontend translates — either `errors.<key>` or
//! `errors.<key>|<detail>`. Keeping it a plain string avoids a second
//! serialization layer while still giving users localized messages.

/// Result type used by every `#[tauri::command]`.
pub type CmdResult<T> = Result<T, String>;

/// Errors raised by the driver and storage layers before they reach the
/// command boundary, where they are flattened into the string protocol.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("errors.notConnected")]
    NotConnected,
    #[error("errors.unsupported|{0}")]
    Unsupported(String),
    #[error("errors.connect|{0}")]
    Connect(String),
    #[error("errors.auth|{0}")]
    Auth(String),
    #[error("errors.tls|{0}")]
    Tls(String),
    #[error("errors.query|{0}")]
    Query(String),
    #[error("errors.cancelled")]
    Cancelled,
    #[error("errors.noPrimaryKey")]
    NoPrimaryKey,
    #[error("errors.readOnly")]
    ReadOnly,
    #[error("errors.storage|{0}")]
    Storage(String),
    #[error("errors.secrets|{0}")]
    Secrets(String),
    #[error("errors.io|{0}")]
    Io(String),
    #[error("errors.unknown|{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Storage(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

/// Find the server's error anywhere in the cause chain (authentication
/// failures arrive wrapped in a "connect" error).
fn pg_db_error(e: &tokio_postgres::Error) -> Option<&tokio_postgres::error::DbError> {
    if let Some(db) = e.as_db_error() {
        return Some(db);
    }
    let mut cur: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    for _ in 0..6 {
        let c = cur?;
        if let Some(db) = c.downcast_ref::<tokio_postgres::error::DbError>() {
            return Some(db);
        }
        if let Some(inner) = c.downcast_ref::<tokio_postgres::Error>() {
            if let Some(db) = inner.as_db_error() {
                return Some(db);
            }
        }
        cur = c.source();
    }
    None
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        if let Some(db) = pg_db_error(&e) {
            let code = db.code().code();
            if code.starts_with("28") {
                return AppError::Auth(db.message().to_string());
            }
            if code == "3D000" {
                // unknown database
                return AppError::Connect(db.message().to_string());
            }
            let mut msg = db.message().to_string();
            if let Some(d) = db.detail() {
                msg.push('\n');
                msg.push_str(d);
            }
            if let Some(h) = db.hint() {
                msg.push_str("\nHint: ");
                msg.push_str(h);
            }
            if let Some(tokio_postgres::error::ErrorPosition::Original(pos)) = db.position() {
                msg.push_str(&format!(" (position {pos})"));
            }
            return AppError::Query(msg);
        }
        let s = e.to_string();
        let io_cause = {
            let mut cur = std::error::Error::source(&e);
            let mut found = false;
            for _ in 0..6 {
                let Some(c) = cur else { break };
                if c.downcast_ref::<std::io::Error>().is_some() {
                    found = true;
                    break;
                }
                cur = c.source();
            }
            found
        };
        if e.is_closed() || io_cause || s.starts_with("error connecting") || s.contains("timed out") {
            let detail = std::error::Error::source(&e).map(|c| c.to_string()).unwrap_or_default();
            AppError::Connect(if detail.is_empty() { s } else { format!("{s}: {detail}") })
        } else {
            AppError::Query(s)
        }
    }
}

impl From<mysql_async::Error> for AppError {
    fn from(e: mysql_async::Error) -> Self {
        match &e {
            mysql_async::Error::Server(s) => {
                if s.code == 1045 || s.code == 1044 {
                    AppError::Auth(s.message.clone())
                } else {
                    AppError::Query(format!("{} (code {})", s.message, s.code))
                }
            }
            mysql_async::Error::Io(_) | mysql_async::Error::Driver(_) => {
                AppError::Connect(e.to_string())
            }
            _ => AppError::Query(e.to_string()),
        }
    }
}

impl From<redis::RedisError> for AppError {
    fn from(e: redis::RedisError) -> Self {
        use redis::ErrorKind;
        if e.is_io_error() || e.is_connection_refusal() || e.is_timeout() {
            return AppError::Connect(e.to_string());
        }
        match e.kind() {
            ErrorKind::AuthenticationFailed => AppError::Auth(e.to_string()),
            _ => AppError::Query(e.to_string()),
        }
    }
}

