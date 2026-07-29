import { type HTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * A surface panel — the primary container for grouped content.
 * Tonal layering: surface-container sits above the base background, with a
 * 1px hairline border and a soft shadow for depth.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-outline-variant/10 bg-surface-container p-6 shadow-lg shadow-black/20",
        className,
      )}
      {...props}
    />
  );
}
