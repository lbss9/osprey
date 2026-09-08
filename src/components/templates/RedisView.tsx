import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Badge from "@/components/atoms/Badge";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import Input from "@/components/atoms/Input";
import Dropdown from "@/components/molecules/Dropdown";
import ToolButton from "@/components/molecules/ToolButton";
import Spinner from "@/components/atoms/Spinner";
import { useContextMenu } from "@/components/molecules/ContextMenu";
import DataGrid from "@/components/organisms/DataGrid";
import { useUi } from "@/store/ui";
import { connectionIdOf } from "@/utils/session";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { confirmDialog } from "@/utils/dialog";
import { cellText, formatNumber, formatTtl } from "@/utils/format";
import type { Cell, EditValue, RedisKeyInfo, RedisMutation, RedisValue, ResultColumn, Tab } from "@/types";

const TYPES = ["", "string", "hash", "list", "set", "zset", "stream"];

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  keys: RedisKeyInfo[];
  count: number;
}

function buildTree(keys: RedisKeyInfo[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), keys: [], count: 0 };
  for (const k of keys) {
    const parts = k.key.split(":");
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join(":");
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, children: new Map(), keys: [], count: 0 };
        node.children.set(name, child);
      }
      node = child;
      node.count++;
    }
    node.keys.push(k);
  }
  return root;
}

/** Redis browser: SCAN-based key list on the left, typed value editor on the right. */
export default function RedisView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const conn = useWorkspace((s) => s.connections.find((c) => c.id === connectionIdOf(tab.connectionId)));
  const toast = useWorkspace((s) => s.toast);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const tree = useUi((s) => s.redisTree);
  const setUi = useUi((s) => s.set);

  const [pattern, setPattern] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
  const [cursor, setCursor] = useState(0);
  const [done, setDone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listWidth] = useState(320);
  const { open: openMenu } = useContextMenu();

  const scan = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      try {
        const res = await api.redisScan(tab.connectionId, {
          cursor: reset ? 0 : cursor,
          pattern: pattern.trim() || "*",
          count: 300,
          typeFilter: typeFilter || undefined,
        });
        setKeys((prev) => (reset ? res.keys : [...prev, ...res.keys]));
        setCursor(res.cursor);
        setDone(res.done);
      } catch (e) {
        toast(translateError(e), "error");
      } finally {
        setLoading(false);
      }
    },
    [tab.connectionId, cursor, pattern, typeFilter, toast],
  );

  useEffect(() => {
    void scan(true);
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId]);

  useEffect(() => {
    const onRefresh = () => activeTabId === tab.id && void scan(true);
    window.addEventListener("osprey-refresh", onRefresh);
    return () => window.removeEventListener("osprey-refresh", onRefresh);
  }, [activeTabId, tab.id, scan]);

  const root = useMemo(() => buildTree(keys), [keys]);

  const deleteKeys = async (list: string[]) => {
    const ok = await confirmDialog(list.length === 1 ? t("redis.deleteConfirm", { key: list[0] }) : t("redis.deleteMany", { count: list.length }));
    if (!ok) return;
    try {
      await api.redisMutate(tab.connectionId, { kind: "delete", keys: list });
      setKeys((prev) => prev.filter((k) => !list.includes(k.key)));
      if (selected && list.includes(selected)) setSelected(null);
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  const keyContext = (e: React.MouseEvent, k: RedisKeyInfo) =>
    openMenu(e, [
      { label: t("sidebar.copyName"), icon: "copy", onSelect: () => void copyText(k.key) },
      { separator: true },
      { label: t("redis.deleteKey"), icon: "trash", danger: true, onSelect: () => void deleteKeys([k.key]) },
    ]);

  const renderKey = (k: RedisKeyInfo, depth: number, label?: string) => (
    <div
      key={k.key}
      className={`key-row ${selected === k.key ? "active" : ""}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => setSelected(k.key)}
      onContextMenu={(e) => keyContext(e, k)}
      title={k.key}
    >
      <span className={`kt ${k.kind}`}>{k.kind === "string" ? "str" : k.kind}</span>
      <span className="label">{label ?? k.key}</span>
      {k.ttl >= 0 && <span className="ttl">{formatTtl(k.ttl)}</span>}
    </div>
  );

  const renderNode = (node: TreeNode, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      const open = expanded.has(f.path);
      out.push(
        <div
          key={`f:${f.path}`}
          className="key-row folder"
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() =>
            setExpanded((s) => {
              const n = new Set(s);
              if (n.has(f.path)) n.delete(f.path);
              else n.add(f.path);
              return n;
            })
          }
          onContextMenu={(e) =>
            openMenu(e, [
              { label: `${t("common.delete")} ${f.path}:* (${f.count})`, icon: "trash", danger: true, onSelect: () => void deleteKeys(collect(f)) },
            ])
          }
        >
          <Icon name="chevronRight" size={13} className={`chev ${open ? "open" : ""}`} style={{ transform: open ? "rotate(90deg)" : undefined, color: "var(--text-faint)" }} />
          <Icon name="folder" size={14} style={{ color: "var(--amber)" }} />
          <span className="label">{f.name}</span>
          <span className="cnt">{f.count}</span>
        </div>,
      );
      if (open) out.push(...renderNode(f, depth + 1));
    }
    for (const k of node.keys.sort((a, b) => a.key.localeCompare(b.key))) {
      out.push(renderKey(k, depth, k.key.slice(node.path ? node.path.length + 1 : 0)));
    }
    return out;
  };

  const collect = (n: TreeNode): string[] => [...n.keys.map((k) => k.key), ...[...n.children.values()].flatMap(collect)];

  return (
    <div className="redis-view">
      <div className="redis-keys" style={{ width: listWidth }}>
        <div className="search">
          <Input
            mono
            value={pattern}
            placeholder={t("redis.pattern")}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void scan(true)}
          />
          <Dropdown size="sm" className="type-dd" value={typeFilter} options={TYPES.map((ty) => ({ value: ty, label: ty || t("redis.allTypes") }))} onChange={(v) => setTypeFilter(v)} ariaLabel={t("common.type")} />
          <ToolButton icon="search" title={t("redis.scan")} onClick={() => void scan(true)} busy={loading} className="scan-btn" />
        </div>
        <div className="list">
          {keys.length === 0 && !loading && <div className="tree-empty">{t("redis.noKeys")}</div>}
          {tree ? renderNode(root, 0) : keys.map((k) => renderKey(k, 0))}
        </div>
        <div className="foot">
          <span>{t("redis.loaded", { count: formatNumber(keys.length) })}</span>
          <span className="grow" />
          <ToolButton icon={tree ? "tree" : "list"} active={tree} title={tree ? t("redis.list") : t("redis.tree")} onClick={() => setUi({ redisTree: !tree })} />
          {!done && (
            <Button size="sm" variant="secondary" onClick={() => void scan(false)} disabled={loading}>
              {loading ? <Spinner /> : <Icon name="arrowDown" size={12} />} {t("redis.loadMore")}
            </Button>
          )}
        </div>
      </div>
      <div className="redis-value">
        {selected ? (
          <KeyPanel
            key={selected}
            connectionId={tab.connectionId}
            keyName={selected}
            readOnly={!!conn?.readOnly}
            onDeleted={() => {
              setKeys((prev) => prev.filter((k) => k.key !== selected));
              setSelected(null);
            }}
            onRenamed={(name) => {
              setKeys((prev) => prev.map((k) => (k.key === selected ? { ...k, key: name } : k)));
              setSelected(name);
            }}
            onTtl={(ttl) => setKeys((prev) => prev.map((k) => (k.key === selected ? { ...k, ttl } : k)))}
          />
        ) : (
          <div className="redis-empty">{t("redis.selectKey")}</div>
        )}
      </div>
    </div>
  );
}

/* ================================ key panel ================================ */

function KeyPanel({
  connectionId,
  keyName,
  readOnly,
  onDeleted,
  onRenamed,
  onTtl,
}: {
  connectionId: string;
  keyName: string;
  readOnly: boolean;
  onDeleted: () => void;
  onRenamed: (name: string) => void;
  onTtl: (ttl: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const [value, setValue] = useState<RedisValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api.redisValue(connectionId, { key: keyName, count: 500 });
      setValue(v);
      setError(null);
      if (v.kind === "string" || v.kind === "ReJSON-RL") setText(v.entries[0]?.value ?? "");
    } catch (e) {
      setError(translateError(e));
    }
  }, [connectionId, keyName]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (m: RedisMutation, reload = true) => {
    if (readOnly) {
      toast(t("errors.readOnly"), "error");
      return;
    }
    setBusy(true);
    try {
      await api.redisMutate(connectionId, m);
      if (reload) await load();
    } catch (e) {
      toast(translateError(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const setTtl = async () => {
    const s = window.prompt(t("redis.setTtl"), value && value.ttl > 0 ? String(value.ttl) : "");
    if (s === null) return;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      await mutate({ kind: "persist", key: keyName });
      onTtl(-1);
    } else {
      await mutate({ kind: "expire", key: keyName, seconds: Math.floor(n) });
      onTtl(Math.floor(n));
    }
  };
  const rename = async () => {
    const s = window.prompt(t("redis.renamePrompt"), keyName);
    if (!s || s === keyName) return;
    await mutate({ kind: "rename", key: keyName, newKey: s }, false);
    onRenamed(s);
  };
  const del = async () => {
    if (!(await confirmDialog(t("redis.deleteConfirm", { key: keyName })))) return;
    await mutate({ kind: "delete", keys: [keyName] }, false);
    onDeleted();
  };

  if (error) {
    return (
      <div className="messages">
        <span className="err">{error}</span>
      </div>
    );
  }
  if (!value) {
    return (
      <div className="redis-empty">
        <Spinner size="lg" />
      </div>
    );
  }

  /* ------------------------------ typed bodies ------------------------------ */
  const kind = value.kind;
  let columns: ResultColumn[] = [];
  let rows: Cell[][] = [];
  let onEdit: ((r: number, c: number, v: EditValue) => void) | undefined;
  let onDelete: ((rows: number[]) => void) | undefined;
  let addForm: React.ReactNode = null;
  const str = (v: EditValue) => (typeof v === "object" && v !== null ? "" : cellText(v));

  if (kind === "hash") {
    columns = [
      { name: t("redis.field"), dataType: "field", kind: "string" },
      { name: t("common.value"), dataType: "value", kind: "string" },
    ];
    rows = value.entries.map((e) => [e.field ?? "", e.value]);
    onEdit = (r, c, v) => {
      const e = value.entries[r];
      if (c === 1) void mutate({ kind: "hashSet", key: keyName, field: e.field ?? "", value: str(v) });
      else if (str(v) && str(v) !== e.field) {
        void (async () => {
          await mutate({ kind: "hashDel", key: keyName, field: e.field ?? "" }, false);
          await mutate({ kind: "hashSet", key: keyName, field: str(v), value: e.value });
        })();
      }
    };
    onDelete = (rs) => rs.forEach((r) => void mutate({ kind: "hashDel", key: keyName, field: value.entries[r].field ?? "" }));
    addForm = (
      <div className="kv-addrow">
        <Input mono value={addA} placeholder={t("redis.field")} onChange={(e) => setAddA(e.target.value)} />
        <Input mono value={addB} placeholder={t("common.value")} onChange={(e) => setAddB(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={!addA || busy} onClick={() => void mutate({ kind: "hashSet", key: keyName, field: addA, value: addB }).then(() => { setAddA(""); setAddB(""); })}>
          <Icon name="plus" size={13} /> {t("redis.addField")}
        </Button>
      </div>
    );
  } else if (kind === "list") {
    columns = [
      { name: t("redis.index"), dataType: "index", kind: "number" },
      { name: t("common.value"), dataType: "value", kind: "string" },
    ];
    rows = value.entries.map((e) => [Number(e.field), e.value]);
    onEdit = (r, c, v) => c === 1 && void mutate({ kind: "listSet", key: keyName, index: Number(value.entries[r].field), value: str(v) });
    onDelete = (rs) => rs.forEach((r) => void mutate({ kind: "listRem", key: keyName, value: value.entries[r].value }));
    addForm = (
      <div className="kv-addrow">
        <Input mono value={addA} placeholder={t("common.value")} onChange={(e) => setAddA(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={!addA || busy} onClick={() => void mutate({ kind: "listPush", key: keyName, value: addA, head: true }).then(() => setAddA(""))}>
          {t("redis.pushHead")}
        </Button>
        <Button size="sm" variant="secondary" disabled={!addA || busy} onClick={() => void mutate({ kind: "listPush", key: keyName, value: addA, head: false }).then(() => setAddA(""))}>
          {t("redis.pushTail")}
        </Button>
      </div>
    );
  } else if (kind === "set") {
    columns = [{ name: t("redis.member"), dataType: "member", kind: "string" }];
    rows = value.entries.map((e) => [e.value]);
    onEdit = (r, _c, v) => {
      const old = value.entries[r].value;
      if (str(v) && str(v) !== old)
        void (async () => {
          await mutate({ kind: "setRem", key: keyName, member: old }, false);
          await mutate({ kind: "setAdd", key: keyName, member: str(v) });
        })();
    };
    onDelete = (rs) => rs.forEach((r) => void mutate({ kind: "setRem", key: keyName, member: value.entries[r].value }));
    addForm = (
      <div className="kv-addrow">
        <Input mono value={addA} placeholder={t("redis.member")} onChange={(e) => setAddA(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={!addA || busy} onClick={() => void mutate({ kind: "setAdd", key: keyName, member: addA }).then(() => setAddA(""))}>
          <Icon name="plus" size={13} /> {t("redis.addMember")}
        </Button>
      </div>
    );
  } else if (kind === "zset") {
    columns = [
      { name: t("redis.member"), dataType: "member", kind: "string" },
      { name: t("redis.score"), dataType: "score", kind: "number" },
    ];
    rows = value.entries.map((e) => [e.value, e.score ?? 0]);
    onEdit = (r, c, v) => {
      const e = value.entries[r];
      if (c === 1) void mutate({ kind: "zAdd", key: keyName, member: e.value, score: Number(str(v)) || 0 });
      else if (str(v) && str(v) !== e.value)
        void (async () => {
          await mutate({ kind: "zRem", key: keyName, member: e.value }, false);
          await mutate({ kind: "zAdd", key: keyName, member: str(v), score: e.score ?? 0 });
        })();
    };
    onDelete = (rs) => rs.forEach((r) => void mutate({ kind: "zRem", key: keyName, member: value.entries[r].value }));
    addForm = (
      <div className="kv-addrow">
        <Input mono value={addA} placeholder={t("redis.member")} onChange={(e) => setAddA(e.target.value)} />
        <Input mono value={addB} placeholder={t("redis.score")} type="number" style={{ width: 120 }} onChange={(e) => setAddB(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={!addA || busy} onClick={() => void mutate({ kind: "zAdd", key: keyName, member: addA, score: Number(addB) || 0 }).then(() => { setAddA(""); setAddB(""); })}>
          <Icon name="plus" size={13} /> {t("redis.addMember")}
        </Button>
      </div>
    );
  } else if (kind === "stream") {
    columns = [
      { name: t("redis.id"), dataType: "id", kind: "string" },
      { name: t("common.value"), dataType: "json", kind: "json" },
    ];
    rows = value.entries.map((e) => [e.field ?? "", e.value]);
  }

  const isString = kind === "string" || kind === "ReJSON-RL";

  return (
    <>
      <div className="kv-head">
        <Badge tone="accent">{kind}</Badge>
        <span className="keyname" title={keyName}>
          {keyName}
        </span>
        <Badge title={t("redis.ttl")}>{value.ttl < 0 ? t("redis.noExpiry") : t("redis.expiresIn", { time: formatTtl(value.ttl) })}</Badge>
        {!isString && <Badge>{t("redis.entries", { count: formatNumber(value.total) })}</Badge>}
        <ToolButton icon="refresh" title={t("common.refresh")} onClick={() => void load()} />
        <ToolButton icon="copy" title={t("sidebar.copyName")} onClick={() => void copyText(keyName)} />
        {!readOnly && (
          <>
            <ToolButton icon="history" title={t("redis.setTtl")} onClick={() => void setTtl()} />
            <ToolButton icon="pencil" title={t("redis.rename")} onClick={() => void rename()} />
            <ToolButton icon="trash" title={t("redis.deleteKey")} danger onClick={() => void del()} />
          </>
        )}
      </div>
      <div className="kv-body">
        {isString ? (
          <div className="kv-string">
            <textarea className="textarea mono" value={text} onChange={(e) => setText(e.target.value)} readOnly={readOnly} spellCheck={false} />
            <div className="bar">
              <span style={{ color: "var(--text-faint)", fontSize: "0.88em" }}>{formatNumber(value.total)} bytes{value.truncated ? " (truncated)" : ""}</span>
              <span style={{ flex: 1 }} />
              {!readOnly && kind === "string" && (
                <Button size="sm" variant="primary" disabled={busy || text === (value.entries[0]?.value ?? "")} onClick={() => void mutate({ kind: "setString", key: keyName, value: text })}>
                  <Icon name="save" size={13} /> {t("redis.saveValue")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <DataGrid columns={columns} rows={rows} editable={!readOnly && !!onEdit} onEdit={onEdit} onDeleteRows={onDelete} emptyText={t("grid.empty")} />
            {!readOnly && addForm}
          </>
        )}
      </div>
    </>
  );
}
