import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import SqlPreview from "@/components/molecules/SqlPreview";

/** "Here is what will run" confirmation before writing pending edits. */
export default function ApplyDialog({
  statements,
  connectionName,
  busy,
  previewOnly,
  onConfirm,
  onClose,
}: {
  statements: string[];
  connectionName: string;
  busy?: boolean;
  previewOnly?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const deletes = statements.filter((s) => s.startsWith("DELETE")).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h2>{previewOnly ? t("changes.previewTitle") : t("changes.confirmTitle")}</h2>
          <Button size="sm" icon onClick={onClose} disabled={busy}>
            <Icon name="x" size={14} />
          </Button>
        </div>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className={`callout ${deletes ? "danger" : "info"}`}>
            <Icon name={deletes ? "alert" : "info"} size={16} />
            <span>
              {t("changes.confirmText", { name: connectionName })}
              {deletes > 0 && ` ${t("changes.confirmDelete", { count: deletes })}`}
            </span>
          </div>
          <SqlPreview statements={statements} />
        </div>
        <div className="dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {previewOnly ? t("common.close") : t("common.cancel")}
          </Button>
          {!previewOnly && (
            <Button variant={deletes ? "danger" : "primary"} onClick={onConfirm} disabled={busy} className={deletes ? "btn-primary" : ""}>
              {busy ? <Spinner /> : <Icon name="check" size={14} />}
              {t("changes.apply")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
