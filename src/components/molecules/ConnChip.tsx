import { connectionIdOf, databaseOf } from "@/utils/session";
import { useWorkspace } from "@/store/workspace";
import { driverLabel } from "@/utils/format";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)", sqlite: "var(--sqlite)" };

/** Small pill naming the connection a view belongs to. */
export default function ConnChip({ connectionId }: { connectionId: string }) {
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === connectionIdOf(connectionId)));
  const session = useWorkspace((s) => s.sessions[connectionId]);
  const dbOfKey = databaseOf(connectionId);
  if (!conn) return null;
  return (
    <span className="conn-chip" title={`${driverLabel(conn.driver)} ${session?.info?.version ?? ""}`}>
      <span className="dot" style={{ background: conn.color || DRIVER_COLOR[conn.driver] }} />
      {conn.name}
      {(dbOfKey ?? session?.database) && conn.driver !== "mysql" && <span style={{ color: "var(--text-faint)" }}>/ {dbOfKey ?? session.database}</span>}
    </span>
  );
}
