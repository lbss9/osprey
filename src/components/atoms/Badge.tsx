import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "amber" | "green" | "red";

export default function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === "neutral" ? "" : tone}`} title={title}>
      {children}
    </span>
  );
}
