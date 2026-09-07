import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder as cmPlaceholder,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { sql, PostgreSQL, MySQL, MSSQL, type SQLNamespace } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import type { DriverKind } from "@/types";

export interface SqlEditorHandle {
  getText(): string;
  getSelection(): string;
  setText(text: string): void;
  insert(text: string): void;
  focus(): void;
}

export interface SqlEditorProps {
  value: string;
  onChange: (text: string) => void;
  onRun: () => void;
  driver: DriverKind;
  /** schema → tables (→ columns) for autocompletion */
  schema?: SQLNamespace;
  defaultSchema?: string;
  placeholder?: string;
}

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "tok-kw" },
  { tag: [tags.string, tags.special(tags.string)], class: "tok-str" },
  { tag: [tags.number, tags.integer, tags.float], class: "tok-num" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "tok-cmt" },
  { tag: [tags.operator, tags.compareOperator, tags.logicOperator], class: "tok-op" },
  { tag: tags.typeName, class: "tok-type" },
  { tag: [tags.function(tags.variableName), tags.function(tags.name)], class: "tok-fn" },
  { tag: [tags.name, tags.variableName, tags.propertyName], class: "tok-name" },
  { tag: tags.bool, class: "tok-bool" },
  { tag: [tags.punctuation, tags.paren, tags.bracket, tags.separator], class: "tok-punct" },
]);

/**
 * CodeMirror 6 wrapper. The document lives in CodeMirror; `value` only seeds
 * it and is re-applied when it changes externally (history restore, etc.).
 */
const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const onRun = useRef(p.onRun);
  const onChange = useRef(p.onChange);
  onRun.current = p.onRun;
  onChange.current = p.onChange;

  const langExt = () =>
    sql({
      dialect: p.driver === "mysql" || p.driver === "clickhouse" ? MySQL : p.driver === "mssql" ? MSSQL : PostgreSQL,
      schema: p.schema,
      defaultSchema: p.defaultSchema,
      upperCaseKeywords: true,
    });

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: p.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
        highlightActiveLine(),
        syntaxHighlighting(highlight),
        langCompartment.current.of(langExt()),
        cmPlaceholder(p.placeholder ?? ""),
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: () => (onRun.current(), true) },
            { key: "F5", run: () => (onRun.current(), true) },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange.current(u.state.doc.toString());
        }),
        EditorView.lineWrapping,
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // mount once; language/schema updates go through the compartment below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: langCompartment.current.reconfigure(langExt()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.driver, p.schema, p.defaultSchema]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== p.value) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: p.value } });
    }
  }, [p.value]);

  useImperativeHandle(ref, () => ({
    getText: () => view.current?.state.doc.toString() ?? "",
    getSelection: () => {
      const v = view.current;
      if (!v) return "";
      const { from, to } = v.state.selection.main;
      return from === to ? "" : v.state.sliceDoc(from, to);
    },
    setText: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
    focus: () => view.current?.focus(),
  }));

  return <div className="editor-wrap" ref={host} style={{ flex: 1, minHeight: 0 }} />;
});

export default SqlEditor;
