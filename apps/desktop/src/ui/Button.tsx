import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-default";

const variants: Record<Variant, string> = {
  // Solid accent — primary actions (dark ink sits ON the light assigned accent)
  primary: "bg-primary text-on-primary hover:bg-primary-fixed-dim hover:shadow-lg hover:shadow-primary/20",
  // Transparent + outline — turns accent on hover
  secondary:
    "border border-outline-variant/40 text-on-surface hover:bg-surface-container-highest hover:text-primary",
  // No chrome until hovered
  ghost: "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface",
  // Danger — destructive
  danger: "bg-tertiary-container text-on-tertiary-container hover:bg-tertiary-container/90 hover:shadow-lg hover:shadow-tertiary-container/20",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-5 py-2.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, ...props }, ref) => (
    <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...props} />
  ),
);
Button.displayName = "Button";
