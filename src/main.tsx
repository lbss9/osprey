import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import "./styles/app.css";
import App from "./pages/App";

async function bootstrap() {
  // `?mock=1` in dev swaps the Rust backend for an in-memory stand-in so the
  // UI can run (and be tested) in a plain browser. Dropped from release builds.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
    const { installTauriMock } = await import("./dev/tauriMock");
    installTauriMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
