import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Input from "@/components/atoms/Input";
import Field from "@/components/molecules/Field";

/** Small modal asking for one line of text (name a query, rename a key…). */
export default function PromptDialog({
  title,
  label,
  initial = "",
  placeholder,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const ok = () => {
    const v = value.trim();
    if (v) onConfirm(v);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: "min(440px, calc(100vw - 40px))" }} role="dialog" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>
        <div className="dialog-body">
          <Field label={label}>
            <Input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} />
          </Field>
        </div>
        <div className="dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={ok} disabled={!value.trim()}>
            {confirmLabel ?? t("common.ok")}
          </Button>
        </div>
      </div>
    </div>
  );
}
