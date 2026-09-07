import { useCallback, useRef, useState } from "react";

/**
 * Drag handle between two panes. Reports the delta in pixels; the parent
 * owns the size.
 */
export default function Resizer({
  direction,
  onDrag,
  onEnd,
}: {
  direction: "vertical" | "horizontal";
  onDrag: (delta: number) => void;
  onEnd?: () => void;
}) {
  const [active, setActive] = useState(false);
  const last = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      last.current = direction === "vertical" ? e.clientX : e.clientY;
      setActive(true);
      document.body.style.cursor = direction === "vertical" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!active) return;
      const pos = direction === "vertical" ? e.clientX : e.clientY;
      const delta = pos - last.current;
      last.current = pos;
      if (delta) onDrag(delta);
    },
    [active, direction, onDrag],
  );
  const onPointerUp = useCallback(() => {
    setActive(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onEnd?.();
  }, [onEnd]);

  return (
    <div
      className={`resizer ${direction === "vertical" ? "v" : "h"} ${active ? "active" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
