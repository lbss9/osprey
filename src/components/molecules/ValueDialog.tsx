import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import { copyText } from "@/utils/clipboard";
import { looksLikeJson, prettyJson } from "@/utils/format";

/** Full-size viewer/editor for one cell or Redis value. */
export default function ValueDialog({
  title,
  value,
  editable,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  editable?: boolean;
  onSave?: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  const [pretty, setPretty] = useState(false);
  const isJson = looksLikeJson(value);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = pretty && isJson ? prettyJson(text) : text;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h2 className="mono" style={{ fontSize: "1em" }}>{title}</h2>
          {isJson && (
            <div className="pill-tabs">
              <Button variant="bare" className={!pretty ? "active" : ""} onClick={() => setPretty(false)}>
                {t("redis.raw")}
              </Button>
              <Button variant="bare" className={pretty ? "active" : ""} onClick={() => setPretty(true)}>
                {t("redis.prettyJson")}
              </Button>
            </div>
          )}
          <Button size="sm" icon onClick={() => void copyText(shown)} title={t("common.copy")}>
            <Icon name="copy" size={14} />
          </Button>
          <Button size="sm" icon onClick={onClose} title={t("common.close")}>
            <Icon name="x" size={14} />
          </Button>
        </div>
        <div className="dialog-body value-viewer">
          <textarea
            className="textarea mono"
            value={shown}
            readOnly={!editable}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{ minHeight: "50vh" }}
          />
        </div>
        {editable && (
          <div className="dialog-foot">
            <span className="grow" />
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => onSave?.(pretty && isJson ? shown : text)}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
