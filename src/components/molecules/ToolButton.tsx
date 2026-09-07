import Button from "@/components/atoms/Button";
import Icon, { type IconName } from "@/components/atoms/Icon";
import Spinner from "@/components/atoms/Spinner";

/**
 * Icon-only toolbar button with a tooltip (`title`) and an accent state for
 * toggles. Use it for every icon button in toolbars and headers so sizes,
 * radii and hover colours match.
 */
export default function ToolButton({
  icon,
  title,
  active = false,
  disabled,
  busy,
  danger,
  onClick,
  className = "",
}: {
  icon: IconName;
  title: string;
  active?: boolean;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <Button
      variant="bare"
      className={`tool-btn ${active ? "active" : ""} ${danger ? "danger" : ""} ${className}`.trim()}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? <Spinner /> : <Icon name={icon} size={14} />}
    </Button>
  );
}
