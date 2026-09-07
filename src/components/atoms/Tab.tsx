import type { ReactNode } from "react";
import Button from "@/components/atoms/Button";

/** One pill/tab in a `.pill-tabs` or `.result-tabs` strip. */
export default function Tab({ active, onClick, children, className = "" }: { active: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Button variant="bare" className={`${className} ${active ? "active" : ""}`.trim()} aria-selected={active} role="tab" onClick={onClick}>
      {children}
    </Button>
  );
}
