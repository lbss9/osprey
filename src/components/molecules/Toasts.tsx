import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import { useWorkspace } from "@/store/workspace";
import { dismissUpdate, installUpdate, useUpdater } from "@/services/updater";

/** Bottom-right stack: transient toasts plus the update card. */
export default function Toasts() {
  const { t } = useTranslation();
  const toasts = useWorkspace((s) => s.toasts);
  const dismiss = useWorkspace((s) => s.dismissToast);
  const u = useUpdater();

  const updateVisible =
    !u.dismissed && (u.status === "available" || u.status === "downloading" || u.status === "installing");
  const busy = u.status !== "available";
  const pct = u.progress != null ? Math.round(u.progress * 100) : null;

  return (
    <div className="toasts">
      {toasts.map((tt) => (
        <div key={tt.id} className={`toast ${tt.kind}`} role="status" onClick={() => dismiss(tt.id)}>
          <span className="ic">
            <Icon name={tt.kind === "error" ? "alert" : tt.kind === "success" ? "check" : "info"} size={16} />
          </span>
          <span>{tt.text}</span>
        </div>
      ))}
      {updateVisible && (
        <div className="update-toast" role="status" aria-live="polite">
          <div className="update-toast-icon">
            <Icon name="download" size={16} />
          </div>
          <div className="update-toast-body">
            <div className="update-toast-title">{t("update.title", { version: u.version })}</div>
            <div className="update-toast-text">
              {u.status === "available" && t("update.available")}
              {u.status === "downloading" &&
                (pct != null ? t("update.downloadingPct", { pct }) : t("update.downloading"))}
              {u.status === "installing" && t("update.installing")}
            </div>
            {busy && (
              <div className="update-toast-bar">
                <div
                  className={`update-toast-fill ${pct == null ? "indeterminate" : ""}`}
                  style={pct != null ? { width: `${pct}%` } : undefined}
                />
              </div>
            )}
          </div>
          <div className="update-toast-actions">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void installUpdate()}>
              {t("update.install")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={dismissUpdate}>
              {t("update.later")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
