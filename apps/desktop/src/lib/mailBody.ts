// Safe rendering of a received message body (DESIGN §14, CLAUDE.md Security).
// Two concerns, both security-critical for a mail client:
//   1. Parse the raw .eml into its HTML/text parts (postal-mime — browser- and
//      React-Native-friendly, unlike the Node-only mailparser used in the Lambda).
//   2. Sanitize the HTML before it ever touches the DOM (DOMPurify): strip
//      scripts/handlers/embeds, harden links, and BLOCK remote images/trackers by
//      default so opening a message can't phone home (read receipts / pixel beacons).
import DOMPurify from "dompurify";
import PostalMime from "postal-mime";

export interface ParsedBody {
  html?: string;
  text?: string;
  subject?: string;
}

export async function parseBody(eml: string): Promise<ParsedBody> {
  const email = await PostalMime.parse(eml);
  return {
    html: email.html || undefined,
    text: email.text || undefined,
    subject: email.subject || undefined,
  };
}

export interface SanitizeResult {
  clean: string;
  /** true if at least one remote resource (image/tracker) was stripped. */
  blockedRemote: boolean;
}

const REMOTE_ATTRS = new Set(["src", "srcset", "background", "poster"]);
const isRemote = (v: string) => /^https?:/i.test(v) || v.startsWith("//");

/**
 * Sanitize untrusted email HTML for display. With allowRemoteImages=false
 * (the default for unread/just-opened mail), remote image/media URLs and CSS
 * url(...) references are neutralized so the message can't beacon back.
 */
export function sanitizeHtml(html: string, opts: { allowRemoteImages: boolean }): SanitizeResult {
  let blockedRemote = false;

  if (!opts.allowRemoteImages) {
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
      const value = data.attrValue ?? "";
      if (REMOTE_ATTRS.has(data.attrName) && isRemote(value)) {
        data.keepAttr = false;
        blockedRemote = true;
      } else if (data.attrName === "style" && /url\s*\(/i.test(value)) {
        data.attrValue = value.replace(/url\s*\([^)]*\)/gi, "none");
        blockedRemote = true;
      }
    });
  }

  // Open links in the user's browser, never leak the referrer.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof Element && node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });

  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "link", "meta", "base"],
    ADD_ATTR: ["target"],
  });

  DOMPurify.removeAllHooks();
  return { clean, blockedRemote };
}
