import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import ConnChip from "@/components/molecules/ConnChip";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import type { Tab } from "@/types";

interface Entry {
  cmd: string;
  reply?: string;
  error?: string;
  ms?: number;
}

/** Redis console: one command per line, JSON replies. */
export default function ConsoleView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const [log, setLog] = useState<Entry[]>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const logRef = useRef<HTMLDivElement>(null);
  const history = log.map((e) => e.cmd);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const run = async () => {
    const cmd = line.trim();
    if (!cmd || busy) return;
    setBusy(true);
    setLine("");
    setHistIdx(-1);
    try {
      const res = await api.redisCommand(tab.connectionId, cmd);
      setLog((l) => [...l, { cmd, reply: JSON.stringify(res.reply, null, 2), ms: res.elapsedMs }]);
    } catch (e) {
      setLog((l) => [...l, { cmd, error: translateError(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const i = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setLine(history[i]);
    } else if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx + 1;
      if (i >= history.length) {
        setHistIdx(-1);
        setLine("");
      } else {
        setHistIdx(i);
        setLine(history[i]);
      }
    }
  };

  return (
    <div className="console">
      <div className="toolbar">
        <div className="crumb">
          <Icon name="terminal" size={14} style={{ color: "var(--accent)" }} />
          <b>{t("redis.console")}</b>
        </div>
        <ConnChip connectionId={tab.connectionId} />
        <span className="grow" />
        <Button size="sm" onClick={() => setLog([])} title={t("query.clearHistory")}>
          <Icon name="trash" size={14} />
        </Button>
      </div>
      <div className="log" ref={logRef}>
        {log.length === 0 && <div className="hint" style={{ padding: 0 }}>{t("redis.consoleHint")}</div>}
        {log.map((e, i) => (
          <div key={i}>
            <div className="cmd">{e.cmd}</div>
            <div className={`reply ${e.error ? "err" : ""}`}>{e.error ?? e.reply}</div>
            {e.ms != null && <div className="meta">{e.ms} ms</div>}
          </div>
        ))}
      </div>
      <div className="inputbar">
        <span style={{ color: "var(--text-faint)", fontFamily: "var(--mono)" }}>›</span>
        <Input mono value={line} placeholder={t("redis.consolePlaceholder")} onChange={(e) => setLine(e.target.value)} onKeyDown={onKey} autoFocus disabled={busy} />
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={busy || !line.trim()}>
          <Icon name="play" size={12} /> {t("common.run")}
        </Button>
      </div>
    </div>
  );
}
