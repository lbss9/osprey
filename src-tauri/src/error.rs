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

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        // `as_db_error` carries the server message; anything else is transport
        if let Some(db) = e.as_db_error() {
            let code = db.code().code();
            if code.starts_with("28") {
                return AppError::Auth(db.message().to_string());
            }
            let mut msg = db.message().to_string();
            if let Some(d) = db.detail() {
                msg.push_str("\n");
                msg.push_str(d);
            }
            if let Some(h) = db.hint() {
                msg.push_str("\nHint: ");
                msg.push_str(h);
            }
            if let Some(p) = db.position() {
                if let tokio_postgres::error::ErrorPosition::Original(pos) = p {
                    msg.push_str(&format!(" (position {pos})"));
                }
            }
            return AppError::Query(msg);
        }
        let s = e.to_string();
        if e.is_closed() || s.contains("connection") {
            AppError::Connect(s)
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

