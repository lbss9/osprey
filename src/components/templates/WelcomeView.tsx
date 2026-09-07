import { useTranslation } from "react-i18next";
import Button from "@/components/atoms/Button";
import Icon from "@/components/atoms/Icon";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { driverLabel, relativeTime } from "@/utils/format";

const DRIVER_COLOR: Record<string, string> = { postgres: "var(--pg)", mysql: "var(--mysql)", redis: "var(--redis)", sqlite: "var(--sqlite)" };

/** Shown when no tab is open. */
export default function WelcomeView() {
  const { t } = useTranslation();
  const connections = useWorkspace((s) => s.connections);
  const connect = useWorkspace((s) => s.connect);
  const openConnectionDialog = useUi((s) => s.openConnectionDialog);
  const recent = [...connections].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, 6);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="hero">
          <span className="mark">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none">
              <path d="M12 4c-1.6 3-5 5-10 4.8 3 1.8 6.4 2.6 8.4 2.2L12 15l1.6-4c2 .4 5.4-.4 8.4-2.2C17 9 13.6 7 12 4z" fill="#6fd0f5" />
              <circle cx="12" cy="8" r="1.2" fill="#ffc766" />
            </svg>
          </span>
          <div>
            <h1>{t("welcome.title")}</h1>
            <p className="sub" style={{ margin: 0 }}>
              {t("welcome.subtitle")}
            </p>
          </div>
        </div>
        <div className="grid2">
          <div className="box">
            <h3>{t("welcome.recent")}</h3>
            {recent.length === 0 && <div className="tree-empty" style={{ padding: "4px 0 10px" }}>{t("sidebar.empty")}</div>}
            {recent.map((c) => (
              <Button key={c.id} variant="bare" className="recent" onClick={() => void connect(c.id)}>
                <span className="dot" style={{ background: c.color || DRIVER_COLOR[c.driver] }} />
                <span>{c.name}</span>
                <span className="meta">
                  {driverLabel(c.driver)}
                  {c.lastUsedAt ? ` · ${relativeTime(c.lastUsedAt)}` : ""}
                </span>
              </Button>
            ))}
            <Button variant="primary" size="md" style={{ marginTop: 10 }} onClick={() => openConnectionDialog(null)}>
              <Icon name="plus" size={14} /> {t("welcome.newConnection")}
            </Button>
          </div>
          <div className="box">
            <h3>{t("welcome.tips")}</h3>
            <ul>
              <li>{t("welcome.tip1")}</li>
              <li>{t("welcome.tip2")}</li>
              <li>{t("welcome.tip3")}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
