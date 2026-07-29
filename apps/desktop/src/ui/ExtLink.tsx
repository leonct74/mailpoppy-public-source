import { type ReactNode, type MouseEvent } from "react";
import { openExternal } from "../lib/openExternal";

/**
 * An external link that actually opens in the user's browser from inside the
 * Tauri webview. A plain <a target="_blank"> is a no-op there, so we intercept
 * the click and hand the URL to the OS via openExternal. The real href is kept,
 * so right-click → "Copy link" still works and it degrades gracefully in a plain
 * browser / tests.
 */
export function ExtLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    void openExternal(href);
  }
  return (
    <a href={href} onClick={onClick} className={className} rel="noreferrer">
      {children}
    </a>
  );
}
