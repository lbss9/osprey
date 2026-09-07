import type { ReactNode } from "react";

/** Bottom strip of a view: left content, spacer, right content. */
export default function StatusBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="statusbar">
      {left}
      <span className="grow" />
      {right}
    </div>
  );
}
