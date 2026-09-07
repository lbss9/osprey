import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Dropdown from "@/components/molecules/Dropdown";
import SettingRow from "@/components/molecules/SettingRow";
import ToggleRow from "@/components/molecules/ToggleRow";
import ToolButton from "@/components/molecules/ToolButton";
import i18n, { LANGUAGES } from "@/i18n";
import { useUi, type ThemeChoice } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { checkForUpdates, installUpdate, useUpdater } from "@/services/updater";
import { confirmDialog } from "@/utils/dialog";

const TABS = ["general", "appearance", "data", "about"] as const;
const num = (list: number[], suffix = "") => list.map((n) => ({ value: String(n), label: `${n}${suffix}` }));

export default function SettingsDialog() {
  const { t } = useTranslation();
  const ui = useUi();
  const ws = useWorkspace();
  const u = useUpdater();
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [secretsOk, setSecretsOk] = useState(true);

  useEffect(() => {
    if (!ui.settingsOpen) return;
    api.appInfo().then((i) => setVersion(i.version)).catch(() => setVersion("dev"));
    api.dataDirPath().then(setDataDir).catch(() => {});
    api.secretsAvailable().then(setSecretsOk).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && ui.closeSettings();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.settingsOpen, ui.closeSettings]);

  if (!ui.settingsOpen) return null;
  const tab = ui.settingsTab;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && ui.closeSettings()}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h2>{t("settings.title")}</h2>
          <ToolButton icon="x" title={t("common.close")} onClick={ui.closeSettings} />
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            {TABS.map((id) => (
              <Button key={id} variant="bare" className={`btn ${tab === id ? "active" : ""}`} onClick={() => ui.set({ settingsTab: id })}>
                {t(`settings.${id}`)}
              </Button>
            ))}
          </div>
          <div className="settings-pane">
            {tab === "general" && (
              <>
                <SettingRow label={t("settings.language")}>
                  <Dropdown value={i18n.language.startsWith("pt") ? "pt-BR" : "en"} options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))} onChange={(v) => void i18n.changeLanguage(v)} />
                </SettingRow>
                <SettingRow label={t("settings.pageSize")}>
                  <Dropdown value={String(ui.pageSize)} options={num([50, 100, 200, 500, 1000])} onChange={(v) => ui.set({ pageSize: Number(v) })} />
                </SettingRow>
                <SettingRow label={t("settings.queryLimit")}>
                  <Dropdown value={String(ui.queryLimit)} options={num([100, 500, 1000, 5000, 10000, 50000])} onChange={(v) => ui.set({ queryLimit: Number(v) })} />
                </SettingRow>
                <ToggleRow
                  label={t("settings.showSystem")}
                  desc={t("settings.showSystemHint")}
                  checked={ui.showSystemObjects}
                  onChange={(v) => {
                    ui.set({ showSystemObjects: v });
                    void ws.reloadAllSchemas();
                  }}
                />
                <ToggleRow label={t("settings.safeMode")} desc={t("settings.safeModeHint")} checked={ui.safeMode} onChange={(v) => ui.set({ safeMode: v })} />
                <ToggleRow label={t("settings.confirmClose")} checked={ui.confirmClose} onChange={(v) => ui.set({ confirmClose: v })} />
              </>
            )}
            {tab === "appearance" && (
              <>
                <SettingRow label={t("settings.theme")}>
                  <div className="theme-cards">
                    {(["auto", "dark", "light"] as ThemeChoice[]).map((th) => (
                      <Button key={th} variant="bare" className={`theme-card ${ui.theme === th ? "active" : ""}`} onClick={() => ui.set({ theme: th })}>
                        <span className="prev" style={{ background: th === "light" ? "#f2f5f8" : th === "dark" ? "#0e1216" : "linear-gradient(90deg,#0e1216 50%,#f2f5f8 50%)" }}>
                          <span style={{ background: th === "light" ? "#fff" : "#141a20", borderRight: "1px solid #3c4a58" }} />
                          <span />
                        </span>
                        <span>{t(`settings.theme${th[0].toUpperCase()}${th.slice(1)}`)}</span>
                      </Button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow label={t("settings.fontSize")}>
                  <Dropdown value={String(ui.fontSize)} options={num([11, 12, 13, 14, 15, 16], " px")} onChange={(v) => ui.set({ fontSize: Number(v) })} />
                </SettingRow>
                <SettingRow label={t("settings.editorFontSize")}>
                  <Dropdown value={String(ui.editorFontSize)} options={num([11, 12, 13, 14, 15, 16, 18], " px")} onChange={(v) => ui.set({ editorFontSize: Number(v) })} />
                </SettingRow>
              </>
            )}
            {tab === "data" && (
              <>
                <SettingRow label={t("settings.dataFolder")} desc={<span className="mono">{dataDir}</span>}>
                  <Button variant="secondary" size="sm" onClick={() => void api.openDataDir()}>
                    <Icon name="folder" size={14} /> {t("settings.openFolder")}
                  </Button>
                </SettingRow>
                <SettingRow label={t("settings.credentials")} desc={secretsOk ? t("settings.credentialsOk") : t("settings.credentialsFallback")} />
                <SettingRow label={t("settings.clearHistory")}>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      if (await confirmDialog(t("settings.clearHistory") + "?")) {
                        await api.historyClear();
                        ws.toast(t("common.ok"), "success");
                      }
                    }}
                  >
                    <Icon name="trash" size={14} /> {t("common.delete")}
                  </Button>
                </SettingRow>
              </>
            )}
            {tab === "about" && (
              <>
                <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                  <span className="logo" style={{ width: 56, height: 56, borderRadius: 16, background: "linear-gradient(135deg,#1b2a38,#0d151d)", display: "grid", placeItems: "center" }}>
                    <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
                      <path d="M12 4c-1.6 3-5 5-10 4.8 3 1.8 6.4 2.6 8.4 2.2L12 15l1.6-4c2 .4 5.4-.4 8.4-2.2C17 9 13.6 7 12 4z" fill="#6fd0f5" />
                      <circle cx="12" cy="8" r="1.2" fill="#ffc766" />
                    </svg>
                  </span>
                  <div>
                    <div style={{ fontSize: "1.3em", fontWeight: 700 }}>Osprey</div>
                    <div style={{ color: "var(--text-faint)" }}>{t("settings.version", { version })}</div>
                  </div>
                </div>
                <p style={{ color: "var(--text-soft)", lineHeight: 1.5, margin: 0 }}>{t("settings.aboutText")}</p>
                <SettingRow
                  label={t("settings.checkUpdates")}
                  desc={
                    <>
                      {u.status === "checking" && t("settings.checking")}
                      {u.status === "upToDate" && t("settings.upToDate")}
                      {(u.status === "available" || u.status === "downloading" || u.status === "installing") && t("settings.updateAvailable", { version: u.version })}
                      {u.status === "error" && `${t("settings.updateError")}: ${u.error}`}
                    </>
                  }
                >
                  {u.status === "available" ? (
                    <Button variant="primary" size="sm" onClick={() => void installUpdate()}>
                      {t("settings.install")}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => void checkForUpdates()} disabled={u.status === "checking" || u.status === "downloading"}>
                      <Icon name="refresh" size={14} /> {t("settings.checkUpdates")}
                    </Button>
                  )}
                </SettingRow>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button variant="secondary" size="sm" onClick={() => void openUrl("https://github.com/lbss9/osprey")}>
                    {t("settings.website")}
                  </Button>
                  <Badge>{t("settings.license")}</Badge>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
