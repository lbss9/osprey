//! Redis over the official `redis` crate with a `ConnectionManager` (auto
//! reconnect). Keys are browsed with SCAN (never KEYS) and big collections
//! are paged with HSCAN/SSCAN/ZSCAN/LRANGE so the UI never asks the server
//! for everything at once.

use std::time::Instant;

use redis::aio::ConnectionManager;
use redis::{cmd, AsyncCommands, ConnectionAddr, ConnectionInfo, IntoConnectionInfo, Value};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::models::*;

pub struct RedisSession {
    conn: Mutex<ConnectionManager>,
    /// kept to open extra connections (pub/sub needs a dedicated one)
    client: redis::Client,
    pub db: i64,
    host: String,
}

/// One `SLOWLOG GET` entry.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowlogEntry {
    pub id: i64,
    pub at: i64,
    pub duration_us: i64,
    pub command: String,
    pub client: String,
    pub name: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGroup {
    pub prefix: String,
    pub keys: u64,
    pub bytes: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub sampled: u64,
    pub total_bytes: u64,
    pub done: bool,
    pub groups: Vec<MemoryGroup>,
}

fn text(v: &Value) -> String {
    match v {
        Value::Nil => String::new(),
        Value::Int(i) => i.to_string(),
        Value::BulkString(b) => match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => format!("0x{}", hex::encode(b)),
        },
        Value::SimpleString(s) => s.clone(),
        Value::Okay => "OK".into(),
        Value::Double(d) => d.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::BigNumber(n) => n.to_string(),
        Value::VerbatimString { text, .. } => text.clone(),
        other => redis_to_json(other).to_string(),
    }
}

/// Convert any RESP value into JSON for the command console.
pub fn redis_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Nil => J::Null,
        Value::Int(i) => J::from(*i),
        Value::BulkString(_) | Value::SimpleString(_) | Value::VerbatimString { .. } => J::String(text(v)),
        Value::Okay => J::String("OK".into()),
        Value::Double(d) => serde_json::Number::from_f64(*d).map(J::Number).unwrap_or(J::String(d.to_string())),
        Value::Boolean(b) => J::Bool(*b),
        Value::BigNumber(n) => J::String(n.to_string()),
        Value::Array(items) | Value::Set(items) => J::Array(items.iter().map(redis_to_json).collect()),
        Value::Map(pairs) => J::Object(
            pairs
                .iter()
                .map(|(k, v)| (text(k), redis_to_json(v)))
                .collect(),
        ),
        Value::Attribute { data, .. } => redis_to_json(data),
        Value::Push { data, .. } => J::Array(data.iter().map(redis_to_json).collect()),
        Value::ServerError(e) => J::String(format!("ERR {}", e.details().unwrap_or(""))),
        #[allow(unreachable_patterns)]
        _ => J::Null,
    }
}

impl RedisSession {
    pub async fn connect(
        cfg: &ConnectionConfig,
        password: Option<&str>,
        database: Option<&str>,
    ) -> AppResult<Self> {
        let db: i64 = database
            .and_then(|d| d.parse().ok())
            .or_else(|| cfg.options.get("redisDb").and_then(|v| v.as_i64()))
            .or_else(|| cfg.database.parse().ok())
            .unwrap_or(0);
        let username = if cfg.user.is_empty() { None } else { Some(cfg.user.clone()) };
        let pass = password.filter(|p| !p.is_empty()).map(|p| p.to_string());

        // Redis has no STARTTLS: a port is either TLS or plain. "prefer" therefore
        // means plain; only "require"/"verify" switch to TLS.
        let tls = matches!(cfg.ssl_mode, SslMode::Require | SslMode::Verify);
        let scheme = if tls { "rediss" } else { "redis" };
        let auth = match (&username, &pass) {
            (Some(u), Some(p)) => format!("{}:{}@", urlencode(u), urlencode(p)),
            (None, Some(p)) => format!(":{}@", urlencode(p)),
            (Some(u), None) => format!("{}@", urlencode(u)),
            (None, None) => String::new(),
        };
        let url = format!("{scheme}://{auth}{}:{}/{db}", cfg.host, cfg.port);
        let mut info: ConnectionInfo = url.into_connection_info()?;
        if cfg.ssl_mode == SslMode::Require {
            info = info.set_addr(ConnectionAddr::TcpTls {
                host: cfg.host.clone(),
                port: cfg.port,
                insecure: true,
                tls_params: None,
            });
        }
        let client = redis::Client::open(info)?;
        let manager = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            client.get_connection_manager(),
        )
        .await
        .map_err(|_| AppError::Connect("timeout".into()))??;
        let mut conn = manager.clone();
        let _: String = cmd("PING").query_async(&mut conn).await?;
        Ok(RedisSession {
            conn: Mutex::new(manager),
            client,
            db,
            host: cfg.host.clone(),
        })
    }

    pub async fn close(&self) {
        let _ = &self.host;
    }

    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let mut c = self.conn.lock().await.clone();
        let info: String = cmd("INFO").arg("server").query_async(&mut c).await?;
        let version = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_version:"))
            .unwrap_or("")
            .trim()
            .to_string();
        let dbsize: i64 = cmd("DBSIZE").query_async(&mut c).await.unwrap_or(0);
        Ok(ServerInfo {
            driver: DriverKind::Redis,
            version,
            database: Some(self.db.to_string()),
            user: None,
            extra: serde_json::json!({ "keys": dbsize }),
        })
    }

    /// Parsed `INFO` sections as nested JSON for the dashboard.
    pub async fn info(&self) -> AppResult<serde_json::Value> {
        let mut c = self.conn.lock().await.clone();
        let info: String = cmd("INFO").query_async(&mut c).await?;
        let mut out = serde_json::Map::new();
        let mut section = String::from("general");
        for line in info.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(name) = line.strip_prefix("# ") {
                section = name.to_lowercase();
                continue;
            }
            if let Some((k, v)) = line.split_once(':') {
                out.entry(section.clone())
                    .or_insert_with(|| serde_json::Value::Object(Default::default()))
                    .as_object_mut()
                    .unwrap()
                    .insert(k.to_string(), serde_json::Value::String(v.to_string()));
            }
        }
        Ok(serde_json::Value::Object(out))
    }

    pub async fn databases(&self) -> AppResult<Vec<String>> {
        let mut c = self.conn.lock().await.clone();
        let n: i64 = match cmd("CONFIG").arg("GET").arg("databases").query_async::<Vec<String>>(&mut c).await {
            Ok(v) if v.len() == 2 => v[1].parse().unwrap_or(16),
            _ => 16,
        };
        Ok((0..n).map(|i| i.to_string()).collect())
    }

    pub async fn scan(&self, req: &RedisScanRequest) -> AppResult<RedisScanResult> {
        let mut c = self.conn.lock().await.clone();
        let count = if req.count == 0 { 200 } else { req.count.min(5000) };
        let mut command = cmd("SCAN");
        command.arg(req.cursor).arg("MATCH").arg(if req.pattern.is_empty() { "*" } else { &req.pattern }).arg("COUNT").arg(count);
        if let Some(t) = req.type_filter.as_ref().filter(|t| !t.is_empty()) {
            command.arg("TYPE").arg(t);
        }
        let (cursor, keys): (u64, Vec<String>) = command.query_async(&mut c).await?;
        let infos = self.keys_info(&keys).await?;
        Ok(RedisScanResult {
            cursor,
            keys: infos,
            done: cursor == 0,
        })
    }

    pub async fn keys_info(&self, keys: &[String]) -> AppResult<Vec<RedisKeyInfo>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let mut c = self.conn.lock().await.clone();
        let mut pipe = redis::pipe();
        for k in keys {
            pipe.cmd("TYPE").arg(k).cmd("TTL").arg(k);
        }
        let raw: Vec<Value> = pipe.query_async(&mut c).await?;
        let mut out = Vec::with_capacity(keys.len());
        for (i, k) in keys.iter().enumerate() {
            let kind = raw.get(i * 2).map(text).unwrap_or_default();
            let ttl = raw.get(i * 2 + 1).map(|v| text(v).parse().unwrap_or(-1)).unwrap_or(-1);
            out.push(RedisKeyInfo { key: k.clone(), kind, ttl, size: None });
        }
        Ok(out)
    }

    pub async fn value(&self, req: &RedisValueRequest) -> AppResult<RedisValue> {
        let mut c = self.conn.lock().await.clone();
        let key = req.key.as_str();
        let kind: String = cmd("TYPE").arg(key).query_async(&mut c).await?;
        let ttl: i64 = cmd("TTL").arg(key).query_async(&mut c).await?;
        let count = if req.count == 0 { 200 } else { req.count.min(5000) } as i64;
        let pattern = if req.pattern.is_empty() { "*" } else { req.pattern.as_str() };
        let mut entries = Vec::new();
        let mut cursor = 0u64;
        let mut total = 0i64;
        let mut truncated = false;
        match kind.as_str() {
            "string" => {
                let len: i64 = cmd("STRLEN").arg(key).query_async(&mut c).await?;
                total = len;
                if len > 5_000_000 {
                    let v: Value = cmd("GETRANGE").arg(key).arg(0).arg(1_000_000).query_async(&mut c).await?;
                    entries.push(RedisEntry { field: None, value: text(&v), score: None });
                    truncated = true;
                } else {
                    let v: Value = cmd("GET").arg(key).query_async(&mut c).await?;
                    entries.push(RedisEntry { field: None, value: text(&v), score: None });
                }
            }
            "hash" => {
                total = cmd("HLEN").arg(key).query_async(&mut c).await?;
                let (next, items): (u64, Vec<Value>) = cmd("HSCAN")
                    .arg(key).arg(req.cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count)
                    .query_async(&mut c).await?;
                cursor = next;
                for pair in items.chunks(2) {
                    entries.push(RedisEntry {
                        field: Some(text(&pair[0])),
                        value: pair.get(1).map(text).unwrap_or_default(),
                        score: None,
                    });
                }
            }
            "list" => {
                total = cmd("LLEN").arg(key).query_async(&mut c).await?;
                let start = req.start.max(0);
                let items: Vec<Value> = cmd("LRANGE").arg(key).arg(start).arg(start + count - 1).query_async(&mut c).await?;
                for (i, v) in items.iter().enumerate() {
                    entries.push(RedisEntry { field: Some((start + i as i64).to_string()), value: text(v), score: None });
                }
                truncated = start + (entries.len() as i64) < total;
            }
            "set" => {
                total = cmd("SCARD").arg(key).query_async(&mut c).await?;
                let (next, items): (u64, Vec<Value>) = cmd("SSCAN")
                    .arg(key).arg(req.cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count)
                    .query_async(&mut c).await?;
                cursor = next;
                for v in &items {
                    entries.push(RedisEntry { field: None, value: text(v), score: None });
                }
            }
            "zset" => {
                total = cmd("ZCARD").arg(key).query_async(&mut c).await?;
                let (next, items): (u64, Vec<Value>) = cmd("ZSCAN")
                    .arg(key).arg(req.cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count)
                    .query_async(&mut c).await?;
                cursor = next;
                for pair in items.chunks(2) {
                    entries.push(RedisEntry {
                        field: None,
                        value: text(&pair[0]),
                        score: pair.get(1).and_then(|s| text(s).parse().ok()),
                    });
                }
            }
            "stream" => {
                total = cmd("XLEN").arg(key).query_async(&mut c).await?;
                let items: Value = cmd("XREVRANGE").arg(key).arg("+").arg("-").arg("COUNT").arg(count).query_async(&mut c).await?;
                if let Value::Array(list) = items {
                    for entry in list {
                        if let Value::Array(parts) = entry {
                            let id = parts.first().map(text).unwrap_or_default();
                            let fields = parts.get(1).map(redis_to_json).unwrap_or(serde_json::Value::Null);
                            // flat [k, v, k, v] → object
                            let obj = match fields {
                                serde_json::Value::Array(flat) => {
                                    let mut m = serde_json::Map::new();
                                    for kv in flat.chunks(2) {
                                        let k = kv[0].as_str().map(|s| s.to_string()).unwrap_or(kv[0].to_string());
                                        m.insert(k, kv.get(1).cloned().unwrap_or(serde_json::Value::Null));
                                    }
                                    serde_json::Value::Object(m)
                                }
                                other => other,
                            };
                            entries.push(RedisEntry { field: Some(id), value: obj.to_string(), score: None });
                        }
                    }
                }
                truncated = (entries.len() as i64) < total;
            }
            "none" => return Err(AppError::Query(format!("key {key} does not exist"))),
            _ => {
                // ReJSON and friends: try the module's read command, else just the type
                if kind == "ReJSON-RL" {
                    if let Ok(v) = cmd("JSON.GET").arg(key).query_async::<Value>(&mut c).await {
                        entries.push(RedisEntry { field: None, value: text(&v), score: None });
                        total = 1;
                    }
                }
            }
        }
        Ok(RedisValue {
            key: req.key.clone(),
            kind,
            ttl,
            total,
            entries,
            cursor,
            truncated,
        })
    }

    pub async fn mutate(&self, m: &RedisMutation) -> AppResult<()> {
        let mut c = self.conn.lock().await.clone();
        match m {
            RedisMutation::SetString { key, value } => {
                // keep the TTL the key had
                let ttl: i64 = cmd("TTL").arg(key).query_async(&mut c).await?;
                let mut command = cmd("SET");
                command.arg(key).arg(value);
                if ttl > 0 {
                    command.arg("EX").arg(ttl);
                }
                let _: Value = command.query_async(&mut c).await?;
            }
            RedisMutation::HashSet { key, field, value } => {
                let _: i64 = c.hset(key, field, value).await?;
            }
            RedisMutation::HashDel { key, field } => {
                let _: i64 = c.hdel(key, field).await?;
            }
            RedisMutation::ListSet { key, index, value } => {
                let _: Value = cmd("LSET").arg(key).arg(index).arg(value).query_async(&mut c).await?;
            }
            RedisMutation::ListPush { key, value, head } => {
                let _: i64 = if *head { c.lpush(key, value).await? } else { c.rpush(key, value).await? };
            }
            RedisMutation::ListRem { key, value } => {
                let _: i64 = c.lrem(key, 1, value).await?;
            }
            RedisMutation::SetAdd { key, member } => {
                let _: i64 = c.sadd(key, member).await?;
            }
            RedisMutation::SetRem { key, member } => {
                let _: i64 = c.srem(key, member).await?;
            }
            RedisMutation::ZAdd { key, member, score } => {
                let _: Value = cmd("ZADD").arg(key).arg(score).arg(member).query_async(&mut c).await?;
            }
            RedisMutation::ZRem { key, member } => {
                let _: i64 = c.zrem(key, member).await?;
            }
            RedisMutation::Expire { key, seconds } => {
                let _: i64 = c.expire(key, *seconds).await?;
            }
            RedisMutation::Persist { key } => {
                let _: i64 = c.persist(key).await?;
            }
            RedisMutation::Rename { key, new_key } => {
                let _: Value = cmd("RENAME").arg(key).arg(new_key).query_async(&mut c).await?;
            }
            RedisMutation::Delete { keys } => {
                if !keys.is_empty() {
                    let _: i64 = cmd("UNLINK").arg(keys).query_async(&mut c).await?;
                }
            }
        }
        Ok(())
    }

    /// `SLOWLOG GET n`, newest first.
    pub async fn slowlog(&self, count: u32) -> AppResult<Vec<SlowlogEntry>> {
        let mut c = self.conn.lock().await.clone();
        let raw: Value = cmd("SLOWLOG").arg("GET").arg(count.clamp(1, 1024)).query_async(&mut c).await?;
        let Value::Array(items) = raw else { return Ok(vec![]) };
        Ok(items
            .into_iter()
            .filter_map(|e| match e {
                Value::Array(f) => Some(SlowlogEntry {
                    id: f.first().map(text).and_then(|s| s.parse().ok()).unwrap_or(0),
                    at: f.get(1).map(text).and_then(|s| s.parse().ok()).unwrap_or(0),
                    duration_us: f.get(2).map(text).and_then(|s| s.parse().ok()).unwrap_or(0),
                    command: match f.get(3) {
                        Some(Value::Array(args)) => args.iter().map(text).collect::<Vec<_>>().join(" "),
                        Some(v) => text(v),
                        None => String::new(),
                    },
                    client: f.get(4).map(text).unwrap_or_default(),
                    name: f.get(5).map(text).unwrap_or_default(),
                }),
                _ => None,
            })
            .collect())
    }

    /// Sample up to `sample` keys matching `pattern`, ask MEMORY USAGE for
    /// each and group by the first `:` segment.
    pub async fn memory_report(&self, pattern: &str, sample: u64) -> AppResult<MemoryReport> {
        let mut c = self.conn.lock().await.clone();
        let mut cursor = 0u64;
        let mut groups: std::collections::HashMap<String, MemoryGroup> = std::collections::HashMap::new();
        let mut sampled = 0u64;
        let mut total = 0u64;
        let limit = sample.clamp(100, 200_000);
        let done = loop {
            let (next, keys): (u64, Vec<String>) = cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(if pattern.is_empty() { "*" } else { pattern })
                .arg("COUNT")
                .arg(500)
                .query_async(&mut c)
                .await?;
            if !keys.is_empty() {
                let mut pipe = redis::pipe();
                for k in &keys {
                    pipe.cmd("MEMORY").arg("USAGE").arg(k).arg("SAMPLES").arg(0);
                }
                let sizes: Vec<Value> = pipe.query_async(&mut c).await?;
                for (k, v) in keys.iter().zip(sizes) {
                    let bytes: u64 = text(&v).parse().unwrap_or(0);
                    let prefix = k.split_once(':').map(|(p, _)| p.to_string()).unwrap_or_else(|| "(no prefix)".to_string());
                    let g = groups.entry(prefix.clone()).or_insert(MemoryGroup { prefix, keys: 0, bytes: 0 });
                    g.keys += 1;
                    g.bytes += bytes;
                    sampled += 1;
                    total += bytes;
                }
            }
            cursor = next;
            if cursor == 0 {
                break true;
            }
            if sampled >= limit {
                break false;
            }
        };
        let mut groups: Vec<MemoryGroup> = groups.into_values().collect();
        groups.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.prefix.cmp(&b.prefix)));
        Ok(MemoryReport { sampled, total_bytes: total, done, groups })
    }

    /// Dedicated pub/sub connection; the caller drives the stream.
    pub async fn pubsub(&self, channels: &[String], patterns: &[String]) -> AppResult<redis::aio::PubSub> {
        let mut ps = self.client.get_async_pubsub().await?;
        for ch in channels {
            ps.subscribe(ch).await?;
        }
        for p in patterns {
            ps.psubscribe(p).await?;
        }
        Ok(ps)
    }

    pub async fn publish(&self, channel: &str, message: &str) -> AppResult<i64> {
        let mut c = self.conn.lock().await.clone();
        Ok(cmd("PUBLISH").arg(channel).arg(message).query_async(&mut c).await?)
    }

    /// Run a raw command line (`HGETALL user:1`) and return the reply as JSON.
    pub async fn command(&self, line: &str) -> AppResult<(serde_json::Value, u64)> {
        let parts = split_args(line);
        let Some((name, args)) = parts.split_first() else {
            return Ok((serde_json::Value::Null, 0));
        };
        let upper = name.to_ascii_uppercase();
        if matches!(upper.as_str(), "SUBSCRIBE" | "PSUBSCRIBE" | "MONITOR" | "SYNC" | "PSYNC") {
            return Err(AppError::Unsupported(format!("{upper} in the console")));
        }
        let mut c = self.conn.lock().await.clone();
        let mut command = cmd(&upper);
        for a in args {
            command.arg(a);
        }
        let started = Instant::now();
        let v: Value = command.query_async(&mut c).await?;
        Ok((redis_to_json(&v), started.elapsed().as_millis() as u64))
    }
}

/// Split a console line into arguments, honouring single/double quotes and
/// backslash escapes inside double quotes (like redis-cli).
pub fn split_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = line.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;
    while let Some(ch) = chars.next() {
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
        } else if in_double {
            match ch {
                '"' => in_double = false,
                '\\' => match chars.next() {
                    Some('n') => cur.push('\n'),
                    Some('t') => cur.push('\t'),
                    Some('r') => cur.push('\r'),
                    Some(c) => cur.push(c),
                    None => {}
                },
                c => cur.push(c),
            }
        } else {
            match ch {
                '\'' => {
                    in_single = true;
                    has_token = true;
                }
                '"' => {
                    in_double = true;
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        out.push(std::mem::take(&mut cur));
                        has_token = false;
                    }
                }
                c => {
                    cur.push(c);
                    has_token = true;
                }
            }
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::split_args;

    #[test]
    fn splits_like_redis_cli() {
        assert_eq!(split_args("HSET user:1 name \"Ana Maria\" bio 'it''s'"), vec!["HSET", "user:1", "name", "Ana Maria", "bio", "its"]);
        assert_eq!(split_args("  GET   k  "), vec!["GET", "k"]);
        assert_eq!(split_args("SET k \"\""), vec!["SET", "k", ""]);
        assert_eq!(split_args("SET k \"a\\nb\""), vec!["SET", "k", "a\nb"]);
    }
}
