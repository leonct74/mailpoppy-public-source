// Compose helper (Phase 3 / DESIGN §14): turn the user's Markdown into safe HTML
// for sending "well-formatted" mail, while still sending a plaintext fallback.
// We sanitize even our OWN rendered output (defense in depth — a user can paste
// raw HTML into the body), reusing the same DOMPurify config as the read pane.
import { marked } from "marked";
import { sanitizeHtml } from "./mailBody";

/** Render Markdown to sanitized HTML suitable for an outgoing message body. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? "", { async: false }) as string;
  // Outgoing = the user's own content, so remote images are allowed here.
  return sanitizeHtml(raw, { allowRemoteImages: true }).clean;
}
