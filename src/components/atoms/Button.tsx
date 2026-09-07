import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "bare";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  active?: boolean;
}

/**
 * Every button in the app. `bare` emits only the reset so a caller's own
 * class can own the full look.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", icon, active, className = "", type = "button", ...rest },
  ref,
) {
  const cls = ["btn"];
  if (variant !== "bare") {
    cls.push(`btn-${size}`, `btn-${variant}`);
    if (icon) cls.push("btn-icon");
  }
  if (active) cls.push("is-active");
  if (className) cls.push(className);
  return <button ref={ref} type={type} className={cls.join(" ")} {...rest} />;
});

export default Button;
