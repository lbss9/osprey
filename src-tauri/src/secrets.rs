//! Passwords live in the OS credential store (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux) under the service name
//! `osprey`, keyed by connection id. Never in the SQLite file.
//!
//! When the store is unavailable (headless Linux without a Secret Service,
//! locked keyring) the caller falls back to the encrypted-at-rest-by-nothing
//! `fallback` column in SQLite and the UI tells the user so.

use crate::error::{AppError, AppResult};

const SERVICE: &str = "osprey";

fn entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).map_err(|e| AppError::Secrets(e.to_string()))
}

pub fn set_password(id: &str, password: &str) -> AppResult<()> {
    entry(id)?
        .set_password(password)
        .map_err(|e| AppError::Secrets(e.to_string()))
}

pub fn get_password(id: &str) -> AppResult<Option<String>> {
    match entry(id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Secrets(e.to_string())),
    }
}

pub fn delete_password(id: &str) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Secrets(e.to_string())),
    }
}

/// True when the platform store answered at all (used by the UI to warn
/// about the plain-text fallback).
pub fn available() -> bool {
    match entry("__osprey_probe__") {
        Ok(e) => match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => true,
            Err(_) => false,
        },
        Err(_) => false,
    }
}
