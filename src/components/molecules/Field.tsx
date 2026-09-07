import type { ReactNode } from "react";

/**
 * Form field: label on top, the control, an optional hint below. Every input
 * in a dialog sits inside one of these so spacing and typography match.
 */
export default function Field({
  label,
  hint,
  span2,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  /** span both columns of a `.form-grid` */
  span2?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${span2 ? "span2" : ""} ${className}`.trim()}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
