import type { ReactNode } from "react";

/** Settings row with any control on the right (dropdown, button, text). */
export default function SettingRow({ label, desc, children }: { label: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {desc && <span className="setting-desc">{desc}</span>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}
