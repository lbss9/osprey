import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Spinner from "@/components/atoms/Spinner";
import TabButton from "@/components/atoms/Tab";
import ConnChip from "@/components/molecules/ConnChip";
import ToolButton from "@/components/molecules/ToolButton";
import DataGrid from "@/components/organisms/DataGrid";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { onEvent } from "@/services/events";
import { translateError } from "@/i18n";
import { formatBytes, formatNumber } from "@/utils/format";
import type { Cell, MemoryReport, PubSubMessage, SlowlogEntry, Tab } from "@/types";

type Tool = "slowlog" | "memory" | "pubsub";

/** Redis diagnostics: slow log, memory by key prefix, pub/sub monitor. */
export default function RedisToolsView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>((tab.table as Tool) || "slowlog");
  return (
    <div className="main-body">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="zap" size={14} style={{ color: "var(--accent)" }} />
          <b>{t("redisTools.title")}</b>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <div className="pill-tabs">
          <TabButton active={tool === "slowlog"} onClick={() => setTool("slowlog")}>
            {t("redisTools.slowlog")}
          </TabButton>
          <TabButton active={tool === "memory"} onClick={() => setTool("memory")}>
            {t("redisTools.memory")}
          </TabButton>
          <TabButton active={tool === "pubsub"} onClick={() => setTool("pubsub")}>
            {t("redisTools.pubsub")}
          </TabButton>
        </div>
      </div>
      {tool === "slowlog" && <Slowlog connectionId={tab.connectionId} />}
      {tool === "memory" && <Memory connectionId={tab.connectionId} />}
      {tool === "pubsub" && <PubSub connectionId={tab.connectionId} />}
    </div>
  );
}

/* --------------------------------- slowlog -------------------------------- */

function Slowlog({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const [rows, setRows] = useState<SlowlogEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await api.redisSlowlog(connectionId, 128));
    } catch (e) {
      toast(translateError(e), "error");
    } finally {
      setBusy(false);
    }
  }, [connectionId, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  const columns = [
    { name: t("redisTools.when"), dataType: "time", kind: "date" as const },
    { name: t("redisTools.duration"), dataType: "ms", kind: "number" as const },
    { name: t("redisTools.command"), dataType: "text", kind: "string" as const },
    { name: t("redisTools.client"), dataType: "text", kind: "string" as const },
  ];
  const data: Cell[][] = (rows ?? []).map((r) => [new Date(r.at * 1000).toLocaleString(), Math.round(r.durationUs / 100) / 10, r.command, `${r.client}${r.name ? ` (${r.name})` : ""}`]);
  return (
    <>
      <div className="toolbar" style={{ height: 34 }}>
        <span style={{ color: "var(--text-faint)", fontSize: "0.88em" }}>{t("redisTools.slowlogHint")}</span>
        <span className="grow" />
        <ToolButton icon="refresh" title={t("common.refresh")} onClick={() => void load()} busy={busy} />
      </div>
      <DataGrid columns={columns} rows={data} loading={busy && rows === null} emptyText={t("redisTools.slowlogEmpty")} />
    </>
  );
}

/* --------------------------------- memory --------------------------------- */

function Memory({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const [pattern, setPattern] = useState("*");
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setReport(await api.redisMemory(connectionId, pattern, 5000));
    } catch (e) {
      toast(translateError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run();
    // first load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);
  const max = report?.groups[0]?.bytes ?? 1;
  return (
    <>
      <div className="toolbar" style={{ height: 40 }}>
        <Input mono small value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} style={{ width: 220 }} />
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="zap" size={13} />} {t("redisTools.analyze")}
        </Button>
        {report && (
          <>
            <Badge tone="accent">{t("redisTools.sampled", { count: formatNumber(report.sampled) })}{report.done ? "" : "+"}</Badge>
            <Badge>{formatBytes(report.totalBytes)}</Badge>
          </>
        )}
        <span className="grow" />
        <span style={{ color: "var(--text-faint)", fontSize: "0.88em" }}>{t("redisTools.memoryHint")}</span>
      </div>
      <div className="memory-list">
        {report?.groups.map((g) => (
          <div className="memory-row" key={g.prefix}>
            <span className="mono prefix">{g.prefix}</span>
            <span className="bar">
              <span style={{ width: `${Math.max(2, Math.round((g.bytes / max) * 100))}%` }} />
            </span>
            <span className="num">{formatBytes(g.bytes)}</span>
            <span className="num faint">{t("redisTools.keys", { count: formatNumber(g.keys) })}</span>
          </div>
        ))}
        {report && report.groups.length === 0 && <div className="results-empty">{t("redis.noKeys")}</div>}
      </div>
    </>
  );
}

/* --------------------------------- pub/sub -------------------------------- */

function PubSub({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const [channels, setChannels] = useState("");
  const [subId, setSubId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PubSubMessage[]>([]);
  const [pubChannel, setPubChannel] = useState("");
  const [pubMsg, setPubMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!subId) return;
    const off = onEvent<PubSubMessage>("redis-pubsub", (m) => {
      if (m.subId !== subId) return;
      setMessages((list) => [...list.slice(-499), m]);
    });
    return off;
  }, [subId]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);
  useEffect(() => () => {
    if (subId) void api.redisUnsubscribe(connectionId, subId);
    // stop listening when the tab unmounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    const parts = channels.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    try {
      const id = await api.redisSubscribe(connectionId, parts.filter((p) => !/[*?[]/.test(p)), parts.filter((p) => /[*?[]/.test(p)));
      setSubId(id);
      setMessages([]);
    } catch (e) {
      toast(translateError(e), "error");
    }
  };
  const stop = async () => {
    if (!subId) return;
    await api.redisUnsubscribe(connectionId, subId).catch(() => {});
    setSubId(null);
  };
  const publish = async () => {
    if (!pubChannel.trim()) return;
    try {
      const n = await api.redisPublish(connectionId, pubChannel.trim(), pubMsg);
      toast(t("redisTools.published", { count: n }), "success");
      setPubMsg("");
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  return (
    <div className="console">
      <div className="toolbar" style={{ height: 40 }}>
        <Input mono small value={channels} placeholder={t("redisTools.channelsPlaceholder")} onChange={(e) => setChannels(e.target.value)} disabled={!!subId} onKeyDown={(e) => e.key === "Enter" && !subId && void start()} style={{ width: 320 }} />
        {subId ? (
          <Button size="sm" variant="danger" onClick={() => void stop()}>
            <Icon name="square" size={12} /> {t("redisTools.unsubscribe")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void start()} disabled={!channels.trim()}>
            <Icon name="play" size={12} /> {t("redisTools.subscribe")}
          </Button>
        )}
        {subId && <Badge tone="green">{t("redisTools.listening")}</Badge>}
        <span className="grow" />
        <ToolButton icon="trash" title={t("query.clearHistory")} onClick={() => setMessages([])} />
      </div>
      <div className="log" ref={logRef}>
        {messages.length === 0 && <div className="hint" style={{ padding: 0 }}>{subId ? t("redisTools.waiting") : t("redisTools.pubsubHint")}</div>}
        {messages.map((m, i) => (
          <div key={i}>
            <div className="cmd">
              {m.channel}
              {m.pattern && <span className="meta"> ({m.pattern})</span>}
              <span className="meta"> · {new Date(m.at).toLocaleTimeString()}</span>
            </div>
            <div className="reply">{m.payload}</div>
          </div>
        ))}
      </div>
      <div className="inputbar">
        <Input mono small value={pubChannel} placeholder={t("redisTools.channel")} onChange={(e) => setPubChannel(e.target.value)} style={{ width: 200 }} />
        <Input mono value={pubMsg} placeholder={t("redisTools.message")} onChange={(e) => setPubMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void publish()} />
        <Button size="sm" variant="secondary" onClick={() => void publish()} disabled={!pubChannel.trim()}>
          <Icon name="play" size={12} /> {t("redisTools.publish")}
        </Button>
      </div>
    </div>
  );
}
