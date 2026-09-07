import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Toggle from "@/components/atoms/Toggle";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { driverLabel } from "@/utils/format";
import type { ConnectionConfig, DriverKind, SslMode } from "@/types";

const COLORS = ["#37b7e6", "#4cc088", "#e2ac36", "#ec6060", "#a97ef0", "#f0a978", "#8fb0c9", "#e879b9"];
const DRIVERS: { id: DriverKind; color: string; hint: string }[] = [
  { id: "postgres", color: "var(--pg)", hint: "5432" },
  { id: "mysql", color: "var(--mysql)", hint: "3306" },
  { id: "redis", color: "var(--redis)", hint: "6379" },
];

function blank(driver: DriverKind = "postgres"): ConnectionConfig {
  return {
    id: "",
    name: "",
    driver,
    host: "localhost",
    port: driver === "postgres" ? 5432 : driver === "mysql" ? 3306 : 6379,
    user: driver === "postgres" ? "postgres" : driver === "mysql" ? "root" : "",
    database: "",
    sslMode: "prefer",
    color: null,
    group: null,
    readOnly: false,
    options: {},
    position: 0,
    createdAt: 0,
    hasPassword: false,
  };
}

/** Create/edit a connection. Test connects once without saving. */
export default function ConnectionDialog() {
  const { t } = useTranslation();
  const dlg = useUi((s) => s.connectionDialog);
  const close = useUi((s) => s.closeConnectionDialog);
  const ws = useWorkspace();
  const [form, setForm] = useState<ConnectionConfig>(blank());
  const [password, setPassword] = useState("");
  const [touchedPw, setTouchedPw] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [secretsOk, setSecretsOk] = useState(true);

  useEffect(() => {
    if (!dlg.open) return;
    const base = dlg.editing ? { ...dlg.editing } : blank();
    if (dlg.clone) {
      base.id = "";
      base.name = `${base.name} copy`;
      base.hasPassword = false;
    }
    setForm(base);
    setPassword("");
    setTouchedPw(false);
    setTest(null);
    setBusy(null);
    api.secretsAvailable().then(setSecretsOk).catch(() => {});
  }, [dlg]);

  useEffect(() => {
    if (!dlg.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dlg.open, busy, close]);

  if (!dlg.open) return null;

  const set = (patch: Partial<ConnectionConfig>) => setForm((f) => ({ ...f, ...patch }));
  const setDriver = (driver: DriverKind) => {
    const b = blank(driver);
    set({
      driver,
      port: b.port,
      user: form.user && form.driver !== "redis" && driver !== "redis" ? form.user : b.user,
      database: driver === "redis" ? "0" : form.driver === "redis" ? "" : form.database,
      // Redis has no opportunistic TLS: a port is plain or TLS
      sslMode: driver === "redis" ? "disable" : form.driver === "redis" ? "prefer" : form.sslMode,
    });
  };
  const input = () => ({
    ...form,
    password: touchedPw || dlg.clone ? password : undefined,
  });

  const doTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const info = await api.connectionTest(input());
      setTest({ ok: true, text: t("connection.testOk", { driver: driverLabel(info.driver), version: info.version }) });
    } catch (e) {
      setTest({ ok: false, text: translateError(e) });
    } finally {
      setBusy(null);
    }
  };

  const doSave = async (connect: boolean) => {
    setBusy("save");
    try {
      const saved = await api.connectionSave(input());
      await ws.loadConnections();
      close();
      if (connect) {
        const ok = await ws.connect(saved.id);
        if (ok) ws.toast(t("toast.connected", { name: saved.name }), "success");
      }
    } catch (e) {
      setTest({ ok: false, text: translateError(e) });
    } finally {
      setBusy(null);
    }
  };

  const isRedis = form.driver === "redis";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>{dlg.editing && !dlg.clone ? t("connection.edit") : t("connection.new")}</h2>
          <Button size="sm" icon onClick={close} disabled={!!busy}>
            <Icon name="x" size={14} />
          </Button>
        </div>
        <div className="dialog-body">
          <div className="driver-cards">
            {DRIVERS.map((d) => (
              <Button
                key={d.id}
                variant="bare"
                className={`driver-card ${form.driver === d.id ? "active" : ""}`}
                style={{ ["--card-color" as string]: d.color }}
                onClick={() => setDriver(d.id)}
              >
                <span className="ic">
                  <Icon name={d.id === "redis" ? "keyRound" : "database"} size={16} />
                </span>
                <b>{t(`connection.${d.id}`)}</b>
                <small>:{d.hint}</small>
              </Button>
            ))}
          </div>
          <div className="form-grid">
            <div className="field span2">
              <label>{t("connection.name")}</label>
              <input className="input" value={form.name} placeholder={t("connection.namePlaceholder")} onChange={(e) => set({ name: e.target.value })} autoFocus />
            </div>
            <div className="field">
              <label>{t("connection.host")}</label>
              <input className="input mono" value={form.host} onChange={(e) => set({ host: e.target.value })} />
            </div>
            <div className="field">
              <label>{t("connection.port")}</label>
              <input className="input mono" type="number" value={form.port} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
            </div>
            <div className="field">
              <label>{t("connection.user")}</label>
              <input className="input mono" value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder={isRedis ? "default" : ""} />
            </div>
            <div className="field">
              <label>{t("connection.password")}</label>
              <input
                className="input mono"
                type="password"
                value={password}
                placeholder={form.hasPassword && !touchedPw ? "••••••••" : ""}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setTouchedPw(true);
                }}
              />
              {form.hasPassword && <span className="hint">{t("connection.passwordKeep")}</span>}
            </div>
            <div className="field">
              <label>{isRedis ? t("connection.redisDb") : form.driver === "mysql" ? t("connection.databaseOptional") : t("connection.database")}</label>
              <input className="input mono" value={form.database} onChange={(e) => set({ database: e.target.value })} placeholder={isRedis ? "0" : form.driver === "postgres" ? "postgres" : ""} />
            </div>
            <div className="field">
              <label>{t("connection.ssl")}</label>
              <select className="select" value={form.sslMode} onChange={(e) => set({ sslMode: e.target.value as SslMode })}>
                <option value="disable">{t("connection.sslDisable")}</option>
                {!isRedis && <option value="prefer">{t("connection.sslPrefer")}</option>}
                <option value="require">{t("connection.sslRequire")}</option>
                <option value="verify">{t("connection.sslVerify")}</option>
              </select>
            </div>
            <div className="field">
              <label>{t("connection.color")}</label>
              <div className="color-swatches">
                <button type="button" className={`swatch none ${!form.color ? "active" : ""}`} onClick={() => set({ color: null })} title={t("common.none")} />
                {COLORS.map((c) => (
                  <button key={c} type="button" className={`swatch ${form.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => set({ color: c })} />
                ))}
              </div>
            </div>
            <div className="field">
              <label>{t("connection.group")}</label>
              <input className="input" value={form.group ?? ""} placeholder={t("connection.groupPlaceholder")} onChange={(e) => set({ group: e.target.value || null })} />
            </div>
            <div className="field span2">
              <Toggle checked={form.readOnly} onChange={(v) => set({ readOnly: v })} label={t("connection.readOnly")} />
              <span className="hint">{t("connection.readOnlyHint")}</span>
            </div>
            {!secretsOk && (
              <div className="callout span2">
                <Icon name="alert" size={16} />
                <span>{t("connection.keychainWarning")}</span>
              </div>
            )}
          </div>
        </div>
        <div className="dialog-foot">
          <Button variant="secondary" onClick={() => void doTest()} disabled={!!busy}>
            {busy === "test" ? <span className="spinner" /> : <Icon name="plugZap" size={14} />}
            {busy === "test" ? t("connection.testing") : t("connection.test")}
          </Button>
          {test && (
            <span className={`test-result ${test.ok ? "ok" : "err"}`}>
              <Icon name={test.ok ? "check" : "alert"} size={14} />
              {test.text}
            </span>
          )}
          <span className="grow" />
          <Button variant="ghost" onClick={close} disabled={!!busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" onClick={() => void doSave(false)} disabled={!!busy || !form.host}>
            {t("connection.save")}
          </Button>
          <Button variant="primary" onClick={() => void doSave(true)} disabled={!!busy || !form.host}>
            {busy === "save" ? <span className="spinner" /> : <Icon name="plug" size={14} />}
            {t("connection.saveAndConnect")}
          </Button>
        </div>
      </div>
    </div>
  );
}
