# Osprey — notes for AI assistants and contributors

Desktop database client (PostgreSQL, MySQL/MariaDB, Redis, SQLite, ClickHouse, SQL Server) built with Tauri 2 + Rust + React.
The full knowledge base (decisions, research, release process, pitfalls) lives in the Obsidian
vault at `E:\Documentos\Osprey` — read `07 - Guia para IAs e devs.md` there before larger changes.

## Layout

- `src/` — React 19 + TypeScript. **Atomic design**: `components/atoms → molecules → organisms →
  templates`, `pages/App.tsx`. State in `store/` (zustand), IPC wrappers in `services/tauri.ts`,
  strings in `i18n/{en,pt-BR}.json` (every visible string goes through `t()`).
- `src-tauri/src/` — Rust. `drivers/` (SqlDriver trait: postgres, mysql, sqlite, clickhouse, mssql; RedisSession; `sql.rs`
  builds the SQL the table view runs), `store/` (local SQLite), `secrets.rs` (OS keychain),
  `commands/` (thin `#[tauri::command]` adapters), `models.rs` (DTOs, mirrored in `src/types`).
- Errors cross the bridge as `errors.<key>|detail`; the frontend translates them.

## Commands

```
npm install
npm run build                                   # required before cargo build (dist/ is embedded)
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev                               # opens the app window
npm run release -- <x.y.z|patch|minor|major>    # bump, tag, push → CI publishes
```

## Rules

- Commits in English (`feat:`/`fix:`/`docs:`/`chore:`), no mention of AI tools, no co-author trailers.
- Never commit the author's private hosts/keys. Signing key for updates is outside the repo.
- Prefer verifying with `cargo test`, `tsc` and `vite build`; don't open the app window unless needed.
- Every write to a database goes through preview + one transaction; UPDATE/DELETE require a primary key.
