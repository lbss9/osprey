//! SQL generation for the table view: quoting, filters, pagination and the
//! statements produced from pending grid edits. Values are embedded as
//! literals on purpose — the user can read (and copy) exactly what will run.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::{ApplyChangesRequest, DdlColumn, DdlOp, RowChange, TableFilter, TablePageRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    pub fn quote_ident(&self, name: &str) -> String {
        match self {
            Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        }
    }

    pub fn quote_literal(&self, s: &str) -> String {
        match self {
            Dialect::Sqlite => format!("'{}'", s.replace('\'', "''")),
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
            Dialect::Sqlite => format!("CAST({} AS TEXT)", self.quote_ident(col)),
        }
    }

    fn like_op(&self) -> &'static str {
        match self {
            Dialect::Postgres => "ILIKE",
            // MySQL collations and SQLite's LIKE are case-insensitive for ASCII already
            Dialect::Mysql | Dialect::Sqlite => "LIKE",
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
                            Dialect::Postgres | Dialect::Sqlite => format!("INSERT INTO {target} DEFAULT VALUES"),
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

impl Dialect {
    fn column_def(&self, c: &DdlColumn, inline_pk: bool) -> String {
        let mut parts = vec![self.quote_ident(&c.name)];
        let ty = c.data_type.trim();
        match self {
            Dialect::Postgres => {
                parts.push(ty.to_string());
                if c.auto_increment && !ty.to_ascii_lowercase().contains("serial") {
                    parts.push("GENERATED BY DEFAULT AS IDENTITY".into());
                }
            }
            Dialect::Mysql => {
                parts.push(ty.to_string());
            }
            Dialect::Sqlite => {
                parts.push(if c.auto_increment { "INTEGER".into() } else { ty.to_string() });
            }
        }
        if inline_pk && c.primary_key {
            parts.push("PRIMARY KEY".into());
            if *self == Dialect::Sqlite && c.auto_increment {
                parts.push("AUTOINCREMENT".into());
            }
        }
        if !c.nullable && !c.primary_key {
            parts.push("NOT NULL".into());
        }
        if let Some(d) = c.default.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            parts.push(format!("DEFAULT {d}"));
        }
        if *self == Dialect::Mysql && c.auto_increment {
            parts.push("AUTO_INCREMENT".into());
        }
        parts.join(" ")
    }

    /// Statements for a structure edit. Errors when the engine cannot do it
    /// in place (SQLite column type changes).
    pub fn ddl(&self, op: &DdlOp) -> AppResult<Vec<String>> {
        Ok(match op {
            DdlOp::CreateTable { schema, table, columns } => {
                if columns.is_empty() {
                    return Err(AppError::Unsupported("a table needs at least one column".into()));
                }
                let pks: Vec<&DdlColumn> = columns.iter().filter(|c| c.primary_key).collect();
                let inline_pk = pks.len() == 1;
                let mut defs: Vec<String> = columns.iter().map(|c| self.column_def(c, inline_pk)).collect();
                if pks.len() > 1 {
                    defs.push(format!("PRIMARY KEY ({})", pks.iter().map(|c| self.quote_ident(&c.name)).collect::<Vec<_>>().join(", ")));
                }
                vec![format!("CREATE TABLE {} (\n  {}\n)", self.qualified(schema, table), defs.join(",\n  "))]
            }
            DdlOp::AddColumn { schema, table, column } => {
                vec![format!("ALTER TABLE {} ADD COLUMN {}", self.qualified(schema, table), self.column_def(column, true))]
            }
            DdlOp::AlterColumn { schema, table, name, new_name, data_type, nullable, set_default, default } => {
                let target = self.qualified(schema, table);
                let col = self.quote_ident(name);
                let mut out = Vec::new();
                match self {
                    Dialect::Postgres => {
                        if let Some(t) = data_type.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                            out.push(format!("ALTER TABLE {target} ALTER COLUMN {col} TYPE {t}"));
                        }
                        if let Some(n) = nullable {
                            out.push(format!("ALTER TABLE {target} ALTER COLUMN {col} {} NOT NULL", if *n { "DROP" } else { "SET" }));
                        }
                        if *set_default {
                            match default.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                                Some(d) => out.push(format!("ALTER TABLE {target} ALTER COLUMN {col} SET DEFAULT {d}")),
                                None => out.push(format!("ALTER TABLE {target} ALTER COLUMN {col} DROP DEFAULT")),
                            }
                        }
                    }
                    Dialect::Mysql => {
                        // MODIFY needs the full definition, so type/null/default travel together
                        if data_type.is_some() || nullable.is_some() || *set_default {
                            let t = data_type.as_deref().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| AppError::Unsupported("MySQL needs the column type to change nullability or default".into()))?;
                            let mut def = format!("ALTER TABLE {target} MODIFY COLUMN {col} {t}");
                            if nullable == &Some(false) {
                                def.push_str(" NOT NULL");
                            }
                            if *set_default {
                                if let Some(d) = default.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                                    def.push_str(&format!(" DEFAULT {d}"));
                                }
                            }
                            out.push(def);
                        }
                    }
                    Dialect::Sqlite => {
                        if data_type.is_some() || nullable.is_some() || *set_default {
                            return Err(AppError::Unsupported("SQLite cannot change a column's type, nullability or default in place; create a new table and copy the data".into()));
                        }
                    }
                }
                if let Some(n) = new_name.as_deref().map(str::trim).filter(|n| !n.is_empty() && *n != name) {
                    out.push(format!("ALTER TABLE {target} RENAME COLUMN {col} TO {}", self.quote_ident(n)));
                }
                out
            }
            DdlOp::DropColumn { schema, table, name } => {
                vec![format!("ALTER TABLE {} DROP COLUMN {}", self.qualified(schema, table), self.quote_ident(name))]
            }
            DdlOp::RenameTable { schema, table, new_name } => {
                vec![format!("ALTER TABLE {} RENAME TO {}", self.qualified(schema, table), self.quote_ident(new_name))]
            }
            DdlOp::CreateIndex { schema, table, name, columns, unique } => {
                if columns.is_empty() {
                    return Err(AppError::Unsupported("an index needs at least one column".into()));
                }
                let cols = columns.iter().map(|c| self.quote_ident(c)).collect::<Vec<_>>().join(", ");
                let uniq = if *unique { "UNIQUE " } else { "" };
                match self {
                    // SQLite attaches the schema to the index, and the table must be bare
                    Dialect::Sqlite => vec![format!("CREATE {uniq}INDEX {} ON {} ({cols})", self.qualified(schema, name), self.quote_ident(table))],
                    _ => vec![format!("CREATE {uniq}INDEX {} ON {} ({cols})", self.quote_ident(name), self.qualified(schema, table))],
                }
            }
            DdlOp::DropIndex { schema, table, name } => match self {
                Dialect::Postgres => vec![format!("DROP INDEX {}", self.qualified(schema, name))],
                Dialect::Mysql => vec![format!("DROP INDEX {} ON {}", self.quote_ident(name), self.qualified(schema, table))],
                Dialect::Sqlite => vec![format!("DROP INDEX {}", self.qualified(schema, name))],
            },
            DdlOp::DropTable { schema, table } => vec![format!("DROP TABLE {}", self.qualified(schema, table))],
            DdlOp::TruncateTable { schema, table } => match self {
                Dialect::Sqlite => vec![format!("DELETE FROM {}", self.qualified(schema, table))],
                _ => vec![format!("TRUNCATE TABLE {}", self.qualified(schema, table))],
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, ty: &str) -> DdlColumn {
        DdlColumn { name: name.into(), data_type: ty.into(), nullable: true, default: None, primary_key: false, auto_increment: false }
    }

    #[test]
    fn ddl_create_table_per_dialect() {
        let op = DdlOp::CreateTable {
            schema: "public".into(),
            table: "t".into(),
            columns: vec![
                DdlColumn { primary_key: true, auto_increment: true, nullable: false, ..col("id", "integer") },
                DdlColumn { nullable: false, default: Some("'x'".into()), ..col("name", "text") },
                col("note", "text"),
            ],
        };
        assert_eq!(
            Dialect::Postgres.ddl(&op).unwrap()[0],
            "CREATE TABLE \"public\".\"t\" (\n  \"id\" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  \"name\" text NOT NULL DEFAULT 'x',\n  \"note\" text\n)"
        );
        assert_eq!(
            Dialect::Mysql.ddl(&op).unwrap()[0],
            "CREATE TABLE `public`.`t` (\n  `id` integer PRIMARY KEY AUTO_INCREMENT,\n  `name` text NOT NULL DEFAULT 'x',\n  `note` text\n)"
        );
        assert_eq!(
            Dialect::Sqlite.ddl(&op).unwrap()[0],
            "CREATE TABLE \"main\".\"t\" (\n  \"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\n  \"name\" text NOT NULL DEFAULT 'x',\n  \"note\" text\n)".replace("\"main\"", "\"public\"")
        );
    }

    #[test]
    fn ddl_alter_column_variants() {
        let op = DdlOp::AlterColumn {
            schema: "s".into(),
            table: "t".into(),
            name: "age".into(),
            new_name: Some("years".into()),
            data_type: Some("bigint".into()),
            nullable: Some(false),
            set_default: true,
            default: Some("0".into()),
        };
        assert_eq!(
            Dialect::Postgres.ddl(&op).unwrap(),
            vec![
                "ALTER TABLE \"s\".\"t\" ALTER COLUMN \"age\" TYPE bigint",
                "ALTER TABLE \"s\".\"t\" ALTER COLUMN \"age\" SET NOT NULL",
                "ALTER TABLE \"s\".\"t\" ALTER COLUMN \"age\" SET DEFAULT 0",
                "ALTER TABLE \"s\".\"t\" RENAME COLUMN \"age\" TO \"years\"",
            ]
        );
        assert_eq!(
            Dialect::Mysql.ddl(&op).unwrap(),
            vec!["ALTER TABLE `s`.`t` MODIFY COLUMN `age` bigint NOT NULL DEFAULT 0", "ALTER TABLE `s`.`t` RENAME COLUMN `age` TO `years`"]
        );
        assert!(Dialect::Sqlite.ddl(&op).is_err());
        let rename_only = DdlOp::AlterColumn { schema: "main".into(), table: "t".into(), name: "a".into(), new_name: Some("b".into()), data_type: None, nullable: None, set_default: false, default: None };
        assert_eq!(Dialect::Sqlite.ddl(&rename_only).unwrap(), vec!["ALTER TABLE \"main\".\"t\" RENAME COLUMN \"a\" TO \"b\""]);
    }

    #[test]
    fn ddl_indexes_and_drops() {
        let ix = DdlOp::CreateIndex { schema: "s".into(), table: "t".into(), name: "t_a_idx".into(), columns: vec!["a".into(), "b".into()], unique: true };
        assert_eq!(Dialect::Postgres.ddl(&ix).unwrap(), vec!["CREATE UNIQUE INDEX \"t_a_idx\" ON \"s\".\"t\" (\"a\", \"b\")"]);
        let drop = DdlOp::DropIndex { schema: "s".into(), table: "t".into(), name: "t_a_idx".into() };
        assert_eq!(Dialect::Mysql.ddl(&drop).unwrap(), vec!["DROP INDEX `t_a_idx` ON `s`.`t`"]);
        assert_eq!(Dialect::Postgres.ddl(&drop).unwrap(), vec!["DROP INDEX \"s\".\"t_a_idx\""]);
        assert_eq!(Dialect::Sqlite.ddl(&DdlOp::TruncateTable { schema: "main".into(), table: "t".into() }).unwrap(), vec!["DELETE FROM \"main\".\"t\""]);
    }

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
