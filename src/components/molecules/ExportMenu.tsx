import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import ContextMenu from "@/components/molecules/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useWorkspace } from "@/store/workspace";
import * as api from "@/services/tauri";
import { translateError } from "@/i18n";
import { copyText } from "@/utils/clipboard";
import { saveDialog } from "@/utils/dialog";
import { rowsToTsv } from "@/utils/format";
import type { Cell, ResultColumn } from "@/types";

/** Export button + menu: CSV / JSON / SQL to a file, or TSV to clipboard. */
export default function ExportMenu({
  columns,
  rows,
  baseName,
  table,
  disabled,
}: {
  columns: ResultColumn[];
  rows: Cell[][];
  baseName: string;
  table?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useWorkspace((s) => s.toast);
  const ctx = useContextMenu();

  const exportTo = async (format: "csv" | "json" | "sql") => {
    const path = await saveDialog(`${baseName}.${format}`, format, format.toUpperCase());
    if (!path) return;
    try {
      const n = await api.exportRows({ path, format, columns: columns.map((c) => c.name), rows, table });
      toast(t("toast.exported", { count: n }), "success");
    } catch (e) {
      toast(translateError(e), "error");
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || rows.length === 0}
        onClick={(e) =>
          ctx.open(e, [
            { label: t("export.csv"), icon: "download", action: () => void exportTo("csv") },
            { label: t("export.json"), icon: "download", action: () => void exportTo("json") },
            { label: t("export.sql"), icon: "download", action: () => void exportTo("sql") },
            { sep: true },
            {
              label: t("export.copyTsv"),
              icon: "copy",
              action: async () => {
                await copyText(rowsToTsv(columns, rows));
                toast(t("toast.copied"), "success");
              },
            },
          ])
        }
        title={t("export.title")}
      >
        <Icon name="download" size={14} /> {t("export.title")}
      </Button>
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </>
  );
}
