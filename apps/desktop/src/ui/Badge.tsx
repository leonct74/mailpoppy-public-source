import { type HTMLAttributes } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "brand";

// Status chips: low-opacity background of the status hue + solid text of that hue.
const tones: Record<Tone, string> = {
  neutral: "bg-surface-container-highest text-on-surface-variant border-outline-variant/40",
  success: "bg-secondary/10 text-secondary border-secondary/30",
  warning: "bg-warn/10 text-warn border-warn/30",
  danger: "bg-tertiary-container/15 text-tertiary border-tertiary/30",
  info: "bg-primary/10 text-primary border-primary/30",
  brand: "bg-primary/10 text-primary border-primary/30",
};

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold", tones[tone], className)}
      {...props}
    />
  );
}
