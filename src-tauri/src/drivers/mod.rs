//! Database drivers. Every SQL engine implements `SqlDriver`; Redis has its
//! own session type because it is not relational. `connect` is the single
//! entry point the commands use.

pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sql;
pub mod sqlite;
pub mod ssh;
pub mod value;

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::models::{
    ColumnInfo, ConnectionConfig, DriverKind, ResultSet, RowSink, ServerInfo, TableColumns, TableInfo, TableStructure,
};

/// Upper bound on rows a single result set carries to the UI. The table
/// view pages well below this; the query tab tells the user when it hits it.
pub const HARD_MAX_ROWS: usize = 50_000;

#[async_trait]
pub trait SqlDriver: Send + Sync {
    fn kind(&self) -> DriverKind;
    fn dialect(&self) -> sql::Dialect;
    async fn server_info(&self) -> AppResult<ServerInfo>;
    /// PostgreSQL: databases of the cluster. MySQL: schemas (same thing there).
    /// `include_system` adds templates / information_schema and friends.
    async fn list_databases(&self, include_system: bool) -> AppResult<Vec<String>>;
    /// PostgreSQL: schemas of the current database. MySQL: databases.
    async fn list_schemas(&self, include_system: bool) -> AppResult<Vec<String>>;
    async fn list_tables(&self, schema: &str) -> AppResult<Vec<TableInfo>>;
    async fn columns(&self, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>>;
    /// All columns of a schema in one go. Drivers with a catalog override this
    /// with a single query; the default walks `tables()` + `columns()`.
    async fn schema_columns(&self, schema: &str) -> AppResult<Vec<TableColumns>> {
        let mut out = Vec::new();
        for t in self.list_tables(schema).await? {
            let columns = self.columns(schema, &t.name).await?;
            out.push(TableColumns { table: t.name, columns });
        }
        Ok(out)
    }
    async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure>;
    /// Run arbitrary SQL (possibly several statements) and return one result
    /// set per statement. Rows beyond `max_rows` are dropped and flagged.
    async fn query(&self, sql: &str, max_rows: usize) -> AppResult<Vec<ResultSet>> {
        self.query_with(sql, max_rows, None).await
    }
    /// Same as `query`, but with a sink the driver feeds while rows arrive.
    /// When a sink is given the returned sets carry `streamed = true` and no rows.
    async fn query_with(&self, sql: &str, max_rows: usize, sink: Option<RowSink>) -> AppResult<Vec<ResultSet>>;
    /// Run statements inside one transaction; returns total affected rows.
    async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64>;
    /// Ask the server to abort the statement currently running on this session.
    async fn cancel(&self) -> AppResult<()>;
    async fn close(&self);
}

/// A live session the commands hold in `AppState`.
#[derive(Clone)]
pub enum Session {
    Sql(Arc<dyn SqlDriver>),
    Redis(Arc<redis::RedisSession>),
}

impl Session {
    pub fn sql(&self) -> AppResult<Arc<dyn SqlDriver>> {
        match self {
            Session::Sql(d) => Ok(d.clone()),
            Session::Redis(_) => Err(AppError::Unsupported("sql on redis".into())),
        }
    }
    pub fn redis(&self) -> AppResult<Arc<redis::RedisSession>> {
        match self {
            Session::Redis(r) => Ok(r.clone()),
            Session::Sql(_) => Err(AppError::Unsupported("redis on sql".into())),
        }
    }
    pub async fn close(&self) {
        match self {
            Session::Sql(d) => d.close().await,
            Session::Redis(r) => r.close().await,
        }
    }
}

/// Open a session for `config`. `database` overrides the saved database
/// (used when the user switches database in the sidebar). When the
/// connection has an SSH tunnel configured it is opened first and the driver
/// talks to the local end; the tunnel is returned so the caller keeps it
/// alive for as long as the session.
pub async fn connect(
    config: &ConnectionConfig,
    password: Option<&str>,
    ssh_secret: Option<&str>,
    database: Option<&str>,
) -> AppResult<(Session, Option<Arc<ssh::SshTunnel>>)> {
    if config.driver == DriverKind::Sqlite {
        return Ok((connect_direct(config, password, database).await?, None));
    }
    if let Some(ssh_cfg) = ssh::SshConfig::from_options(&config.options, ssh_secret) {
        let tunnel = Arc::new(ssh::SshTunnel::open(&ssh_cfg, &config.host, config.port).await?);
        let mut local = config.clone();
        local.host = "127.0.0.1".into();
        local.port = tunnel.local_port;
        // TLS certificates are for the real host, not 127.0.0.1
        if local.ssl_mode == SslModeVerifyAlias::VERIFY {
            local.ssl_mode = crate::models::SslMode::Require;
        }
        match connect_direct(&local, password, database).await {
            Ok(session) => return Ok((session, Some(tunnel))),
            Err(e) => {
                tunnel.close().await;
                return Err(e);
            }
        }
    }
    Ok((connect_direct(config, password, database).await?, None))
}

struct SslModeVerifyAlias;
impl SslModeVerifyAlias {
    const VERIFY: crate::models::SslMode = crate::models::SslMode::Verify;
}

async fn connect_direct(
    config: &ConnectionConfig,
    password: Option<&str>,
    database: Option<&str>,
) -> AppResult<Session> {
    match config.driver {
        DriverKind::Postgres => {
            let d = postgres::PgDriver::connect(config, password, database).await?;
            Ok(Session::Sql(Arc::new(d)))
        }
        DriverKind::Mysql => {
            let d = mysql::MysqlDriver::connect(config, password, database).await?;
            Ok(Session::Sql(Arc::new(d)))
        }
        DriverKind::Redis => {
            let r = redis::RedisSession::connect(config, password, database).await?;
            Ok(Session::Redis(Arc::new(r)))
        }
        DriverKind::Sqlite => {
            let d = sqlite::SqliteDriver::connect(config).await?;
            Ok(Session::Sql(Arc::new(d)))
        }
    }
}

/// Build a rustls client config. `verify = false` accepts any certificate
/// (what "prefer"/"require" mean in every database GUI); `verify = true`
/// checks against the OS trust store.
pub fn tls_config(verify: bool) -> AppResult<rustls::ClientConfig> {
    if verify {
        let mut roots = rustls::RootCertStore::empty();
        let certs = rustls_native_certs::load_native_certs();
        for c in certs.certs {
            let _ = roots.add(c);
        }
        Ok(rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth())
    } else {
        Ok(rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify))
            .with_no_client_auth())
    }
}

/// Certificate verifier that accepts everything. Only used for the
/// "prefer"/"require" modes, where the user asked for encryption without
/// identity checks.
#[derive(Debug)]
struct NoVerify;

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Install the ring crypto provider once so every rustls builder agrees on it
/// (several dependencies could otherwise pull different providers).
pub fn init_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
