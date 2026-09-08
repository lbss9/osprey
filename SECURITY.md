# Security

## Reporting a vulnerability

Open a private report at <https://github.com/lbss9/osprey/security/advisories/new>, or write to
luan.barbosa.dev@gmail.com. Please include the version (Settings → About), the platform and the
steps to reproduce. You should get an answer within a week; fixes ship as a patch release that
installed copies pick up through the in-app updater.

## What the app does with your data

- **Connections** are stored in a local SQLite file in the app data folder. Passwords, SSH
  passwords and key passphrases go to the operating system credential store (Windows Credential
  Manager, macOS Keychain, Secret Service on Linux). When no store is available, they fall back to
  the local database and *Settings → Data* says so.
- **Query history** is kept in the same local database, including literal values in the SQL you
  ran. It can be turned off (*Settings → Data → Save query history*) and cleared at any time.
- **Nothing leaves your machine** except the connections you open and one request to GitHub
  Releases for the update check. There is no telemetry.

## How the app is built

- Every write to a database goes through a preview and a single transaction; row updates and
  deletes require a primary key. A connection marked *read-only* is enforced on the server where
  the engine allows it (PostgreSQL, MySQL/MariaDB, SQLite, ClickHouse) and by the UI everywhere.
- Generated SQL quotes identifiers and literals per dialect; the only raw SQL is what you type
  in the query editor, the custom `WHERE` line and the Redis console.
- SSH tunnels verify host keys against `~/.ssh/known_hosts` with the same policy as
  `ssh -o StrictHostKeyChecking=accept-new`: a new host is recorded, a changed key is refused.
- TLS: *Verify* checks the server certificate against the OS trust store. *Prefer* and *Require*
  encrypt without checking identity, like most database clients; use *Verify* for servers on the
  internet.
- The webview only loads the bundled app: the Content Security Policy forbids remote scripts,
  frames and forms. Tauri capabilities expose only the window, dialog, clipboard, updater and
  opener APIs the interface uses.
- Updates are signed (minisign) and the signature is verified before the package is applied.
  macOS builds are not notarized yet.
