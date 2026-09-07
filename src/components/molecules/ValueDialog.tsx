import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { tags } from "@lezer/highlight";
import Button from "@/components/atoms/Button";
import Tab from "@/components/atoms/Tab";
import ToolButton from "@/components/molecules/ToolButton";
import { copyText } from "@/utils/clipboard";
import { looksLikeJson, prettyJson } from "@/utils/format";

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, class: "tok-kw" },
  { tag: tags.string, class: "tok-str" },
  { tag: [tags.number, tags.integer, tags.float], class: "tok-num" },
  { tag: [tags.bool, tags.null], class: "tok-bool" },
  { tag: [tags.punctuation, tags.brace, tags.bracket], class: "tok-punct" },
]);

/**
 * Full-size viewer/editor for one cell or Redis value. JSON gets a real
 * editor (folding, highlighting, pretty/raw); anything else a plain one.
 */
export default function ValueDialog({
  title,
  value,
  editable,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  editable?: boolean;
  onSave?: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isJson = looksLikeJson(value);
  const [pretty, setPretty] = useState(isJson);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: pretty && isJson ? prettyJson(value) : value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(highlight),
        ...(isJson ? [json()] : []),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(!!editable),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // rebuild when the pretty toggle changes; the doc is re-derived from `value`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pretty]);

  const text = () => view.current?.state.doc.toString() ?? value;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h2 className="mono" style={{ fontSize: "1em" }}>
            {title}
          </h2>
          {isJson && (
            <div className="pill-tabs">
              <Tab active={!pretty} onClick={() => setPretty(false)}>
                {t("redis.raw")}
              </Tab>
              <Tab active={pretty} onClick={() => setPretty(true)}>
                {t("redis.prettyJson")}
              </Tab>
            </div>
          )}
          <ToolButton icon="copy" title={t("common.copy")} onClick={() => void copyText(text())} />
          <ToolButton icon="x" title={t("common.close")} onClick={onClose} />
        </div>
        <div className="dialog-body value-viewer">
          <div className="editor-wrap value-editor" ref={host} />
        </div>
        {editable && (
          <div className="dialog-foot">
            <span className="grow" />
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => onSave?.(text())}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
