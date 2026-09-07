<p align="center">
  <img src="docs/assets/banner.svg" alt="Osprey" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/lbss9/osprey/blob/main/LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-37B7E6?style=flat-square" /></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8D8?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Windows · macOS · Linux" src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-37B7E6?style=flat-square" />
  <a href="https://github.com/lbss9/osprey/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/lbss9/osprey?style=flat-square&color=37B7E6&label=release" /></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#databases">Databases</a> ·
  <a href="#keyboard">Keyboard</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#building-from-source">Build</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

Osprey is a desktop database client that gets out of the way. It opens in under a second, keeps
every connection on your disk, and lets someone who has never written SQL browse, filter and edit a
table safely. PostgreSQL, MySQL/MariaDB and Redis today; more engines later. The engine is Rust,
the shell is Tauri 2, and the interface is React with its own identity.

<!-- screenshots go here: docs/assets/screenshot-dark.png / screenshot-light.png -->

## Why another database client

- **Local-first.** Connections, query history and settings live in a SQLite file in your app data
  folder. Passwords go to the OS credential store (Keychain, Credential Manager, Secret Service).
  No account, no sync, no telemetry.
- **Fast by design.** Filters, sorting and paging run on the server; the grid is virtualized in
  both directions; Redis is browsed with `SCAN`, never `KEYS`. A million-row table feels the same
  as a hundred-row one.
- **Safe by default.** Nothing is written until you press *Apply* and read the exact SQL that
  will run, inside one transaction. Rows without a primary key are read-only. A connection can be
  marked read-only for good.
- **Built to be looked at.** Frameless window, dark and light themes, colours per data type,
  monospace data, no borrowed UI patterns.

## Features

**Connections**

- PostgreSQL, MySQL/MariaDB and Redis with one dialog: host, port, user, password, database,
  TLS mode (off / prefer / require / verify), colour, group and read-only flag
- *Test* connects once and shows the server version before you save
- Sidebar tree: connection → database → schema → tables and views with row estimates, plus a
  quick filter. Switch database (PostgreSQL) or DB index (Redis) in place

**Data tab**

- Server-side paging, sorting and no-code filters (`contains`, `is empty`, `is one of`…) with an
  optional free-form `WHERE`
- Inline editing: type into a cell, add rows, delete rows. Changes stay pending (amber, green, red)
  until you *Preview SQL* and *Apply*; everything runs in a single transaction
- Right-click: copy value, copy row as JSON / CSV / `INSERT`, filter by this value, set `NULL` or
  `DEFAULT`
- Export the page as CSV, JSON or SQL inserts; copy a selection as TSV

**Query tab**

- CodeMirror 6 editor with the PostgreSQL or MySQL dialect and autocompletion for schemas and tables
- `Ctrl+Enter` runs the selection or everything; several statements per run, one result set per
  statement, messages with row counts and timings
- Cancel a running statement, cap the row count, browse the history panel

**Structure tab**

- Columns with types, nullability, defaults and comments; indexes; foreign keys you can click to
  open the referenced table; `SHOW CREATE TABLE` on MySQL

**Redis**

- Key browser with pattern and type filter, grouped by namespace (`user:1:profile` → `user` › `1`)
- Value editor for strings, hashes, lists, sets, sorted sets and streams, with paging for big
  collections; TTL, rename and delete
- Console for any command with the reply shown as JSON; `INFO` dashboard

**Everywhere**

- Interface in English and Brazilian Portuguese; dark, light or follow-the-system theme
- Signed in-app updates on Windows, macOS and Linux

## Databases

| Engine | Driver | Status |
| --- | --- | --- |
| PostgreSQL 12+ | `tokio-postgres` (text protocol for results, extended for the catalog) | supported |
| MySQL 8 / MariaDB 10+ | `mysql_async` (small pool, text protocol) | supported |
| Redis 6+ | `redis` (`ConnectionManager`, RESP2/3) | supported |
| SQLite, SQL Server, MongoDB, ClickHouse, DuckDB | — | planned |

TLS uses `rustls`. *Prefer* and *Require* encrypt without checking the certificate (what most
clients do); *Verify* checks it against the operating system's trust store.

## Keyboard

| | |
| --- | --- |
| `Ctrl+N` | New connection |
| `Ctrl+T` / `Ctrl+W` | New query tab / close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Enter`, `F5` | Run query (selection or all) |
| `Ctrl+R` | Refresh the current tab |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom |
| Grid: `Enter` / `F2` | Edit cell · `Esc` cancel · `Tab` next cell · `Delete` set NULL · `Ctrl+C` copy |

On macOS `Ctrl` is `⌘`.

## Architecture

```
┌──────────────────────────── WebView (React + TypeScript) ────────────────────────────┐
│  pages/App.tsx                                                                        │
│  components/  atoms → molecules → organisms → templates   (DataGrid, SqlEditor…)      │
│  store/       zustand: ui (persisted prefs) · workspace (sessions, schema cache, tabs) │
│  services/    tauri.ts (invoke wrappers) · updater.ts                                 │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                        │ tauri::command
┌───────────────────────────────────────▼─────────────────── Rust (src-tauri) ─────────┐
│  commands/   thin adapters: connections · sessions · schema · query · table · redis   │
│  drivers/    SqlDriver trait → postgres · mysql; RedisSession; sql.rs (dialects,      │
│              filters, paging, UPDATE/INSERT/DELETE from pending edits)                │
│  store/      SQLite (WAL) via rusqlite: connections · history · saved queries         │
│  secrets.rs  keyring → OS credential store       error.rs: `errors.<key>|detail`      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Stack |
| --- | --- |
| Shell | Tauri 2 (WebView2 / WKWebView / WebKitGTK) |
| Drivers | `tokio-postgres`, `mysql_async`, `redis`, `rustls` |
| Storage | SQLite in WAL mode via `rusqlite`; passwords via `keyring` |
| UI | React 19, TypeScript 5, Vite 7, `zustand`, `lucide-react` |
| Grid & editor | custom virtualized grid on `@tanstack/react-virtual`; CodeMirror 6 + `lang-sql` |
| i18n | `react-i18next`, `en` and `pt-BR` |

Errors cross the bridge as `errors.<key>|detail` strings and are translated on the frontend, so
the Rust side never carries user-facing text.

## Install

Grab the latest build from the [releases page](https://github.com/lbss9/osprey/releases/latest):

| Platform | File |
| --- | --- |
| Windows 10/11 | `Osprey_x.y.z_x64-setup.exe` (per-user, no admin prompt) or the `.msi` |
| macOS 11+ | `Osprey_x.y.z_aarch64.dmg` (Apple Silicon) or `Osprey_x.y.z_x64.dmg` (Intel) |
| Linux x64 | `.AppImage`, `.deb` or `.rpm` |

Installed copies check the releases page on startup and offer to update in place; you can also
check from *Settings → About*. Every update package is signed and verified before it is applied.

macOS builds are not notarized yet. After copying Osprey to Applications run
`xattr -cr /Applications/Osprey.app` once, or right-click → *Open*.

## Building from source

Requirements: Node.js 20+, a stable Rust toolchain, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform (on Linux also
`libdbus-1-dev` for the credential store).

```bash
git clone https://github.com/lbss9/osprey.git
cd osprey
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # produce installers under src-tauri/target/release/bundle
npm run release -- 0.2.0   # bump versions, tag v0.2.0 and push (CI builds and publishes)
```

Type-check the frontend with `npx tsc --noEmit`, run the Rust tests with
`cargo test --manifest-path src-tauri/Cargo.toml`.

Your data lives in the app data folder (`%APPDATA%\com.lluan.osprey` on Windows,
`~/Library/Application Support/com.lluan.osprey` on macOS, `~/.local/share/com.lluan.osprey` on
Linux). *Settings → Data → Open folder* takes you there.

## Roadmap

- [x] Connections with OS keychain, groups, colours, read-only
- [x] Table browser with server-side filters, paging, batched edits and SQL preview
- [x] Query editor with autocompletion, multi-statement runs, cancel, history
- [x] Structure view (columns, indexes, foreign keys, DDL)
- [x] Redis browser, value editors, console, INFO
- [x] Signed auto-update for Windows, macOS and Linux
- [ ] SSH tunnels
- [ ] Command palette (open any table by name)
- [ ] Saved queries
- [ ] Table and column editing (DDL with preview)
- [ ] Visual EXPLAIN
- [ ] CSV import
- [ ] SQLite, SQL Server, MongoDB, ClickHouse
- [ ] JSON themes

## Contributing

Issues and pull requests are welcome. Keep the visual identity intact, follow the atomic design
layout under `src/components`, write code comments in English, and run `npx tsc --noEmit` and
`cargo test` before opening a PR.

## License

[MIT](LICENSE) © Luan Barbosa
