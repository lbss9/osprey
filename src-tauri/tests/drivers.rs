//! Integration tests against real servers. Ignored by default; run with
//!
//!   OSPREY_TEST_PG=postgres://user:pass@host:port/db \
//!   OSPREY_TEST_MYSQL=mysql://user:pass@host:port/db \
//!   OSPREY_TEST_REDIS=redis://:pass@host:port/0 \
//!   cargo test --test drivers -- --ignored --nocapture
//!
//! Each suite creates its own schema/keys, exercises the driver the way the
//! UI does (catalog, paging, edits in a transaction, multi-statement, cancel)
//! and cleans up.

use std::time::Duration;

use osprey_lib::drivers::{self, sql::Dialect, Session, SqlDriver};
use osprey_lib::models::*;
use serde_json::{json, Value};

fn url_parts(var: &str) -> Option<(String, u16, String, String, String)> {
    let raw = std::env::var(var).ok()?;
    let rest = raw.split("://").nth(1)?;
    let (auth, hostdb) = rest.rsplit_once('@').unwrap_or(("", rest));
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let (hostport, db) = hostdb.split_once('/').unwrap_or((hostdb, ""));
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "0"));
    Some((host.into(), port.parse().ok()?, user.into(), pass.into(), db.into()))
}

fn config(var: &str, driver: DriverKind) -> Option<(ConnectionConfig, String)> {
    let (host, port, user, pass, db) = url_parts(var)?;
    Some((
        ConnectionConfig {
            id: format!("test-{}", driver.as_str()),
            name: "test".into(),
            driver,
            host,
            port,
            user,
            database: db,
            ssl_mode: SslMode::Prefer,
            color: None,
            group: None,
            read_only: false,
            options: json!({}),
            position: 0,
            created_at: 0,
            last_used_at: None,
            has_password: false,
            has_ssh_password: false,
        },
        pass,
    ))
}

async fn sql_session(var: &str, driver: DriverKind) -> Option<std::sync::Arc<dyn SqlDriver>> {
    let (cfg, pass) = config(var, driver)?;
    let (s, _) = drivers::connect(&cfg, Some(&pass), None, None).await.expect("connect");
    Some(s.sql().unwrap())
}

fn cell<'a>(set: &'a ResultSet, row: usize, col: &str) -> &'a Value {
    let i = set.columns.iter().position(|c| c.name == col).unwrap_or_else(|| panic!("column {col}"));
    &set.rows[row][i]
}

fn page(schema: &str, table: &str, filters: Vec<TableFilter>, sort: Option<SortSpec>, limit: u32, offset: u64) -> TablePageRequest {
    TablePageRequest { schema: schema.into(), table: table.into(), filters, raw_where: None, sort, limit, offset }
}

/* ================================ PostgreSQL =============================== */

#[tokio::test]
#[ignore]
async fn postgres_end_to_end() {
    drivers::init_crypto();
    let Some(d) = sql_session("OSPREY_TEST_PG", DriverKind::Postgres).await else {
        eprintln!("OSPREY_TEST_PG not set; skipping");
        return;
    };
    let info = d.server_info().await.unwrap();
    println!("postgres {} db={:?} user={:?}", info.version, info.database, info.user);
    assert!(info.version.starts_with(|c: char| c.is_ascii_digit()));

    // schema with every kind of column the grid cares about
    d.execute_transaction(&[
        "DROP SCHEMA IF EXISTS osprey_t CASCADE".into(),
        "CREATE SCHEMA osprey_t".into(),
        "CREATE TABLE osprey_t.people (id serial PRIMARY KEY, name text NOT NULL, age int, score numeric(8,2), active bool DEFAULT true, born date, seen timestamptz, meta jsonb, uid uuid DEFAULT gen_random_uuid(), blob bytea, tags text[], note text)".into(),
        "COMMENT ON TABLE osprey_t.people IS 'test people'".into(),
        "INSERT INTO osprey_t.people (name, age, score, active, born, seen, meta, blob, tags) SELECT 'person ' || g, 20 + (g % 50), g * 1.5, g % 2 = 0, date '2000-01-01' + g, now() - (g || ' minutes')::interval, jsonb_build_object('n', g), decode('deadbeef', 'hex'), ARRAY['a', 'b'] FROM generate_series(1, 5000) g".into(),
        "CREATE TABLE osprey_t.nopk (x int, y text)".into(),
        "INSERT INTO osprey_t.nopk VALUES (1, 'a'), (2, 'b')".into(),
        "CREATE TABLE osprey_t.orders (id bigserial PRIMARY KEY, person_id int REFERENCES osprey_t.people(id) ON DELETE CASCADE, total numeric)".into(),
        "CREATE INDEX orders_person_idx ON osprey_t.orders(person_id)".into(),
        "CREATE VIEW osprey_t.adults AS SELECT * FROM osprey_t.people WHERE age >= 18".into(),
        "ANALYZE osprey_t.people".into(),
    ])
    .await
    .unwrap();

    // catalog
    let dbs = d.list_databases(false).await.unwrap();
    assert!(dbs.iter().any(|x| x == info.database.as_deref().unwrap()));
    let schemas = d.list_schemas(false).await.unwrap();
    assert_eq!(schemas[0], "public");
    assert!(schemas.contains(&"osprey_t".to_string()));
    assert!(!schemas.contains(&"pg_catalog".to_string()));
    let all = d.list_schemas(true).await.unwrap();
    assert!(all.contains(&"pg_catalog".to_string()) && all.contains(&"information_schema".to_string()));
    assert!(d.list_databases(true).await.unwrap().iter().any(|x| x.starts_with("template")));
    let tables = d.list_tables("osprey_t").await.unwrap();
    let names: Vec<_> = tables.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect();
    assert!(names.contains(&("people", "table")));
    assert!(names.contains(&("adults", "view")));
    let people = tables.iter().find(|t| t.name == "people").unwrap();
    assert_eq!(people.comment.as_deref(), Some("test people"));
    assert!(people.row_estimate.unwrap_or(0) > 4000, "row estimate {:?}", people.row_estimate);

    let cols = d.columns("osprey_t", "people").await.unwrap();
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.primary_key && id.auto_increment && !id.nullable);
    assert_eq!(cols.iter().find(|c| c.name == "score").unwrap().data_type, "numeric(8,2)");
    assert_eq!(cols.iter().find(|c| c.name == "tags").unwrap().data_type, "text[]");
    let st = d.structure("osprey_t", "orders").await.unwrap();
    assert!(st.indexes.iter().any(|i| i.primary));
    assert!(st.indexes.iter().any(|i| i.name == "orders_person_idx" && i.columns == vec!["person_id"]));
    let fk = &st.foreign_keys[0];
    assert_eq!((fk.ref_schema.as_str(), fk.ref_table.as_str()), ("osprey_t", "people"));
    assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));

    // paging + filters + sort, as the table view does
    let dialect = Dialect::Postgres;
    let req = page(
        "osprey_t",
        "people",
        vec![
            TableFilter { column: "name".into(), op: "contains".into(), value: Some("PERSON 12".into()) },
            TableFilter { column: "active".into(), op: "eq".into(), value: Some("true".into()) },
        ],
        Some(SortSpec { column: "id".into(), desc: true }),
        10,
        0,
    );
    let sql = dialect.select_page(&req).unwrap();
    let set = d.query(&sql, 10).await.unwrap().pop().unwrap();
    assert_eq!(set.columns.len(), 12);
    assert!(set.rows.len() > 1 && set.rows.len() <= 10);
    // typed via prepare: id is int4 → JSON number; name string; active bool
    assert_eq!(set.columns.iter().find(|c| c.name == "id").unwrap().kind, ColumnKind::Number);
    assert!(cell(&set, 0, "id").is_number());
    assert_eq!(cell(&set, 0, "active"), &Value::Bool(true));
    assert!(cell(&set, 0, "name").as_str().unwrap().to_lowercase().contains("person 12"));
    assert_eq!(cell(&set, 0, "blob").as_str().unwrap(), "\\xdeadbeef");
    assert_eq!(cell(&set, 0, "tags").as_str().unwrap(), "{a,b}");
    let count_sql = dialect.select_count(&req).unwrap();
    let count = d.query(&count_sql, 1).await.unwrap().pop().unwrap();
    let n = count.rows[0][0].as_i64().unwrap();
    assert!(n > 1, "count {n}");
    // second page is different
    let mut req2 = page("osprey_t", "people", vec![], Some(SortSpec { column: "id".into(), desc: false }), 5, 5);
    req2.raw_where = Some("age > 30".into());
    let p2 = d.query(&dialect.select_page(&req2).unwrap(), 5).await.unwrap().pop().unwrap();
    assert_eq!(p2.rows.len(), 5);
    assert!(cell(&p2, 0, "age").as_i64().unwrap() > 30);

    // pending edits → UPDATE / INSERT / DELETE in one transaction
    let changes = ApplyChangesRequest {
        schema: "osprey_t".into(),
        table: "people".into(),
        preview: false,
        changes: vec![
            RowChange::Update {
                key: json!({"id": 1}).as_object().unwrap().clone(),
                set: json!({"name": "O'Brien \\ test", "age": null, "score": "12.34", "active": false, "meta": "{\"k\": [1, 2]}"}).as_object().unwrap().clone(),
            },
            RowChange::Insert { values: json!({"name": "new one", "age": 99, "uid": {"$default": true}}).as_object().unwrap().clone() },
            RowChange::Delete { key: json!({"id": 2}).as_object().unwrap().clone() },
        ],
    };
    let stmts = dialect.changes(&changes).unwrap();
    let affected = d.execute_transaction(&stmts).await.unwrap();
    assert_eq!(affected, 3);
    let check = d.query("SELECT name, age, score, active, meta->'k' AS k FROM osprey_t.people WHERE id = 1", 1).await.unwrap().pop().unwrap();
    assert_eq!(cell(&check, 0, "name"), "O'Brien \\ test");
    assert_eq!(cell(&check, 0, "age"), &Value::Null);
    assert_eq!(cell(&check, 0, "score"), &json!(12.34));
    assert_eq!(cell(&check, 0, "active"), &Value::Bool(false));
    assert_eq!(cell(&check, 0, "k").as_str().unwrap(), "[1, 2]");
    let gone = d.query("SELECT count(*) FROM osprey_t.people WHERE id = 2", 1).await.unwrap().pop().unwrap();
    assert_eq!(gone.rows[0][0], json!(0));
    let added = d.query("SELECT age FROM osprey_t.people WHERE name = 'new one'", 1).await.unwrap().pop().unwrap();
    assert_eq!(added.rows[0][0], json!(99));

    // failing statement rolls the whole transaction back
    let err = d.execute_transaction(&["UPDATE osprey_t.people SET age = 1 WHERE id = 3".into(), "UPDATE osprey_t.people SET nope = 1".into()]).await;
    assert!(err.is_err());
    let rolled = d.query("SELECT age FROM osprey_t.people WHERE id = 3", 1).await.unwrap().pop().unwrap();
    assert_ne!(rolled.rows[0][0], json!(1));

    // multi-statement user query: two result sets + a command
    let sets = d.query("SELECT 1 AS a; UPDATE osprey_t.people SET note = 'x' WHERE id < 10; SELECT name FROM osprey_t.people ORDER BY id LIMIT 2;", 100).await.unwrap();
    assert_eq!(sets.len(), 3);
    assert_eq!(sets[0].rows[0][0], json!("1")); // prepare fails on multi-statement → text
    assert_eq!(sets[0].columns[0].kind, ColumnKind::Other);
    assert_eq!(sets[1].affected, Some(8)); // id 2 was deleted above
    assert_eq!(sets[2].rows.len(), 2);

    // truncation + error reporting
    let big = d.query("SELECT * FROM osprey_t.people", 100).await.unwrap().pop().unwrap();
    assert!(big.truncated && big.rows.len() == 100);
    let e = d.query("SELECT * FROM osprey_t.missing", 10).await.unwrap_err().to_string();
    assert!(e.starts_with("errors.query|") && e.contains("osprey_t.missing"), "{e}");

    // cancel a long statement from another task
    let d2 = d.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        d2.cancel().await.unwrap();
    });
    let started = std::time::Instant::now();
    let r = d.query("SELECT pg_sleep(20)", 10).await;
    canceller.await.unwrap();
    assert!(r.is_err(), "sleep should have been cancelled");
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    // connection still usable afterwards
    let ok = d.query("SELECT 2 AS two", 1).await.unwrap().pop().unwrap();
    assert_eq!(ok.rows[0][0], json!(2));

    // no-PK table: grid must refuse edits (dialect level)
    let bad = Dialect::Postgres.changes(&ApplyChangesRequest { schema: "osprey_t".into(), table: "nopk".into(), preview: true, changes: vec![RowChange::Delete { key: Default::default() }] });
    assert!(bad.is_err());

    d.execute_transaction(&["DROP SCHEMA osprey_t CASCADE".into()]).await.unwrap();
    d.close().await;
    println!("postgres OK");
}

/* =================================== MySQL ================================== */

#[tokio::test]
#[ignore]
async fn mysql_end_to_end() {
    drivers::init_crypto();
    let Some(d) = sql_session("OSPREY_TEST_MYSQL", DriverKind::Mysql).await else {
        eprintln!("OSPREY_TEST_MYSQL not set; skipping");
        return;
    };
    let info = d.server_info().await.unwrap();
    println!("mysql {} db={:?} user={:?}", info.version, info.database, info.user);

    d.execute_transaction(&[
        "DROP DATABASE IF EXISTS osprey_t".into(),
        "CREATE DATABASE osprey_t".into(),
        "CREATE TABLE osprey_t.people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, age INT, score DECIMAL(8,2), active TINYINT(1) DEFAULT 1, born DATE, seen DATETIME(3), meta JSON, blob_ BLOB, kind ENUM('a','b') DEFAULT 'a', note TEXT) COMMENT='test people'".into(),
        "CREATE TABLE osprey_t.orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, person_id INT, total DECIMAL(10,2), INDEX orders_person_idx (person_id), CONSTRAINT fk_person FOREIGN KEY (person_id) REFERENCES osprey_t.people(id) ON DELETE CASCADE)".into(),
        "CREATE TABLE osprey_t.nopk (x INT, y TEXT)".into(),
        "CREATE VIEW osprey_t.adults AS SELECT * FROM osprey_t.people WHERE age >= 18".into(),
    ])
    .await
    .unwrap();
    // bulk insert through a recursive CTE
    d.execute_transaction(&["INSERT INTO osprey_t.people (name, age, score, active, born, seen, meta, blob_) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 900) SELECT CONCAT('person ', n), 20 + (n % 50), n * 1.5, n % 2 = 0, DATE_ADD('2000-01-01', INTERVAL n DAY), NOW(3), JSON_OBJECT('n', n), UNHEX('DEADBEEF') FROM g".into()]).await.unwrap();

    let dbs = d.list_databases(false).await.unwrap();
    assert!(dbs.contains(&"osprey_t".to_string()) && !dbs.contains(&"mysql".to_string()));
    let all = d.list_databases(true).await.unwrap();
    assert!(all.contains(&"mysql".to_string()));
    assert!(all.iter().position(|x| x == "osprey_t") < all.iter().position(|x| x == "mysql"), "user dbs first: {all:?}");
    let tables = d.list_tables("osprey_t").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "people" && t.kind == "table" && t.comment.as_deref() == Some("test people")));
    assert!(tables.iter().any(|t| t.name == "adults" && t.kind == "view"));
    let cols = d.columns("osprey_t", "people").await.unwrap();
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.primary_key && id.auto_increment);
    assert_eq!(cols.iter().find(|c| c.name == "active").unwrap().data_type, "tinyint(1)");
    let st = d.structure("osprey_t", "orders").await.unwrap();
    assert!(st.indexes.iter().any(|i| i.primary));
    assert!(st.indexes.iter().any(|i| i.name == "orders_person_idx"));
    assert_eq!(st.foreign_keys[0].ref_table, "people");
    assert_eq!(st.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    assert!(st.ddl.as_deref().unwrap_or("").contains("CREATE TABLE"));

    let dialect = Dialect::Mysql;
    let req = page(
        "osprey_t",
        "people",
        vec![TableFilter { column: "name".into(), op: "starts".into(), value: Some("person 1".into()) }],
        Some(SortSpec { column: "age".into(), desc: true }),
        20,
        0,
    );
    let set = d.query(&dialect.select_page(&req).unwrap(), 20).await.unwrap().pop().unwrap();
    assert_eq!(set.rows.len(), 20);
    assert_eq!(set.columns.iter().find(|c| c.name == "id").unwrap().kind, ColumnKind::Number);
    assert!(cell(&set, 0, "id").is_number());
    assert_eq!(set.columns.iter().find(|c| c.name == "active").unwrap().kind, ColumnKind::Bool);
    assert!(cell(&set, 0, "born").as_str().unwrap().len() == 10, "date only: {:?}", cell(&set, 0, "born"));
    assert_eq!(set.columns.iter().find(|c| c.name == "blob_").unwrap().kind, ColumnKind::Bytes);
    // MariaDB has no JSON wire type (it is LONGTEXT with a check), so results say string there
    let maria = info.version.contains("MariaDB");
    let meta_kind = set.columns.iter().find(|c| c.name == "meta").unwrap().kind;
    assert!(meta_kind == ColumnKind::Json || (maria && meta_kind == ColumnKind::String), "{meta_kind:?}");
    let cols = d.columns("osprey_t", "people").await.unwrap();
    assert_eq!(cols.iter().find(|c| c.name == "meta").unwrap().data_type, "json");
    let n = d.query(&dialect.select_count(&req).unwrap(), 1).await.unwrap().pop().unwrap().rows[0][0].clone();
    assert!(n.as_i64().unwrap() > 20, "{n}");

    let changes = ApplyChangesRequest {
        schema: "osprey_t".into(),
        table: "people".into(),
        preview: false,
        changes: vec![
            RowChange::Update {
                key: json!({"id": 1}).as_object().unwrap().clone(),
                set: json!({"name": "O'Brien \\ test", "age": null, "score": "12.34", "active": false, "kind": "b"}).as_object().unwrap().clone(),
            },
            RowChange::Insert { values: json!({"name": "new one", "age": 99, "kind": {"$default": true}}).as_object().unwrap().clone() },
            RowChange::Delete { key: json!({"id": 2}).as_object().unwrap().clone() },
        ],
    };
    let affected = d.execute_transaction(&dialect.changes(&changes).unwrap()).await.unwrap();
    assert_eq!(affected, 3);
    let check = d.query("SELECT name, age, score, active, kind FROM osprey_t.people WHERE id = 1", 1).await.unwrap().pop().unwrap();
    assert_eq!(cell(&check, 0, "name"), "O'Brien \\ test");
    assert_eq!(cell(&check, 0, "age"), &Value::Null);
    assert_eq!(cell(&check, 0, "score"), &json!("12.34"));
    assert_eq!(cell(&check, 0, "active"), &Value::Bool(false));
    assert_eq!(cell(&check, 0, "kind"), "b");

    let err = d.execute_transaction(&["UPDATE osprey_t.people SET age = 1 WHERE id = 3".into(), "UPDATE osprey_t.people SET nope = 1".into()]).await;
    assert!(err.is_err());
    let rolled = d.query("SELECT age FROM osprey_t.people WHERE id = 3", 1).await.unwrap().pop().unwrap();
    assert_ne!(rolled.rows[0][0], json!(1));

    let sets = d.query("SELECT 1 AS a; UPDATE osprey_t.people SET note = 'x' WHERE id < 10; SELECT name FROM osprey_t.people ORDER BY id LIMIT 2", 100).await.unwrap();
    assert_eq!(sets.len(), 3, "{sets:?}");
    assert_eq!(sets[0].rows[0][0], json!(1));
    assert_eq!(sets[1].affected, Some(8));
    assert_eq!(sets[2].rows.len(), 2);

    let big = d.query("SELECT * FROM osprey_t.people", 50).await.unwrap().pop().unwrap();
    assert!(big.truncated && big.rows.len() == 50);
    let e = d.query("SELECT * FROM osprey_t.missing", 10).await.unwrap_err().to_string();
    assert!(e.starts_with("errors.query|"), "{e}");

    let d2 = d.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        d2.cancel().await.unwrap();
    });
    let started = std::time::Instant::now();
    let r = d.query("SELECT SLEEP(20)", 10).await;
    canceller.await.unwrap();
    // MySQL returns 1 from SLEEP when killed instead of an error; either is fine as long as it was fast
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?} ({r:?})", started.elapsed());
    let ok = d.query("SELECT 2 AS two", 1).await.unwrap().pop().unwrap();
    assert_eq!(ok.rows[0][0], json!(2));

    d.execute_transaction(&["DROP DATABASE osprey_t".into()]).await.unwrap();
    d.close().await;
    println!("mysql OK");
}

/* =================================== Redis ================================== */

#[tokio::test]
#[ignore]
async fn redis_end_to_end() {
    drivers::init_crypto();
    let Some((cfg, pass)) = config("OSPREY_TEST_REDIS", DriverKind::Redis) else {
        eprintln!("OSPREY_TEST_REDIS not set; skipping");
        return;
    };
    let (s, _) = drivers::connect(&cfg, Some(&pass), None, None).await.expect("connect");
    let Session::Redis(r) = s else { panic!() };
    let info = r.server_info().await.unwrap();
    println!("redis {} db={:?}", info.version, info.database);

    // seed
    r.command("DEL osprey:s osprey:h osprey:l osprey:set osprey:z osprey:x osprey:ttl user:1:profile user:2:profile").await.unwrap();
    r.mutate(&RedisMutation::SetString { key: "osprey:s".into(), value: "hello \"world\"".into() }).await.unwrap();
    for i in 0..2500 {
        r.mutate(&RedisMutation::HashSet { key: "osprey:h".into(), field: format!("f{i}"), value: format!("v{i}") }).await.unwrap();
    }
    for i in 0..50 {
        r.mutate(&RedisMutation::ListPush { key: "osprey:l".into(), value: format!("item{i}"), head: false }).await.unwrap();
        r.mutate(&RedisMutation::SetAdd { key: "osprey:set".into(), member: format!("m{i}") }).await.unwrap();
        r.mutate(&RedisMutation::ZAdd { key: "osprey:z".into(), member: format!("z{i}"), score: i as f64 * 0.5 }).await.unwrap();
    }
    r.command("XADD osprey:x * name ana age 30").await.unwrap();
    r.command("XADD osprey:x * name bob age 40").await.unwrap();
    r.command("SET user:1:profile x").await.unwrap();
    r.command("SET user:2:profile y").await.unwrap();
    r.mutate(&RedisMutation::SetString { key: "osprey:ttl".into(), value: "t".into() }).await.unwrap();
    r.mutate(&RedisMutation::Expire { key: "osprey:ttl".into(), seconds: 600 }).await.unwrap();

    // scan
    let mut all = Vec::new();
    let mut cursor = 0;
    loop {
        let res = r.scan(&RedisScanRequest { cursor, pattern: "osprey:*".into(), count: 3, type_filter: None }).await.unwrap();
        all.extend(res.keys);
        cursor = res.cursor;
        if res.done {
            break;
        }
    }
    assert_eq!(all.len(), 7, "{all:?}");
    let ttl = all.iter().find(|k| k.key == "osprey:ttl").unwrap();
    assert!(ttl.ttl > 500 && ttl.ttl <= 600);
    assert_eq!(all.iter().find(|k| k.key == "osprey:h").unwrap().kind, "hash");
    let only_hash = r.scan(&RedisScanRequest { cursor: 0, pattern: "osprey:*".into(), count: 100, type_filter: Some("hash".into()) }).await.unwrap();
    assert!(only_hash.keys.iter().all(|k| k.kind == "hash") && !only_hash.keys.is_empty());

    // values by type
    let v = r.value(&RedisValueRequest { key: "osprey:s".into(), cursor: 0, pattern: String::new(), count: 0, start: 0 }).await.unwrap();
    assert_eq!((v.kind.as_str(), v.entries[0].value.as_str(), v.total), ("string", "hello \"world\"", 13));
    let h = r.value(&RedisValueRequest { key: "osprey:h".into(), cursor: 0, pattern: String::new(), count: 100, start: 0 }).await.unwrap();
    assert_eq!(h.total, 2500);
    assert!(h.entries.len() >= 100 && h.cursor != 0, "hscan pages: {} cursor {}", h.entries.len(), h.cursor);
    let h2 = r.value(&RedisValueRequest { key: "osprey:h".into(), cursor: 0, pattern: "f12*".into(), count: 5000, start: 0 }).await.unwrap();
    assert!(h2.entries.iter().all(|e| e.field.as_deref().unwrap().starts_with("f12")) && h2.entries.len() == 111);
    let l = r.value(&RedisValueRequest { key: "osprey:l".into(), cursor: 0, pattern: String::new(), count: 10, start: 5 }).await.unwrap();
    assert_eq!((l.total, l.entries.len(), l.entries[0].field.as_deref(), l.entries[0].value.as_str(), l.truncated), (50, 10, Some("5"), "item5", true));
    let z = r.value(&RedisValueRequest { key: "osprey:z".into(), cursor: 0, pattern: String::new(), count: 1000, start: 0 }).await.unwrap();
    assert_eq!(z.total, 50);
    assert_eq!(z.entries.iter().find(|e| e.value == "z3").unwrap().score, Some(1.5));
    let x = r.value(&RedisValueRequest { key: "osprey:x".into(), cursor: 0, pattern: String::new(), count: 10, start: 0 }).await.unwrap();
    assert_eq!(x.total, 2);
    assert!(x.entries[0].value.contains("\"name\":\"bob\""), "{}", x.entries[0].value);
    let set = r.value(&RedisValueRequest { key: "osprey:set".into(), cursor: 0, pattern: String::new(), count: 1000, start: 0 }).await.unwrap();
    assert_eq!(set.total, 50);

    // mutations keep TTL, delete, rename
    r.mutate(&RedisMutation::SetString { key: "osprey:ttl".into(), value: "t2".into() }).await.unwrap();
    let after = r.keys_info(&["osprey:ttl".into()]).await.unwrap();
    assert!(after[0].ttl > 500, "TTL lost on SET: {}", after[0].ttl);
    r.mutate(&RedisMutation::Persist { key: "osprey:ttl".into() }).await.unwrap();
    assert_eq!(r.keys_info(&["osprey:ttl".into()]).await.unwrap()[0].ttl, -1);
    r.mutate(&RedisMutation::HashDel { key: "osprey:h".into(), field: "f0".into() }).await.unwrap();
    r.mutate(&RedisMutation::ListSet { key: "osprey:l".into(), index: 0, value: "first".into() }).await.unwrap();
    r.mutate(&RedisMutation::ZRem { key: "osprey:z".into(), member: "z0".into() }).await.unwrap();
    r.mutate(&RedisMutation::Rename { key: "osprey:s".into(), new_key: "osprey:s2".into() }).await.unwrap();
    let (reply, _) = r.command("GET osprey:s2").await.unwrap();
    assert_eq!(reply, json!("hello \"world\""));
    let (reply, _) = r.command("HLEN osprey:h").await.unwrap();
    assert_eq!(reply, json!(2499));
    let (reply, _) = r.command("LINDEX osprey:l 0").await.unwrap();
    assert_eq!(reply, json!("first"));

    // console: quoting, JSON reply shapes, errors, blocked commands
    let (reply, _) = r.command("HSET osprey:h \"spaced field\" 'single'").await.unwrap();
    assert_eq!(reply, json!(1));
    let (reply, _) = r.command("HGET osprey:h \"spaced field\"").await.unwrap();
    assert_eq!(reply, json!("single"));
    let (reply, _) = r.command("ZRANGE osprey:z 0 1 WITHSCORES").await.unwrap();
    assert!(reply.is_array(), "{reply}");
    let e = r.command("NOTACOMMAND x").await.unwrap_err().to_string();
    assert!(e.starts_with("errors.query|"), "{e}");
    assert!(r.command("SUBSCRIBE chan").await.is_err());

    // info
    let info = r.info().await.unwrap();
    assert!(info["server"]["redis_version"].is_string());
    assert!(info["memory"]["used_memory_human"].is_string());
    assert!(!r.databases().await.unwrap().is_empty());

    r.mutate(&RedisMutation::Delete { keys: vec!["osprey:s2".into(), "osprey:h".into(), "osprey:l".into(), "osprey:set".into(), "osprey:z".into(), "osprey:x".into(), "osprey:ttl".into(), "user:1:profile".into(), "user:2:profile".into()] }).await.unwrap();
    let (reply, _) = r.command("EXISTS osprey:h").await.unwrap();
    assert_eq!(reply, json!(0));
    println!("redis OK");
}

/* ========================= wrong credentials → auth error ========================= */

#[tokio::test]
#[ignore]
async fn wrong_password_is_reported_as_auth() {
    drivers::init_crypto();
    if let Some((cfg, _)) = config("OSPREY_TEST_PG", DriverKind::Postgres) {
        let e = drivers::connect(&cfg, Some("definitely-wrong"), None, None).await.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(e.starts_with("errors.auth|"), "{e}");
    }
    if let Some((cfg, _)) = config("OSPREY_TEST_MYSQL", DriverKind::Mysql) {
        let e = drivers::connect(&cfg, Some("definitely-wrong"), None, None).await.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(e.starts_with("errors.auth|"), "{e}");
    }
    if let Some((mut cfg, _)) = config("OSPREY_TEST_PG", DriverKind::Postgres) {
        cfg.port = 1; // nothing listens there
        let e = drivers::connect(&cfg, Some("x"), None, None).await.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(e.starts_with("errors.connect|"), "{e}");
    }
}

/* ================================ SSH tunnel ================================ */

/// OSPREY_TEST_SSH=user@host[:port], OSPREY_TEST_SSH_KEY=/path/to/key, and
/// OSPREY_TEST_SSH_PG=host:port/db as seen from the SSH server (user/pass
/// taken from OSPREY_TEST_PG).
#[tokio::test]
#[ignore]
async fn ssh_tunnel_reaches_postgres() {
    drivers::init_crypto();
    let (Ok(ssh), Ok(key)) = (std::env::var("OSPREY_TEST_SSH"), std::env::var("OSPREY_TEST_SSH_KEY")) else {
        eprintln!("OSPREY_TEST_SSH not set; skipping");
        return;
    };
    let Some((mut cfg, pass)) = config("OSPREY_TEST_PG", DriverKind::Postgres) else { return };
    let (user, hostport) = ssh.split_once('@').expect("user@host");
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "22"));
    if let Ok(target) = std::env::var("OSPREY_TEST_SSH_PG") {
        let (hp, db) = target.split_once('/').unwrap_or((&target, "demo"));
        let (h, p) = hp.split_once(':').unwrap_or((hp, "5432"));
        cfg.host = h.into();
        cfg.port = p.parse().unwrap();
        cfg.database = db.into();
    }
    cfg.options = json!({ "ssh": { "enabled": true, "host": host, "port": port.parse::<u16>().unwrap(), "user": user, "auth": "key", "keyPath": key } });
    let (session, tunnel) = drivers::connect(&cfg, Some(&pass), None, None).await.expect("connect through ssh");
    let tunnel = tunnel.expect("a tunnel");
    assert!(tunnel.local_port > 0);
    let d = session.sql().unwrap();
    let info = d.server_info().await.unwrap();
    println!("via ssh: postgres {} on local port {}", info.version, tunnel.local_port);
    assert!(info.version.starts_with(|c: char| c.is_ascii_digit()));
    // several statements over the same tunnel, then a clean close
    let sets = d.query("SELECT 1; SELECT 2", 10).await.unwrap();
    assert_eq!(sets.len(), 2);
    d.close().await;
    tunnel.close().await;

    // wrong key path → auth error, never a hang
    cfg.options["ssh"]["keyPath"] = json!("C:/definitely/missing.key");
    let e = drivers::connect(&cfg, Some(&pass), None, None).await.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(e.starts_with("errors.auth|"), "{e}");
}

/* ================================== SQLite ================================== */

/// Runs everywhere (no server): a temp file exercises the SQLite driver and
/// the DDL builder end to end.
#[tokio::test]
async fn sqlite_end_to_end() {
    let dir = std::env::temp_dir().join(format!("osprey-sqlite-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.db");
    let _ = std::fs::remove_file(&path);
    let cfg = ConnectionConfig {
        id: "test-sqlite".into(),
        name: "sqlite".into(),
        driver: DriverKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: path.to_string_lossy().into_owned(),
        ssl_mode: SslMode::Disable,
        color: None,
        group: None,
        read_only: false,
        options: json!({ "create": true }),
        position: 0,
        created_at: 0,
        last_used_at: None,
        has_password: false,
        has_ssh_password: false,
    };
    let (session, tunnel) = drivers::connect(&cfg, None, None, None).await.expect("open sqlite");
    assert!(tunnel.is_none());
    let d = session.sql().unwrap();
    let info = d.server_info().await.unwrap();
    println!("sqlite {} at {:?}", info.version, info.database);

    // DDL builder → real statements
    let dialect = Dialect::Sqlite;
    let create = DdlOp::CreateTable {
        schema: "main".into(),
        table: "people".into(),
        columns: vec![
            DdlColumn { name: "id".into(), data_type: "INTEGER".into(), nullable: false, default: None, primary_key: true, auto_increment: true },
            DdlColumn { name: "name".into(), data_type: "TEXT".into(), nullable: false, default: None, primary_key: false, auto_increment: false },
            DdlColumn { name: "age".into(), data_type: "INTEGER".into(), nullable: true, default: Some("18".into()), primary_key: false, auto_increment: false },
            DdlColumn { name: "active".into(), data_type: "BOOLEAN".into(), nullable: true, default: Some("1".into()), primary_key: false, auto_increment: false },
        ],
    };
    d.execute_transaction(&dialect.ddl(&create).unwrap()).await.unwrap();
    d.execute_transaction(&dialect.ddl(&DdlOp::CreateIndex { schema: "main".into(), table: "people".into(), name: "people_name_idx".into(), columns: vec!["name".into()], unique: false }).unwrap()).await.unwrap();
    let inserts: Vec<String> = (1..=300).map(|i| format!("INSERT INTO people (name, age) VALUES ('person {i}', {})", 18 + i % 40)).collect();
    assert_eq!(d.execute_transaction(&inserts).await.unwrap(), 300);

    assert_eq!(d.list_schemas(false).await.unwrap(), vec!["main"]);
    let tables = d.list_tables("main").await.unwrap();
    assert!(tables.iter().any(|t| t.name == "people" && t.kind == "table"));
    let cols = d.columns("main", "people").await.unwrap();
    let id = cols.iter().find(|c| c.name == "id").unwrap();
    assert!(id.primary_key && id.auto_increment);
    assert_eq!(cols.iter().find(|c| c.name == "age").unwrap().default.as_deref(), Some("18"));
    let st = d.structure("main", "people").await.unwrap();
    assert!(st.indexes.iter().any(|i| i.name == "people_name_idx" && i.columns == vec!["name"]));
    assert!(st.ddl.as_deref().unwrap().starts_with("CREATE TABLE"));

    // paging with filters, typed cells
    let req = page("main", "people", vec![TableFilter { column: "name".into(), op: "contains".into(), value: Some("PERSON 12".into()) }], Some(SortSpec { column: "id".into(), desc: true }), 10, 0);
    let set = d.query(&dialect.select_page(&req).unwrap(), 10).await.unwrap().pop().unwrap();
    assert!(set.rows.len() > 1 && set.rows.len() <= 10);
    assert!(cell(&set, 0, "id").is_number());
    assert_eq!(cell(&set, 0, "active"), &Value::Bool(true));
    assert_eq!(set.columns.iter().find(|c| c.name == "active").unwrap().kind, ColumnKind::Bool);
    let n = d.query(&dialect.select_count(&req).unwrap(), 1).await.unwrap().pop().unwrap().rows[0][0].as_i64().unwrap();
    assert!(n >= set.rows.len() as i64 && set.rows.len() == 10, "count {n}");

    // grid edits in one transaction + rollback on error
    let changes = ApplyChangesRequest {
        schema: "main".into(),
        table: "people".into(),
        preview: false,
        changes: vec![
            RowChange::Update { key: json!({"id": 1}).as_object().unwrap().clone(), set: json!({"name": "O'Brien", "age": null}).as_object().unwrap().clone() },
            RowChange::Insert { values: json!({"name": "new one", "age": 99}).as_object().unwrap().clone() },
            RowChange::Delete { key: json!({"id": 2}).as_object().unwrap().clone() },
        ],
    };
    assert_eq!(d.execute_transaction(&dialect.changes(&changes).unwrap()).await.unwrap(), 3);
    let check = d.query("SELECT name, age FROM people WHERE id = 1; SELECT count(*) AS n FROM people", 5).await.unwrap();
    assert_eq!(check.len(), 2);
    assert_eq!(cell(&check[0], 0, "name"), "O'Brien");
    assert_eq!(cell(&check[0], 0, "age"), &Value::Null);
    assert_eq!(check[1].rows[0][0], json!(300));
    assert!(d.execute_transaction(&["UPDATE people SET age = 1 WHERE id = 3".into(), "UPDATE people SET nope = 1".into()]).await.is_err());
    let rolled = d.query("SELECT age FROM people WHERE id = 3", 1).await.unwrap().pop().unwrap();
    assert_ne!(rolled.rows[0][0], json!(1));

    // alter: rename works, type change is refused with a clear message
    d.execute_transaction(&dialect.ddl(&DdlOp::AlterColumn { schema: "main".into(), table: "people".into(), name: "age".into(), new_name: Some("years".into()), data_type: None, nullable: None, set_default: false, default: None }).unwrap()).await.unwrap();
    assert!(d.columns("main", "people").await.unwrap().iter().any(|c| c.name == "years"));
    let e = dialect.ddl(&DdlOp::AlterColumn { schema: "main".into(), table: "people".into(), name: "years".into(), new_name: None, data_type: Some("TEXT".into()), nullable: None, set_default: false, default: None }).unwrap_err().to_string();
    assert!(e.starts_with("errors.unsupported|"), "{e}");
    let e = d.query("SELECT * FROM missing", 1).await.unwrap_err().to_string();
    assert!(e.starts_with("errors.query|") && e.contains("missing"), "{e}");
    d.close().await;
    let _ = std::fs::remove_dir_all(&dir);
    println!("sqlite OK");
}

/// Slow log, memory report and pub/sub against a real server.
#[tokio::test]
#[ignore]
async fn redis_tools_end_to_end() {
    use futures_util::StreamExt;
    drivers::init_crypto();
    let Some((cfg, pass)) = config("OSPREY_TEST_REDIS", DriverKind::Redis) else {
        eprintln!("OSPREY_TEST_REDIS not set; skipping");
        return;
    };
    let (s, _) = drivers::connect(&cfg, Some(&pass), None, None).await.expect("connect");
    let Session::Redis(r) = s else { panic!() };

    // slowlog: force one entry by lowering the threshold, then restore it
    r.command("CONFIG SET slowlog-log-slower-than 0").await.unwrap();
    r.command("SET osprey:tools 1").await.unwrap();
    let log = r.slowlog(10).await.unwrap();
    r.command("CONFIG SET slowlog-log-slower-than 10000").await.unwrap();
    assert!(!log.is_empty(), "slowlog should have entries");
    assert!(log.iter().any(|e| e.command.starts_with("SET osprey:tools")), "{log:?}");

    // memory grouped by prefix
    r.command("SET user:1:profile x").await.unwrap();
    r.command("SET user:2:profile y").await.unwrap();
    let rep = r.memory_report("*", 5000).await.unwrap();
    assert!(rep.done && rep.sampled >= 3 && rep.total_bytes > 0, "{rep:?}");
    assert!(rep.groups.iter().any(|g| g.prefix == "user" && g.keys >= 2), "{rep:?}");

    // pub/sub round trip
    let ps = r.pubsub(&["osprey:chan".to_string()], &["osprey:pat:*".to_string()]).await.unwrap();
    let mut stream = ps.into_on_message();
    let n = r.publish("osprey:chan", "hello").await.unwrap();
    assert_eq!(n, 1);
    r.publish("osprey:pat:1", "world").await.unwrap();
    let mut got = vec![];
    while got.len() < 2 {
        let msg = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("message").unwrap();
        got.push((msg.get_channel_name().to_string(), msg.get_payload::<String>().unwrap(), msg.get_pattern::<String>().ok()));
    }
    got.sort();
    assert_eq!(got[0], ("osprey:chan".into(), "hello".into(), None));
    assert_eq!(got[1], ("osprey:pat:1".into(), "world".into(), Some("osprey:pat:*".into())));
    r.command("DEL osprey:tools user:1:profile user:2:profile").await.unwrap();
}

fn collecting_sink() -> (RowSink, std::sync::Arc<std::sync::Mutex<Vec<RowBatch>>>) {
    let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<RowBatch>::new()));
    let g = got.clone();
    let sink: RowSink = std::sync::Arc::new(move |b: RowBatch| g.lock().unwrap().push(b));
    (sink, got)
}

/// Streaming: rows go to the sink in 500-row batches, the reply carries none.
#[tokio::test]
async fn sqlite_streams_rows_in_batches() {
    let dir = std::env::temp_dir().join(format!("osprey-stream-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&dir);
    let cfg = ConnectionConfig {
        id: "test-sqlite-stream".into(),
        name: "sqlite".into(),
        driver: DriverKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: dir.to_string_lossy().into_owned(),
        ssl_mode: SslMode::Disable,
        color: None,
        group: None,
        read_only: false,
        options: json!({ "create": true }),
        position: 0,
        created_at: 0,
        last_used_at: None,
        has_password: false,
        has_ssh_password: false,
    };
    let (session, _) = drivers::connect(&cfg, None, None, None).await.expect("connect");
    let d = session.sql().unwrap();
    let (sink, got) = collecting_sink();
    let sets = d
        .query_with("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1234) SELECT x, 'v' || x AS v FROM n; SELECT 1 AS one", 5000, Some(sink))
        .await
        .unwrap();
    let batches = got.lock().unwrap();
    assert_eq!(sets.len(), 2);
    assert!(sets[0].streamed && sets[0].rows.is_empty() && sets[0].row_count == 1234, "{:?}", sets[0]);
    let first: Vec<&RowBatch> = batches.iter().filter(|b| b.set == 0).collect();
    assert_eq!(first.len(), 3, "500 + 500 + 234");
    assert!(first[0].columns.is_some() && first[1].columns.is_none());
    assert_eq!(first.iter().map(|b| b.rows.len()).sum::<usize>(), 1234);
    assert_eq!(first[0].columns.as_ref().unwrap()[1].name, "v");
    let second: Vec<&RowBatch> = batches.iter().filter(|b| b.set == 1).collect();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].rows[0][0], json!(1));
    // without a sink nothing changes
    let plain = d.query("SELECT 2 AS two", 10).await.unwrap();
    assert!(!plain[0].streamed && plain[0].rows.len() == 1);
    let _ = std::fs::remove_file(&dir);
}

#[tokio::test]
#[ignore]
async fn postgres_streams_rows_in_batches() {
    let Some(d) = sql_session("OSPREY_TEST_PG", DriverKind::Postgres).await else { return };
    let (sink, got) = collecting_sink();
    let sets = d.query_with("SELECT g, g * 2 AS d FROM generate_series(1, 2300) g", 5000, Some(sink)).await.unwrap();
    let batches = got.lock().unwrap();
    assert!(sets[0].streamed && sets[0].rows.is_empty() && sets[0].row_count == 2300);
    assert_eq!(batches.len(), 5);
    assert_eq!(batches.iter().map(|b| b.rows.len()).sum::<usize>(), 2300);
    assert!(batches[0].columns.as_ref().unwrap()[0].kind == ColumnKind::Number);
    // max_rows still applies while streaming
    let (sink, got) = collecting_sink();
    let sets = d.query_with("SELECT g FROM generate_series(1, 2300) g", 700, Some(sink)).await.unwrap();
    assert!(sets[0].truncated && sets[0].row_count == 700);
    assert_eq!(got.lock().unwrap().iter().map(|b| b.rows.len()).sum::<usize>(), 700);
}

#[tokio::test]
#[ignore]
async fn mysql_streams_rows_in_batches() {
    let Some(d) = sql_session("OSPREY_TEST_MYSQL", DriverKind::Mysql).await else { return };
    let (sink, got) = collecting_sink();
    let sets = d
        .query_with("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 900) SELECT x FROM n; SELECT 7 AS seven", 5000, Some(sink))
        .await
        .unwrap();
    let batches = got.lock().unwrap();
    assert_eq!(sets.len(), 2);
    assert!(sets[0].streamed && sets[0].row_count == 900);
    assert_eq!(batches.iter().filter(|b| b.set == 0).count(), 2);
    assert_eq!(batches.iter().filter(|b| b.set == 1).count(), 1);
}

#[tokio::test]
#[ignore]
async fn clickhouse_end_to_end() {
    drivers::init_crypto();
    let Some(d) = sql_session("OSPREY_TEST_CLICKHOUSE", DriverKind::Clickhouse).await else {
        eprintln!("OSPREY_TEST_CLICKHOUSE not set; skipping");
        return;
    };
    let dialect = Dialect::Clickhouse;
    let info = d.server_info().await.unwrap();
    println!("clickhouse {} db={:?} user={:?}", info.version, info.database, info.user);

    d.execute_transaction(&[
        "DROP TABLE IF EXISTS demo.people".into(),
        "CREATE TABLE demo.people (id UInt64, name String, age Nullable(Int32), score Decimal(8,2), active Bool, born Date, seen DateTime, tags Array(String)) ENGINE = MergeTree ORDER BY id".into(),
        "INSERT INTO demo.people SELECT number + 1, concat('person ', toString(number + 1)), if(number % 7 = 0, NULL, toInt32(20 + number % 50)), toDecimal64(number, 2) / 3, number % 2 = 0, toDate('2024-01-01') + number % 28, toDateTime('2024-01-01 10:00:00') + number, ['a', 'b'] FROM numbers(900)".into(),
    ])
    .await
    .unwrap();

    let dbs = d.list_databases(false).await.unwrap();
    assert!(dbs.contains(&"demo".to_string()) && !dbs.contains(&"system".to_string()), "{dbs:?}");
    assert!(d.list_databases(true).await.unwrap().contains(&"system".to_string()));
    let tables = d.list_tables("demo").await.unwrap();
    let t = tables.iter().find(|t| t.name == "people").expect("people listed");
    assert_eq!(t.row_estimate, Some(900));
    let cols = d.columns("demo", "people").await.unwrap();
    assert_eq!(cols.len(), 8);
    assert!(cols[0].primary_key && !cols[0].nullable);
    assert!(cols[2].nullable && cols[2].data_type == "Nullable(Int32)");
    let st = d.structure("demo", "people").await.unwrap();
    assert!(st.indexes.iter().any(|i| i.primary && i.columns == vec!["id".to_string()]));
    assert!(st.ddl.as_deref().unwrap_or("").contains("MergeTree"));
    let all = d.schema_columns("demo").await.unwrap();
    assert!(all.iter().any(|t| t.table == "people" && t.columns.len() == 8));

    let req = page(
        "demo",
        "people",
        vec![TableFilter { column: "name".into(), op: "starts".into(), value: Some("PERSON 1".into()) }],
        Some(SortSpec { column: "age".into(), desc: true }),
        20,
        0,
    );
    let set = d.query(&dialect.select_page(&req).unwrap(), 20).await.unwrap().pop().unwrap();
    assert_eq!(set.rows.len(), 20);
    let id_col = set.columns.iter().position(|c| c.name == "id").unwrap();
    assert_eq!(set.columns[id_col].kind, ColumnKind::Number);
    assert!(set.rows[0][id_col].is_number());
    assert_eq!(set.columns.iter().find(|c| c.name == "active").unwrap().kind, ColumnKind::Bool);
    assert_eq!(set.columns.iter().find(|c| c.name == "tags").unwrap().kind, ColumnKind::Json);
    assert_eq!(cell(&set, 0, "tags"), &json!("[\"a\",\"b\"]"));
    let n = d.query(&dialect.select_count(&req).unwrap(), 1).await.unwrap().pop().unwrap().rows[0][0].clone();
    assert!(n.as_i64().unwrap() > 20, "{n}");

    // edits: update + delete + insert through the generated statements
    let mut key = serde_json::Map::new();
    key.insert("id".into(), json!(5));
    let mut set_ = serde_json::Map::new();
    set_.insert("name".into(), json!("renamed"));
    let mut key2 = serde_json::Map::new();
    key2.insert("id".into(), json!(6));
    let mut vals = serde_json::Map::new();
    vals.insert("id".into(), json!(100000));
    vals.insert("name".into(), json!("new one"));
    let changes = ApplyChangesRequest {
        schema: "demo".into(),
        table: "people".into(),
        changes: vec![RowChange::Update { key, set: set_ }, RowChange::Delete { key: key2 }, RowChange::Insert { values: vals }],
        preview: false,
    };
    d.execute_transaction(&dialect.changes(&changes).unwrap()).await.unwrap();
    let check = d.query("SELECT name FROM demo.people WHERE id IN (5, 6, 100000) ORDER BY id", 10).await.unwrap().pop().unwrap();
    assert_eq!(check.rows.len(), 2);
    assert_eq!(check.rows[0][0], json!("renamed"));
    assert_eq!(check.rows[1][0], json!("new one"));

    // multi-statement, truncation, streaming
    let sets = d.query("SELECT 1 AS a; SELECT number FROM numbers(3000)", 1000).await.unwrap();
    assert_eq!(sets.len(), 2);
    assert!(sets[1].truncated && sets[1].rows.len() == 1000);
    let (sink, got) = collecting_sink();
    let sets = d.query_with("SELECT number FROM numbers(10)", 100, Some(sink)).await.unwrap();
    assert!(sets[0].streamed && got.lock().unwrap()[0].rows.len() == 10);

    // errors
    let err = d.query("SELECT * FROM demo.nope", 10).await.unwrap_err();
    assert!(matches!(err, osprey_lib::error::AppError::Query(_)), "{err:?}");

    // DDL through the dialect
    d.execute_transaction(&dialect.ddl(&DdlOp::AddColumn { schema: "demo".into(), table: "people".into(), column: DdlColumn { name: "note".into(), data_type: "String".into(), nullable: true, primary_key: false, auto_increment: false, default: None } }).unwrap()).await.unwrap();
    assert!(d.columns("demo", "people").await.unwrap().iter().any(|c| c.name == "note" && c.data_type == "Nullable(String)"));
    d.execute_transaction(&dialect.ddl(&DdlOp::DropTable { schema: "demo".into(), table: "people".into() }).unwrap()).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn mssql_end_to_end() {
    drivers::init_crypto();
    let Some(d) = sql_session("OSPREY_TEST_MSSQL", DriverKind::Mssql).await else {
        eprintln!("OSPREY_TEST_MSSQL not set; skipping");
        return;
    };
    let dialect = Dialect::Mssql;
    let info = d.server_info().await.unwrap();
    println!("mssql {} db={:?} user={:?}", info.version, info.database, info.user);

    d.query("IF OBJECT_ID('osprey_t.orders') IS NOT NULL DROP TABLE osprey_t.orders; IF OBJECT_ID('osprey_t.people') IS NOT NULL DROP TABLE osprey_t.people; IF SCHEMA_ID('osprey_t') IS NULL EXEC('CREATE SCHEMA osprey_t')", 10).await.unwrap();
    d.execute_transaction(&[
        "CREATE TABLE osprey_t.people (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL, age INT NULL, score DECIMAL(8,2), active BIT DEFAULT 1, born DATE, seen DATETIME2(3), uid UNIQUEIDENTIFIER DEFAULT NEWID(), blob VARBINARY(MAX), note NVARCHAR(MAX))".into(),
        "CREATE TABLE osprey_t.orders (id BIGINT IDENTITY(1,1) PRIMARY KEY, person_id INT NOT NULL, total DECIMAL(10,2), CONSTRAINT fk_person FOREIGN KEY (person_id) REFERENCES osprey_t.people(id) ON DELETE CASCADE)".into(),
        "CREATE INDEX orders_person_idx ON osprey_t.orders (person_id)".into(),
        "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'test people', @level0type = N'SCHEMA', @level0name = N'osprey_t', @level1type = N'TABLE', @level1name = N'people'".into(),
    ])
    .await
    .unwrap();
    d.query(";WITH n AS (SELECT 1 AS x UNION ALL SELECT x + 1 FROM n WHERE x < 900) INSERT INTO osprey_t.people (name, age, score, active, born, seen, blob) SELECT CONCAT('person ', x), IIF(x % 7 = 0, NULL, 20 + x % 50), x / 3.0, x % 2, DATEADD(day, x % 28, '2024-01-01'), DATEADD(second, x, '2024-01-01T10:00:00'), 0x0102 FROM n OPTION (MAXRECURSION 1000)", 10).await.unwrap();

    let dbs = d.list_databases(false).await.unwrap();
    assert!(!dbs.contains(&"tempdb".to_string()));
    assert!(d.list_databases(true).await.unwrap().contains(&"master".to_string()));
    let schemas = d.list_schemas(false).await.unwrap();
    assert_eq!(schemas[0], "dbo");
    assert!(schemas.contains(&"osprey_t".to_string()) && !schemas.contains(&"sys".to_string()));
    let tables = d.list_tables("osprey_t").await.unwrap();
    let t = tables.iter().find(|t| t.name == "people").expect("people listed");
    assert_eq!(t.row_estimate, Some(900));
    assert_eq!(t.comment.as_deref(), Some("test people"));
    let cols = d.columns("osprey_t", "people").await.unwrap();
    assert_eq!(cols.len(), 10);
    assert!(cols[0].primary_key && cols[0].auto_increment && !cols[0].nullable);
    assert_eq!(cols[1].data_type, "nvarchar(100)");
    assert_eq!(cols[3].data_type, "decimal(8,2)");
    assert_eq!(cols[4].default.as_deref(), Some("1"));
    let st = d.structure("osprey_t", "orders").await.unwrap();
    assert!(st.indexes.iter().any(|i| i.primary));
    assert!(st.indexes.iter().any(|i| i.name == "orders_person_idx" && i.columns == vec!["person_id".to_string()]));
    let fk = &st.foreign_keys[0];
    assert!(fk.name == "fk_person" && fk.ref_table == "people" && fk.ref_schema == "osprey_t" && fk.on_delete.as_deref() == Some("CASCADE"), "{fk:?}");
    let all = d.schema_columns("osprey_t").await.unwrap();
    assert_eq!(all.len(), 2);

    let req = page(
        "osprey_t",
        "people",
        vec![TableFilter { column: "name".into(), op: "starts".into(), value: Some("person 1".into()) }],
        Some(SortSpec { column: "age".into(), desc: true }),
        20,
        0,
    );
    let set = d.query(&dialect.select_page(&req).unwrap(), 20).await.unwrap().pop().unwrap();
    assert_eq!(set.rows.len(), 20);
    assert_eq!(set.columns.iter().find(|c| c.name == "id").unwrap().kind, ColumnKind::Number);
    assert!(cell(&set, 0, "id").is_number());
    assert_eq!(set.columns.iter().find(|c| c.name == "active").unwrap().kind, ColumnKind::Bool);
    assert!(cell(&set, 0, "active").is_boolean());
    assert!(cell(&set, 0, "born").as_str().unwrap().len() == 10, "date only: {:?}", cell(&set, 0, "born"));
    assert!(cell(&set, 0, "seen").as_str().unwrap().starts_with("2024-01-01 10:"), "{:?}", cell(&set, 0, "seen"));
    assert_eq!(set.columns.iter().find(|c| c.name == "blob").unwrap().kind, ColumnKind::Bytes);
    assert_eq!(cell(&set, 0, "blob"), &json!("0x0102"));
    assert!(cell(&set, 0, "score").is_number(), "{:?}", cell(&set, 0, "score"));
    assert_eq!(cell(&set, 0, "uid").as_str().unwrap().len(), 36);
    let n = d.query(&dialect.select_count(&req).unwrap(), 1).await.unwrap().pop().unwrap().rows[0][0].clone();
    assert!(n.as_i64().unwrap() > 20, "{n}");

    // edits in one transaction; a failing statement rolls everything back
    let mut key = serde_json::Map::new();
    key.insert("id".into(), json!(5));
    let mut set_ = serde_json::Map::new();
    set_.insert("name".into(), json!("it's renamed"));
    let mut key2 = serde_json::Map::new();
    key2.insert("id".into(), json!(6));
    let mut vals = serde_json::Map::new();
    vals.insert("name".into(), json!("new one"));
    vals.insert("active".into(), json!(false));
    let changes = ApplyChangesRequest {
        schema: "osprey_t".into(),
        table: "people".into(),
        changes: vec![RowChange::Update { key: key.clone(), set: set_ }, RowChange::Delete { key: key2 }, RowChange::Insert { values: vals }],
        preview: false,
    };
    let affected = d.execute_transaction(&dialect.changes(&changes).unwrap()).await.unwrap();
    assert_eq!(affected, 3);
    let check = d.query("SELECT name, active FROM osprey_t.people WHERE id IN (5, 6) OR name = 'new one' ORDER BY id", 10).await.unwrap().pop().unwrap();
    assert_eq!(check.rows.len(), 2);
    assert_eq!(check.rows[0][0], json!("it's renamed"));
    assert_eq!(check.rows[1][1], json!(false));
    let err = d.execute_transaction(&["UPDATE osprey_t.people SET age = 1 WHERE id = 7".into(), "UPDATE osprey_t.nope SET x = 1".into()]).await.unwrap_err();
    assert!(matches!(err, osprey_lib::error::AppError::Query(_)), "{err:?}");
    let age = d.query("SELECT age FROM osprey_t.people WHERE id = 7", 1).await.unwrap().pop().unwrap().rows[0][0].clone();
    assert_ne!(age, json!(1), "rolled back");

    // multi-statement with GO, affected counts, truncation, streaming
    let sets = d.query("SELECT 1 AS a\nGO\nUPDATE osprey_t.people SET age = age WHERE id < 3; SELECT id FROM osprey_t.people", 100).await.unwrap();
    assert_eq!(sets.len(), 3);
    assert_eq!(sets[1].affected, Some(2));
    assert!(sets[2].truncated && sets[2].rows.len() == 100);
    let (sink, got) = collecting_sink();
    let sets = d.query_with("SELECT id FROM osprey_t.people", 5000, Some(sink)).await.unwrap();
    assert!(sets[0].streamed && sets[0].row_count == 900);
    assert_eq!(got.lock().unwrap().iter().map(|b| b.rows.len()).sum::<usize>(), 900);

    // cancel a long statement from a second connection
    let d2 = d.clone();
    let waiter = tokio::spawn(async move { d2.query("WAITFOR DELAY '00:00:20'", 1).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let t0 = std::time::Instant::now();
    d.cancel().await.unwrap();
    let res = waiter.await.unwrap();
    assert!(res.is_err(), "cancelled statement must fail");
    assert!(t0.elapsed() < Duration::from_secs(5));

    // DDL
    d.execute_transaction(&dialect.ddl(&DdlOp::AddColumn { schema: "osprey_t".into(), table: "people".into(), column: DdlColumn { name: "note2".into(), data_type: "nvarchar(20)".into(), nullable: true, primary_key: false, auto_increment: false, default: None } }).unwrap()).await.unwrap();
    d.execute_transaction(&dialect.ddl(&DdlOp::AlterColumn { schema: "osprey_t".into(), table: "people".into(), name: "note2".into(), new_name: Some("note3".into()), data_type: None, nullable: None, set_default: false, default: None }).unwrap()).await.unwrap();
    assert!(d.columns("osprey_t", "people").await.unwrap().iter().any(|c| c.name == "note3"));
    d.execute_transaction(&["DROP TABLE osprey_t.orders".into(), "DROP TABLE osprey_t.people".into()]).await.unwrap();
}

