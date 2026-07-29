// Deployment-wide outbound-mail settings the admin can tune. Today this is just
// the maximum attachment size; it lives in the SETTINGS table under a single
// global key (not per-domain) so "change the limit" is one knob in the admin app.
import { SES_MAX_MESSAGE_BYTES } from "./types";

/**
 * Default cap when the admin hasn't set one. 15 MB raw ≈ 20 MB once base64'd into
 * the MIME — comfortably inside SES's 40 MB ceiling, and still deliverable to the
 * providers most recipients use (Gmail rejects over ~25 MB encoded, Outlook.com
 * over ~20 MB). Going much higher mostly buys bounces at the far end rather than
 * working mail, which is why this stops at 15 rather than matching SES's 40.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Smallest cap the admin can choose (keeps the field from being set to ~0). */
export const MIN_MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;
/**
 * Largest cap the admin can choose. SES refuses anything over 40 MB total
 * message size, so that's the hard ceiling regardless of upload path.
 */
export const MAX_MAX_ATTACHMENT_BYTES = SES_MAX_MESSAGE_BYTES;

export interface SendSettings {
  /** Max total raw attachment bytes allowed on a single outgoing message. */
  maxAttachmentBytes: number;
}

/** The single SETTINGS-table key holding the deployment's send settings. */
export function sendSettingsKey(): string {
  return "settings#send";
}

/**
 * Coerce stored / user-supplied settings into a valid SendSettings, applying the
 * default and clamping to [MIN, MAX]. Anything missing or nonsensical falls back
 * to the 15 MB default — callers never have to defend against bad values.
 */
export function normalizeSendSettings(
  input: Partial<SendSettings> | null | undefined,
): SendSettings {
  const raw = Number(input?.maxAttachmentBytes);
  const v = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_MAX_ATTACHMENT_BYTES;
  return {
    maxAttachmentBytes: Math.min(MAX_MAX_ATTACHMENT_BYTES, Math.max(MIN_MAX_ATTACHMENT_BYTES, v)),
  };
}
