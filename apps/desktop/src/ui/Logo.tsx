import iconUrl from "../assets/mailpoppy-icon.png";
import { cn } from "./cn";

/**
 * The MailPoppy brand lockup. The icon and the wordmark are deliberately
 * separate pieces (not one glued-together image): the "M" icon sits on its
 * own rounded tile, and "MailPoppy" is rendered as live text so it stays
 * crisp and legible on the dark theme — "Mail" in the foreground colour,
 * "Poppy" in the brand red.
 */
export function Logo({
  className,
  iconClassName,
  wordmarkClassName,
  showWordmark = true,
}: {
  className?: string;
  iconClassName?: string;
  wordmarkClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src={iconUrl}
        alt={showWordmark ? "" : "MailPoppy"}
        aria-hidden={showWordmark || undefined}
        className={cn("size-9 shrink-0 rounded-lg ring-1 ring-black/10", iconClassName)}
      />
      {showWordmark && (
        <span className={cn("text-lg font-bold leading-none tracking-tight", wordmarkClassName)}>
          <span className="text-on-surface">Mail</span>
          <span className="text-poppy">Poppy</span>
        </span>
      )}
    </div>
  );
}
