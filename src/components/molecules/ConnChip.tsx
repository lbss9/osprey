import { useWorkspace } from "@/store/workspace";
import { driverLabel } from "@/utils/format";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)", sqlite: "var(--sqlite)" };

/** Small pill naming the connection a view belongs to. */
export default function ConnChip({ connectionId }: { connectionId: string }) {
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === connectionId));
  const session = useWorkspace((s) => s.sessions[connectionId]);
  if (!conn) return null;
  return (
    <span className="conn-chip" title={`${driverLabel(conn.driver)} ${session?.info?.version ?? ""}`}>
      <span className="dot" style={{ background: conn.color || DRIVER_COLOR[conn.driver] }} />
      {conn.name}
      {session?.database && conn.driver !== "mysql" && <span style={{ color: "var(--text-faint)" }}>/ {session.database}</span>}
    </span>
  );
}
