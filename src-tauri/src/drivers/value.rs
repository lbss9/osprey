//! Column kind detection. Both engines hand us text (PostgreSQL simple
//! protocol, MySQL text protocol); the kind only drives how the grid renders
//! and edits a cell.

use crate::models::ColumnKind;

/// PostgreSQL type name (as `format_type` / `Type::name` spell it) → kind.
pub fn pg_kind(type_name: &str) -> ColumnKind {
    let t = type_name.trim().to_ascii_lowercase();
    let base = t.trim_end_matches("[]");
    if t.ends_with("[]") || base.starts_with('_') {
        return ColumnKind::Other;
    }
    match base {
        "int2" | "int4" | "int8" | "smallint" | "integer" | "bigint" | "float4" | "float8"
        | "real" | "double precision" | "numeric" | "decimal" | "money" | "oid" | "serial"
        | "bigserial" | "smallserial" => ColumnKind::Number,
        "bool" | "boolean" => ColumnKind::Bool,
        "json" | "jsonb" => ColumnKind::Json,
        "bytea" => ColumnKind::Bytes,
        "date" | "time" | "timetz" | "timestamp" | "timestamptz" | "interval"
        | "time without time zone" | "time with time zone" | "timestamp without time zone"
        | "timestamp with time zone" => ColumnKind::Date,
        "text" | "varchar" | "char" | "bpchar" | "name" | "character varying" | "character"
        | "uuid" | "citext" | "inet" | "cidr" | "macaddr" | "xml" | "unknown" => ColumnKind::String,
        _ => {
            if base.starts_with("numeric(") || base.starts_with("decimal(") {
                ColumnKind::Number
            } else if base.starts_with("character") || base.starts_with("varchar(") {
                ColumnKind::String
            } else if base.starts_with("timestamp") || base.starts_with("time") {
                ColumnKind::Date
            } else {
                ColumnKind::Other
            }
        }
    }
}

/// MySQL `COLUMN_TYPE` (e.g. `int(11) unsigned`, `varchar(255)`) → kind.
pub fn mysql_kind_from_name(column_type: &str) -> ColumnKind {
    let t = column_type.trim().to_ascii_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("");
    match base {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "float"
        | "double" | "decimal" | "numeric" | "real" | "year" | "bit" => {
            if t.starts_with("tinyint(1)") {
                ColumnKind::Bool
            } else {
                ColumnKind::Number
            }
        }
        "json" => ColumnKind::Json,
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" | "geometry" => {
            ColumnKind::Bytes
        }
        "date" | "datetime" | "timestamp" | "time" => ColumnKind::Date,
        "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "enum" | "set" => {
            ColumnKind::String
        }
        _ => ColumnKind::Other,
    }
}

/// MySQL wire column type → kind (used for query results, where we only have
/// the protocol type and flags).
pub fn mysql_kind(ct: mysql_async::consts::ColumnType, binary: bool, len: u32) -> ColumnKind {
    use mysql_async::consts::ColumnType as C;
    match ct {
        C::MYSQL_TYPE_TINY => {
            if len == 1 {
                ColumnKind::Bool
            } else {
                ColumnKind::Number
            }
        }
        C::MYSQL_TYPE_DECIMAL
        | C::MYSQL_TYPE_NEWDECIMAL
        | C::MYSQL_TYPE_SHORT
        | C::MYSQL_TYPE_LONG
        | C::MYSQL_TYPE_FLOAT
        | C::MYSQL_TYPE_DOUBLE
        | C::MYSQL_TYPE_LONGLONG
        | C::MYSQL_TYPE_INT24
        | C::MYSQL_TYPE_YEAR
        | C::MYSQL_TYPE_BIT => ColumnKind::Number,
        C::MYSQL_TYPE_TIMESTAMP
        | C::MYSQL_TYPE_DATE
        | C::MYSQL_TYPE_TIME
        | C::MYSQL_TYPE_DATETIME
        | C::MYSQL_TYPE_NEWDATE
        | C::MYSQL_TYPE_TIMESTAMP2
        | C::MYSQL_TYPE_DATETIME2
        | C::MYSQL_TYPE_TIME2 => ColumnKind::Date,
        C::MYSQL_TYPE_JSON => ColumnKind::Json,
        C::MYSQL_TYPE_TINY_BLOB
        | C::MYSQL_TYPE_MEDIUM_BLOB
        | C::MYSQL_TYPE_LONG_BLOB
        | C::MYSQL_TYPE_BLOB
        | C::MYSQL_TYPE_VAR_STRING
        | C::MYSQL_TYPE_STRING
        | C::MYSQL_TYPE_VARCHAR => {
            if binary {
                ColumnKind::Bytes
            } else {
                ColumnKind::String
            }
        }
        C::MYSQL_TYPE_GEOMETRY => ColumnKind::Bytes,
        C::MYSQL_TYPE_ENUM | C::MYSQL_TYPE_SET => ColumnKind::String,
        _ => ColumnKind::Other,
    }
}

/// Human name for a MySQL wire type (query results have no `COLUMN_TYPE`).
pub fn mysql_type_name(ct: mysql_async::consts::ColumnType, binary: bool) -> &'static str {
    use mysql_async::consts::ColumnType as C;
    match ct {
        C::MYSQL_TYPE_DECIMAL | C::MYSQL_TYPE_NEWDECIMAL => "decimal",
        C::MYSQL_TYPE_TINY => "tinyint",
        C::MYSQL_TYPE_SHORT => "smallint",
        C::MYSQL_TYPE_LONG => "int",
        C::MYSQL_TYPE_FLOAT => "float",
        C::MYSQL_TYPE_DOUBLE => "double",
        C::MYSQL_TYPE_NULL => "null",
        C::MYSQL_TYPE_TIMESTAMP | C::MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        C::MYSQL_TYPE_LONGLONG => "bigint",
        C::MYSQL_TYPE_INT24 => "mediumint",
        C::MYSQL_TYPE_DATE | C::MYSQL_TYPE_NEWDATE => "date",
        C::MYSQL_TYPE_TIME | C::MYSQL_TYPE_TIME2 => "time",
        C::MYSQL_TYPE_DATETIME | C::MYSQL_TYPE_DATETIME2 => "datetime",
        C::MYSQL_TYPE_YEAR => "year",
        C::MYSQL_TYPE_VARCHAR | C::MYSQL_TYPE_VAR_STRING => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        C::MYSQL_TYPE_BIT => "bit",
        C::MYSQL_TYPE_JSON => "json",
        C::MYSQL_TYPE_ENUM => "enum",
        C::MYSQL_TYPE_SET => "set",
        C::MYSQL_TYPE_TINY_BLOB => "tinyblob",
        C::MYSQL_TYPE_MEDIUM_BLOB => "mediumblob",
        C::MYSQL_TYPE_LONG_BLOB => "longblob",
        C::MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        C::MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        C::MYSQL_TYPE_GEOMETRY => "geometry",
        _ => "unknown",
    }
}

/// Convert a MySQL text-protocol value into the JSON cell the grid expects.
pub fn mysql_value_to_json(v: mysql_async::Value, kind: ColumnKind, is_date_only: bool) -> serde_json::Value {
    use mysql_async::Value as V;
    use serde_json::Value as J;
    match v {
        V::NULL => J::Null,
        V::Bytes(b) => match String::from_utf8(b) {
            Ok(s) => {
                if kind == ColumnKind::Number {
                    // keep big/decimal numbers exact: only turn into a JSON number
                    // when it round-trips; otherwise leave the text as is
                    if let Ok(i) = s.parse::<i64>() {
                        return J::from(i);
                    }
                    if let Ok(u) = s.parse::<u64>() {
                        return J::from(u);
                    }
                }
                J::String(s)
            }
            Err(e) => J::String(format!("0x{}", hex::encode(e.into_bytes()))),
        },
        V::Int(i) => J::from(i),
        V::UInt(u) => J::from(u),
        V::Float(f) => serde_json::Number::from_f64(f as f64)
            .map(J::Number)
            .unwrap_or_else(|| J::String(f.to_string())),
        V::Double(f) => serde_json::Number::from_f64(f)
            .map(J::Number)
            .unwrap_or_else(|| J::String(f.to_string())),
        V::Date(y, mo, d, h, mi, s, us) => {
            if is_date_only || (h == 0 && mi == 0 && s == 0 && us == 0 && kind == ColumnKind::Date && false) {
                J::String(format!("{y:04}-{mo:02}-{d:02}"))
            } else if us > 0 {
                J::String(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"))
            } else {
                J::String(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            }
        }
        V::Time(neg, days, h, mi, s, us) => {
            let hours = days * 24 + h as u32;
            let sign = if neg { "-" } else { "" };
            if us > 0 {
                J::String(format!("{sign}{hours:02}:{mi:02}:{s:02}.{us:06}"))
            } else {
                J::String(format!("{sign}{hours:02}:{mi:02}:{s:02}"))
            }
        }
    }
}

/// PostgreSQL text value → JSON cell. Numbers and bools become JSON scalars
/// when they round-trip exactly; everything else stays a string.
pub fn pg_text_to_json(text: Option<&str>, kind: ColumnKind) -> serde_json::Value {
    use serde_json::Value as J;
    let Some(s) = text else { return J::Null };
    match kind {
        ColumnKind::Number => {
            if let Ok(i) = s.parse::<i64>() {
                J::from(i)
            } else if let Ok(f) = s.parse::<f64>() {
                if f.is_finite() && s.len() <= 17 {
                    serde_json::Number::from_f64(f)
                        .map(J::Number)
                        .unwrap_or_else(|| J::String(s.to_string()))
                } else {
                    J::String(s.to_string())
                }
            } else {
                J::String(s.to_string())
            }
        }
        ColumnKind::Bool => match s {
            "t" | "true" => J::Bool(true),
            "f" | "false" => J::Bool(false),
            _ => J::String(s.to_string()),
        },
        _ => J::String(s.to_string()),
    }
}
