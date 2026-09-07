//! SSH tunnels (`russh`). A tunnel is a local TCP listener on 127.0.0.1;
//! every accepted socket becomes a `direct-tcpip` channel to the database
//! host as seen from the SSH server. Drivers then connect to the local port
//! as if the database were on this machine.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use tokio::net::TcpListener;

use crate::error::{AppError, AppResult};

/// SSH settings taken from `ConnectionConfig.options.ssh`.
#[derive(Debug, Clone)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `password` or `key`
    pub auth: String,
    pub key_path: Option<String>,
    /// password for `password` auth, passphrase for `key` auth (from the keychain)
    pub secret: Option<String>,
    pub connect_timeout: Duration,
}

impl SshConfig {
    /// Parse `options.ssh` (returns None when the tunnel is disabled).
    pub fn from_options(options: &serde_json::Value, secret: Option<&str>) -> Option<Self> {
        let ssh = options.get("ssh")?;
        if !ssh.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            return None;
        }
        let host = ssh.get("host").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if host.is_empty() {
            return None;
        }
        Some(SshConfig {
            host,
            port: ssh.get("port").and_then(|v| v.as_u64()).map(|p| p as u16).filter(|p| *p > 0).unwrap_or(22),
            user: ssh.get("user").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            auth: ssh.get("auth").and_then(|v| v.as_str()).unwrap_or("password").to_string(),
            key_path: ssh.get("keyPath").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            secret: secret.map(|s| s.to_string()).filter(|s| !s.is_empty()),
            connect_timeout: Duration::from_secs(
                options.get("connectTimeout").and_then(|v| v.as_u64()).filter(|s| *s > 0).unwrap_or(15),
            ),
        })
    }
}

struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    // Trust on first use: the GUI has no known_hosts UI yet, and the tunnel
    // only forwards a database connection the user asked for.
    async fn check_server_key(&mut self, _key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// A live tunnel. Dropping it (or calling `close`) stops the listener and
/// disconnects the SSH session.
pub struct SshTunnel {
    pub local_port: u16,
    handle: Arc<Handle<Client>>,
    listener: tokio::task::JoinHandle<()>,
}

impl SshTunnel {
    /// Connect to the SSH server, authenticate and start forwarding
    /// `127.0.0.1:<local_port>` → `target_host:target_port` (as resolved by
    /// the SSH server).
    pub async fn open(cfg: &SshConfig, target_host: &str, target_port: u16) -> AppResult<Self> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });
        let addr = (cfg.host.as_str(), cfg.port);
        let mut handle = tokio::time::timeout(cfg.connect_timeout, client::connect(config, addr, Client))
            .await
            .map_err(|_| AppError::Connect(format!("ssh {}:{}: timeout", cfg.host, cfg.port)))?
            .map_err(|e| AppError::Connect(format!("ssh {}:{}: {e}", cfg.host, cfg.port)))?;

        let result = if cfg.auth == "key" {
            let path = cfg
                .key_path
                .clone()
                .ok_or_else(|| AppError::Auth("ssh: no private key file".into()))?;
            let key = load_secret_key(&path, cfg.secret.as_deref())
                .map_err(|e| AppError::Auth(format!("ssh key {path}: {e}")))?;
            handle
                .authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512)))
                .await
        } else {
            handle
                .authenticate_password(cfg.user.clone(), cfg.secret.clone().unwrap_or_default())
                .await
        }
        .map_err(|e| AppError::Auth(format!("ssh: {e}")))?;
        if !matches!(result, russh::client::AuthResult::Success) {
            return Err(AppError::Auth(format!("ssh: authentication failed for {}@{}", cfg.user, cfg.host)));
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();
        let handle = Arc::new(handle);
        let fwd_handle = handle.clone();
        let target = target_host.to_string();
        let listener_task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, peer)) = listener.accept().await else { break };
                let h = fwd_handle.clone();
                let target = target.clone();
                tokio::spawn(async move {
                    match h.channel_open_direct_tcpip(target, target_port as u32, "127.0.0.1", peer.port() as u32).await {
                        Ok(channel) => {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                        }
                        Err(e) => log::warn!("ssh direct-tcpip failed: {e}"),
                    }
                });
            }
        });
        log::info!("ssh tunnel 127.0.0.1:{local_port} -> {target_host}:{target_port} via {}@{}", cfg.user, cfg.host);
        Ok(SshTunnel { local_port, handle, listener: listener_task })
    }

    pub async fn close(&self) {
        self.listener.abort();
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.listener.abort();
    }
}
