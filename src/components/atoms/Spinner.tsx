export default function Spinner({ size = "sm", className = "" }: { size?: "sm" | "lg"; className?: string }) {
  return <span className={`spinner ${size === "lg" ? "lg" : ""} ${className}`} aria-hidden />;
}
