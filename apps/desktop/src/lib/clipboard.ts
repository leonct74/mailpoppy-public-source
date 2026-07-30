/**
 * Copy text to the clipboard, robust to contexts where the async Clipboard API is
 * blocked — e.g. inside a host iframe that doesn't delegate `clipboard-write`, or a
 * non-secure origin. Falls back to the legacy execCommand path, which only needs a
 * user gesture (the button click) and no Permissions-Policy grant.
 *
 * Lives here rather than in a view because MailPoppy runs as an AgentsPoppy extension
 * inside the host's webview, so EVERY copy affordance needs the fallback — a copy button
 * that silently fails is a dead button (AGENTS.md §9).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
