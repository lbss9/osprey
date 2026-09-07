//! SQL generation for the table view: quoting, filters, pagination and the
//! statements produced from pending grid edits. Values are embedded as
//! literals on purpose — the user can read (and copy) exactly what will run.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::{ApplyChangesRequest, RowChange, TableFilter, TablePageRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
}

impl Dialect {
    pub fn quote_ident(&self, name: &str) -> String {
        match self {
            Dialect::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        }
    }

    pub fn quote_literal(&self, s: &str) -> String {
        match self {
            Dialect::Postgres => {
                if s.contains('\\') {
                    // E'' strings interpret backslashes; escape them so the value is exact
                    format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
                } else {
                    format!("'{}'", s.replace('\'', "''"))
                }
            }
            Dialect::Mysql => {
                let mut out = String::with_capacity(s.len() + 2);
                out.push('\'');
                for ch in s.chars() {
                    match ch {
                        '\'' => out.push_str("''"),
                        '\\' => out.push_str("\\\\"),
                        '\0' => out.push_str("\\0"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\u{1a}' => out.push_str("\\Z"),
                        c => out.push(c),
                    }
                }
                out.push('\'');
                out
            }
        }
    }

    pub fn qualified(&self, schema: &str, table: &str) -> String {
        if schema.is_empty() {
            self.quote_ident(table)
        } else {
            format!("{}.{}", self.quote_ident(schema), self.quote_ident(table))
        }
    }

    /// JSON cell → SQL literal. `null` → NULL, `{"$default":true}` → DEFAULT.
    pub fn literal(&self, v: &Value) -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
            Value::Number(n) => n.to_string(),
            Value::String(s) => self.quote_literal(s),
            Value::Object(o) if o.get("$default").and_then(|d| d.as_bool()) == Some(true) => {
                "DEFAULT".into()
            }
            other => self.quote_literal(&other.to_string()),
        }
    }

    fn text_expr(&self, col: &str) -> String {
        match self {
            Dialect::Postgres => format!("{}::text", self.quote_ident(col)),
            Dialect::Mysql => self.quote_ident(col),
        }
    }

    fn like_op(&self) -> &'static str {
        match self {
            Dialect::Postgres => "ILIKE",
            Dialect::Mysql => "LIKE",
        }
    }

    fn escape_like(&self, s: &str) -> String {
        s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    }

    pub fn filter_clause(&self, f: &TableFilter) -> AppResult<String> {
        let col = self.quote_ident(&f.column);
        let val = f.value.clone().unwrap_or_default();
        let lit = self.quote_literal(&val);
        Ok(match f.op.as_str() {
            "eq" => format!("{col} = {lit}"),
            "neq" => format!("{col} <> {lit}"),
            "gt" => format!("{col} > {lit}"),
            "gte" => format!("{col} >= {lit}"),
            "lt" => format!("{col} < {lit}"),
            "lte" => format!("{col} <= {lit}"),
            "contains" => format!(
                "{} {} {}",
                self.text_expr(&f.column),
                self.like_op(),
                self.quote_literal(&format!("%{}%", self.escape_like(&val)))
            ),
            "starts" => format!(
                "{} {} {}",
                self.text_expr(&f.column),
                self.like_op(),
                self.quote_literal(&format!("{}%", self.escape_like(&val)))
            ),
            "ends" => format!(
                "{} {} {}",
                self.text_expr(&f.column),
                self.like_op(),
                self.quote_literal(&format!("%{}", self.escape_like(&val)))
            ),
            "isnull" => format!("{col} IS NULL"),
            "notnull" => format!("{col} IS NOT NULL"),
            "in" => {
                let items: Vec<String> = val
                    .split(',')
                    .map(|s| self.quote_literal(s.trim()))
                    .filter(|s| s != "''")
                    .collect();
                if items.is_empty() {
                    "1=0".into()
                } else {
                    format!("{col} IN ({})", items.join(", "))
                }
            }
            other => return Err(AppError::Unsupported(format!("filter op {other}"))),
        })
    }

    fn where_clause(&self, req: &TablePageRequest) -> AppResult<String> {
        let mut parts: Vec<String> = Vec::new();
        for f in &req.filters {
            parts.push(self.filter_clause(f)?);
        }
        if let Some(raw) = req.raw_where.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            parts.push(format!("({raw})"));
        }
        Ok(if parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", parts.join(" AND "))
        })
    }

    pub fn select_page(&self, req: &TablePageRequest) -> AppResult<String> {
        let mut sql = format!("SELECT * FROM {}", self.qualified(&req.schema, &req.table));
        sql.push_str(&self.where_clause(req)?);
        if let Some(s) = &req.sort {
            sql.push_str(&format!(
                " ORDER BY {} {}",
                self.quote_ident(&s.column),
                if s.desc { "DESC" } else { "ASC" }
            ));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));
        Ok(sql)
    }

    pub fn select_count(&self, req: &TablePageRequest) -> AppResult<String> {
        let mut sql = format!(
            "SELECT COUNT(*) FROM {}",
            self.qualified(&req.schema, &req.table)
        );
        sql.push_str(&self.where_clause(req)?);
        Ok(sql)
    }

    fn key_condition(&self, key: &serde_json::Map<String, Value>) -> String {
        key.iter()
            .map(|(k, v)| {
                if v.is_null() {
                    format!("{} IS NULL", self.quote_ident(k))
                } else {
                    format!("{} = {}", self.quote_ident(k), self.literal(v))
                }
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }

    /// Statements for the grid's pending changes. Every UPDATE/DELETE must
    /// carry a non-empty key so a bug can never touch the whole table.
    pub fn changes(&self, req: &ApplyChangesRequest) -> AppResult<Vec<String>> {
        let target = self.qualified(&req.schema, &req.table);
        let mut out = Vec::with_capacity(req.changes.len());
        for ch in &req.changes {
            match ch {
                RowChange::Update { key, set } => {
                    if key.is_empty() {
                        return Err(AppError::NoPrimaryKey);
                    }
                    if set.is_empty() {
                        continue;
                    }
                    let assigns = set
                        .iter()
                        .map(|(k, v)| format!("{} = {}", self.quote_ident(k), self.literal(v)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push(format!(
                        "UPDATE {target} SET {assigns} WHERE {}",
                        self.key_condition(key)
                    ));
                }
                RowChange::Insert { values } => {
                    let cols: Vec<String> = values.keys().map(|k| self.quote_ident(k)).collect();
                    let vals: Vec<String> = values.values().map(|v| self.literal(v)).collect();
                    if cols.is_empty() {
                        out.push(match self {
                            Dialect::Postgres => format!("INSERT INTO {target} DEFAULT VALUES"),
                            Dialect::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                        });
                    } else {
                        out.push(format!(
                            "INSERT INTO {target} ({}) VALUES ({})",
                            cols.join(", "),
                            vals.join(", ")
                        ));
                    }
                }
                RowChange::Delete { key } => {
                    if key.is_empty() {
                        return Err(AppError::NoPrimaryKey);
                    }
                    out.push(format!(
                        "DELETE FROM {target} WHERE {}",
                        self.key_condition(key)
                    ));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page(filters: Vec<TableFilter>, sort: Option<crate::models::SortSpec>) -> TablePageRequest {
        TablePageRequest {
            schema: "public".into(),
            table: "users".into(),
            filters,
            raw_where: None,
            sort,
            limit: 100,
            offset: 200,
        }
    }

    #[test]
    fn pg_select_with_filters_and_sort() {
        let d = Dialect::Postgres;
        let sql = d
            .select_page(&page(
                vec![
                    TableFilter { column: "name".into(), op: "contains".into(), value: Some("o'b%".into()) },
                    TableFilter { column: "age".into(), op: "gte".into(), value: Some("18".into()) },
                    TableFilter { column: "deleted_at".into(), op: "isnull".into(), value: None },
                ],
                Some(crate::models::SortSpec { column: "id".into(), desc: true }),
            ))
            .unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM \"public\".\"users\" WHERE \"name\"::text ILIKE E'%o''b\\\\%%' AND \"age\" >= '18' AND \"deleted_at\" IS NULL ORDER BY \"id\" DESC LIMIT 100 OFFSET 200"
        );
    }

    #[test]
    fn mysql_quotes_and_escapes() {
        let d = Dialect::Mysql;
        assert_eq!(d.quote_ident("we`ird"), "`we``ird`");
        assert_eq!(d.quote_literal("a'b\\c\n"), "'a''b\\\\c\\n'");
        let sql = d.select_page(&page(vec![], None)).unwrap();
        assert_eq!(sql, "SELECT * FROM `public`.`users` LIMIT 100 OFFSET 200");
    }

    #[test]
    fn changes_generate_update_insert_delete() {
        let d = Dialect::Postgres;
        let req = ApplyChangesRequest {
            schema: "public".into(),
            table: "users".into(),
            preview: true,
            changes: vec![
                RowChange::Update {
                    key: json!({"id": 7}).as_object().unwrap().clone(),
                    set: json!({"name": "Ana", "age": null, "score": 1.5, "active": true}).as_object().unwrap().clone(),
                },
                RowChange::Insert {
                    values: json!({"name": "Bob", "id": {"$default": true}}).as_object().unwrap().clone(),
                },
                RowChange::Delete { key: json!({"id": 9, "tenant": null}).as_object().unwrap().clone() },
            ],
        };
        let stmts = d.changes(&req).unwrap();
        assert_eq!(stmts[0], "UPDATE \"public\".\"users\" SET \"name\" = 'Ana', \"age\" = NULL, \"score\" = 1.5, \"active\" = TRUE WHERE \"id\" = 7");
        assert_eq!(stmts[1], "INSERT INTO \"public\".\"users\" (\"name\", \"id\") VALUES ('Bob', DEFAULT)");
        assert_eq!(stmts[2], "DELETE FROM \"public\".\"users\" WHERE \"id\" = 9 AND \"tenant\" IS NULL");
    }

    #[test]
    fn update_without_key_is_refused() {
        let d = Dialect::Mysql;
        let req = ApplyChangesRequest {
            schema: "db".into(),
            table: "t".into(),
            preview: true,
            changes: vec![RowChange::Delete { key: serde_json::Map::new() }],
        };
        assert!(matches!(d.changes(&req), Err(AppError::NoPrimaryKey)));
    }
}
