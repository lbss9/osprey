import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";
import ConnChip from "@/components/molecules/ConnChip";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { formatTtl } from "@/utils/format";
import type { Tab } from "@/types";

/** Server dashboard (Redis INFO sections; basic facts for SQL servers). */
export default function InfoView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === tab.connectionId));
  const session = useWorkspace((s) => s.sessions[tab.connectionId]);
  const [info, setInfo] = useState<Record<string, Record<string, string>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (conn?.driver !== "redis") return;
    api.redisInfo(tab.connectionId).then(setInfo).catch((e) => setError(translateError(e)));
  };
  useEffect(load, [tab.connectionId, conn?.driver]);

  const g = (section: string, key: string) => info?.[section]?.[key] ?? "";
  const cards =
    conn?.driver === "redis"
      ? [
          { k: t("redis.version"), v: g("server", "redis_version") },
          { k: t("redis.uptime"), v: formatTtl(Number(g("server", "uptime_in_seconds")) || 0) },
          { k: t("redis.clients"), v: g("clients", "connected_clients") },
          { k: t("redis.memory"), v: g("memory", "used_memory_human") },
          { k: "Peak", v: g("memory", "used_memory_peak_human") },
          { k: "Ops/s", v: g("stats", "instantaneous_ops_per_sec") },
          { k: "Hit rate", v: hitRate(g("stats", "keyspace_hits"), g("stats", "keyspace_misses")) },
          { k: "Role", v: g("replication", "role") },
        ]
      : [
          { k: t("redis.version"), v: session?.info?.version ?? "" },
          { k: t("sidebar.database"), v: session?.info?.database ?? "" },
          { k: t("connection.user"), v: session?.info?.user ?? "" },
          { k: t("connection.host"), v: `${conn?.host}:${conn?.port}` },
        ];

  return (
    <div className="main-body">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="info" size={14} style={{ color: "var(--accent)" }} />
          <b>{t("redis.info")}</b>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <Button size="sm" onClick={load} title={t("common.refresh")}>
          <Icon name="refresh" size={14} />
        </Button>
      </div>
      <div className="info-view">
        {error && <div className="messages err">{error}</div>}
        {conn?.driver === "redis" && !info && !error && <Spinner size="lg" />}
        <div className="stat-cards">
          {cards.map((c) => (
            <div className="stat" key={c.k}>
              <div className="k">{c.k}</div>
              <div className="v">{c.v || "—"}</div>
            </div>
          ))}
        </div>
        {info &&
          Object.entries(info).map(([section, values]) => (
            <section key={section} style={{ marginBottom: 18 }}>
              <h3 style={{ fontSize: "0.8em", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-faint)", margin: "0 0 8px" }}>{section}</h3>
              <table className="table">
                <tbody>
                  {Object.entries(values).map(([k, v]) => (
                    <tr key={k}>
                      <td className="mono faint" style={{ width: 280 }}>
                        {k}
                      </td>
                      <td className="mono">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
      </div>
    </div>
  );
}

function hitRate(hits: string, misses: string): string {
  const h = Number(hits) || 0;
  const m = Number(misses) || 0;
  if (h + m === 0) return "—";
  return `${((h / (h + m)) * 100).toFixed(1)}%`;
}
