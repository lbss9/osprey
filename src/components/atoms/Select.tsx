import type { SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  options: SelectOption[];
  small?: boolean;
  onChange: (value: string) => void;
}

export default function Select({ options, small, className = "", onChange, ...rest }: SelectProps) {
  const cls = ["select"];
  if (small) cls.push("sm");
  if (className) cls.push(className);
  return (
    <select className={cls.join(" ")} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
