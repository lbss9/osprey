import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  small?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, small, className = "", ...rest }, ref) {
  const cls = ["input"];
  if (mono) cls.push("mono");
  if (small) cls.push("sm");
  if (className) cls.push(className);
  return <input ref={ref} className={cls.join(" ")} spellCheck={false} {...rest} />;
});

export default Input;
