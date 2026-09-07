import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import Tab from "@/components/atoms/Tab";
import Dropdown from "@/components/molecules/Dropdown";
import Field from "@/components/molecules/Field";
import ToggleRow from "@/components/molecules/ToggleRow";
import ToolButton from "@/components/molecules/ToolButton";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { driverLabel } from "@/utils/format";
import { openFileDialog } from "@/utils/dialog";
import type { ConnectionConfig, DriverKind, SshOptions, SslMode } from "@/types";

const COLORS = ["#37b7e6", "#4cc088", "#e2ac36", "#ec6060", "#a97ef0", "#f0a978", "#8fb0c9", "#e879b9"];
const DRIVERS: { id: DriverKind; color: string; hint: string }[] = [
  { id: "postgres", color: "var(--pg)", hint: "5432" },
  { id: "mysql", color: "var(--mysql)", hint: "3306" },
  { id: "redis", color: "var(--redis)", hint: "6379" },
  { id: "sqlite", color: "var(--sqlite)", hint: "file" },
  { id: "clickhouse", color: "var(--clickhouse)", hint: "8123" },
  { id: "mssql", color: "var(--mssql)", hint: "1433" },
];

function blank(driver: DriverKind = "postgres"): ConnectionConfig {
  return {
    id: "",
    name: "",
    driver,
    host: "localhost",
    port: driver === "postgres" ? 5432 : driver === "mysql" ? 3306 : driver === "redis" ? 6379 : driver === "clickhouse" ? 8123 : driver === "mssql" ? 1433 : 0,
    user: driver === "postgres" ? "postgres" : driver === "mysql" ? "root" : "",
    database: driver === "redis" ? "0" : "",
    sslMode: driver === "redis" ? "disable" : "prefer",
    color: null,
    group: null,
    readOnly: false,
    options: {},
    position: 0,
    createdAt: 0,
    hasPassword: false,
    hasSshPassword: false,
  };
}

const SSH_DEFAULT: SshOptions = { enabled: false, host: "", port: 22, user: "", auth: "key", keyPath: "" };

/**
 * Create / edit ("Properties") a connection. Two tabs: General and Advanced.
 * Test connects once without saving.
 */
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
  const [tab, setTab] = useState<"general" | "ssh" | "advanced">("general");
  const [showPw, setShowPw] = useState(false);
  const [sshPassword, setSshPassword] = useState("");
  const [touchedSsh, setTouchedSsh] = useState(false);

  useEffect(() => {
    if (!dlg.open) return;
    const base = dlg.editing ? { ...dlg.editing, options: { ...(dlg.editing.options ?? {}) } } : blank();
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
    setTab("general");
    setShowPw(false);
    setSshPassword("");
    setTouchedSsh(false);
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
  const setOption = (key: string, value: unknown) =>
    setForm((f) => {
      const options = { ...(f.options ?? {}) };
      if (value === "" || value === null || value === undefined) delete options[key];
      else options[key] = value;
      return { ...f, options };
    });
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
    sshPassword: touchedSsh || dlg.clone ? sshPassword : undefined,
  });
  const ssh: SshOptions = { ...SSH_DEFAULT, ...((form.options?.ssh as Partial<SshOptions> | undefined) ?? {}) };
  const setSsh = (patch: Partial<SshOptions>) => setOption("ssh", { ...ssh, ...patch });

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
        const ok = ws.sessions[saved.id]?.status === "open" ? await ws.reconnect(saved.id) : await ws.connect(saved.id);
        if (ok) ws.toast(t("toast.connected", { name: saved.name }), "success");
      }
    } catch (e) {
      setTest({ ok: false, text: translateError(e) });
    } finally {
      setBusy(null);
    }
  };

  const isRedis = form.driver === "redis";
  const isSqlite = form.driver === "sqlite";
  const editing = !!dlg.editing && !dlg.clone;
  const sslOptions = [
    { value: "disable", label: t("connection.sslDisable") },
    ...(!isRedis ? [{ value: "prefer", label: t("connection.sslPrefer") }] : []),
    { value: "require", label: t("connection.sslRequire") },
    { value: "verify", label: t("connection.sslVerify") },
  ];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>{editing ? t("connection.properties") : t("connection.new")}</h2>
          <div className="pill-tabs">
            <Tab active={tab === "general"} onClick={() => setTab("general")}>
              {t("connection.general")}
            </Tab>
            {!isSqlite && (
            <Tab active={tab === "ssh"} onClick={() => setTab("ssh")}>
              {t("connection.ssh")}
              {ssh.enabled && <span className="tab-dot" />}
            </Tab>
            )}
            <Tab active={tab === "advanced"} onClick={() => setTab("advanced")}>
              {t("connection.advanced")}
            </Tab>
          </div>
          <ToolButton icon="x" title={t("common.close")} onClick={close} disabled={!!busy} />
        </div>
        {/* both panes stay mounted in one grid cell so the dialog keeps the
            height of the taller one when switching tabs */}
        <div className="dialog-body tab-stack">
          <div className={`tab-pane ${tab === "general" ? "" : "hidden-pane"}`} aria-hidden={tab !== "general"}>
              <div className="driver-cards">
                {DRIVERS.map((d) => (
                  <Button key={d.id} variant="bare" className={`driver-card ${form.driver === d.id ? "active" : ""}`} style={{ ["--card-color" as string]: d.color }} onClick={() => setDriver(d.id)}>
                    <span className="ic">
                      <Icon name={d.id === "redis" ? "keyRound" : "database"} size={16} />
                    </span>
                    <b>{t(`connection.${d.id}`)}</b>
                    <small>:{d.hint}</small>
                  </Button>
                ))}
              </div>
              <div className="form-grid">
                <Field label={t("connection.name")} span2>
                  <Input value={form.name} placeholder={t("connection.namePlaceholder")} onChange={(e) => set({ name: e.target.value })} autoFocus />
                </Field>
                {isSqlite && (
                  <>
                    <Field label={t("connection.sqliteFile")} span2>
                      <div className="input-row">
                        <Input mono value={form.database} placeholder="C:\\data\\app.db" onChange={(e) => set({ database: e.target.value })} />
                        <Button
                          variant="secondary"
                          size="md"
                          onClick={async () => {
                            const p = await openFileDialog(t("connection.sqliteFile"));
                            if (p) set({ database: p, name: form.name || p.split(/[\\/]/).pop() || "" });
                          }}
                        >
                          {t("connection.browse")}
                        </Button>
                      </div>
                    </Field>
                    <div className="span2">
                      <ToggleRow label={t("connection.sqliteCreate")} desc={t("connection.sqliteCreateHint")} checked={!!form.options?.create} onChange={(v) => setOption("create", v || "")} />
                    </div>
                  </>
                )}
                {!isSqlite && (
                <>
                <Field label={t("connection.host")}>
                  <Input mono value={form.host} onChange={(e) => set({ host: e.target.value })} />
                </Field>
                <Field label={t("connection.port")}>
                  <Input mono type="number" value={form.port} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
                </Field>
                <Field label={t("connection.user")}>
                  <Input mono value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder={isRedis ? "default" : ""} />
                </Field>
                <Field label={t("connection.password")} hint={form.hasPassword ? t("connection.passwordKeep") : undefined}>
                  <div className="input-row">
                    <Input
                      mono
                      type={showPw ? "text" : "password"}
                      value={password}
                      placeholder={form.hasPassword && !touchedPw ? "••••••••" : ""}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setTouchedPw(true);
                      }}
                    />
                    <ToolButton icon="eye" title={showPw ? t("common.no") : t("common.yes")} active={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </Field>
                <Field label={isRedis ? t("connection.redisDb") : form.driver === "mysql" ? t("connection.databaseOptional") : t("connection.database")}>
                  <Input mono value={form.database} onChange={(e) => set({ database: e.target.value })} placeholder={isRedis ? "0" : form.driver === "postgres" ? "postgres" : form.driver === "clickhouse" ? "default" : form.driver === "mssql" ? "master" : ""} />
                </Field>
                <Field label={t("connection.ssl")}>
                  <Dropdown value={form.sslMode} options={sslOptions} onChange={(v) => set({ sslMode: v as SslMode })} ariaLabel={t("connection.ssl")} />
                </Field>
                </>
                )}
                <Field label={t("connection.color")}>
                  <div className="color-swatches">
                    <button type="button" className={`swatch none ${!form.color ? "active" : ""}`} onClick={() => set({ color: null })} title={t("common.none")} />
                    {COLORS.map((c) => (
                      <button key={c} type="button" className={`swatch ${form.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => set({ color: c })} />
                    ))}
                  </div>
                </Field>
                <Field label={t("connection.group")}>
                  <Input value={form.group ?? ""} placeholder={t("connection.groupPlaceholder")} onChange={(e) => set({ group: e.target.value || null })} />
                </Field>
                {!secretsOk && (
                  <div className="callout span2">
                    <Icon name="alert" size={16} />
                    <span>{t("connection.keychainWarning")}</span>
                  </div>
                )}
              </div>
          </div>
          <div className={`tab-pane ${tab === "ssh" ? "" : "hidden-pane"}`} aria-hidden={tab !== "ssh"}>
            <div className="form-grid">
              <div className="span2">
                <ToggleRow label={t("connection.sshEnable")} desc={t("connection.sshEnableHint")} checked={ssh.enabled} onChange={(v) => setSsh({ enabled: v })} />
              </div>
              <Field label={t("connection.sshHost")}>
                <Input mono value={ssh.host} disabled={!ssh.enabled} onChange={(e) => setSsh({ host: e.target.value })} placeholder="bastion.example.com" />
              </Field>
              <Field label={t("connection.sshPort")}>
                <Input mono type="number" value={ssh.port} disabled={!ssh.enabled} onChange={(e) => setSsh({ port: Number(e.target.value) || 22 })} />
              </Field>
              <Field label={t("connection.sshUser")}>
                <Input mono value={ssh.user} disabled={!ssh.enabled} onChange={(e) => setSsh({ user: e.target.value })} />
              </Field>
              <Field label={t("connection.sshAuth")}>
                <Dropdown
                  value={ssh.auth}
                  disabled={!ssh.enabled}
                  options={[
                    { value: "key", label: t("connection.sshAuthKey") },
                    { value: "password", label: t("connection.sshAuthPassword") },
                  ]}
                  onChange={(v) => setSsh({ auth: v as SshOptions["auth"] })}
                />
              </Field>
              {ssh.auth === "key" && (
                <Field label={t("connection.sshKeyPath")} span2>
                  <div className="input-row">
                    <Input mono value={ssh.keyPath ?? ""} disabled={!ssh.enabled} placeholder="~/.ssh/id_ed25519" onChange={(e) => setSsh({ keyPath: e.target.value })} />
                    <Button
                      variant="secondary"
                      size="md"
                      disabled={!ssh.enabled}
                      onClick={async () => {
                        const p = await openFileDialog(t("connection.sshKeyPath"));
                        if (p) setSsh({ keyPath: p });
                      }}
                    >
                      {t("connection.browse")}
                    </Button>
                  </div>
                </Field>
              )}
              <Field label={ssh.auth === "key" ? t("connection.sshPassphrase") : t("connection.sshPassword")} hint={form.hasSshPassword ? t("connection.sshPasswordKeep") : undefined} span2>
                <Input
                  mono
                  type="password"
                  value={sshPassword}
                  disabled={!ssh.enabled}
                  placeholder={form.hasSshPassword && !touchedSsh ? "••••••••" : ""}
                  onChange={(e) => {
                    setSshPassword(e.target.value);
                    setTouchedSsh(true);
                  }}
                />
              </Field>
            </div>
          </div>
          <div className={`tab-pane ${tab === "advanced" ? "" : "hidden-pane"}`} aria-hidden={tab !== "advanced"}>
            <div className="form-grid">
              <div className="span2">
                <ToggleRow label={t("connection.readOnly")} desc={`${t("connection.readOnlyHint")}. ${t("connection.readOnlyServer")}`} checked={form.readOnly} onChange={(v) => set({ readOnly: v })} />
              </div>
              <Field label={t("connection.connectTimeout")}>
                <Input mono type="number" min={1} value={(form.options?.connectTimeout as number | undefined) ?? ""} placeholder="15" onChange={(e) => setOption("connectTimeout", e.target.value ? Number(e.target.value) : "")} />
              </Field>
              {form.driver === "postgres" && (
                <Field label={t("connection.applicationName")} hint={t("connection.applicationNameHint")}>
                  <Input mono value={(form.options?.applicationName as string | undefined) ?? ""} placeholder="Osprey" onChange={(e) => setOption("applicationName", e.target.value)} />
                </Field>
              )}
            </div>
          </div>
        </div>
        <div className="dialog-foot">
          <Button variant="secondary" onClick={() => void doTest()} disabled={!!busy}>
            {busy === "test" ? <Spinner /> : <Icon name="plugZap" size={14} />}
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
          <Button variant="secondary" onClick={() => void doSave(false)} disabled={!!busy || (isSqlite ? !form.database : !form.host)}>
            {t("connection.save")}
          </Button>
          <Button variant="primary" onClick={() => void doSave(true)} disabled={!!busy || (isSqlite ? !form.database : !form.host)}>
            {busy === "save" ? <Spinner /> : <Icon name="plug" size={14} />}
            {t("connection.saveAndConnect")}
          </Button>
        </div>
      </div>
    </div>
  );
}
