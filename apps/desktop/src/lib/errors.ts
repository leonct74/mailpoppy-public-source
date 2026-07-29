// Turn an error (usually thrown by the sidecar client) into a short, calm,
// user-facing sentence. The sidecar() helper throws `sidecar <status>: <body>`,
// where <body> is normally JSON. Two shapes exist: the sidecar's GLOBAL error
// handler returns {ok:false, error:<err.name>, message:<human text>} — the readable
// description is in `message`, with only the error *name* (e.g. "Error") in `error`
// — while explicit route catches return {ok:false, error:<human text>} with the
// message directly in `error`. We surface the human text, never the raw envelope,
// a bare HTTP status, or a useless "Error". Network/helper failures are already
// friendly (see sidecar.ts) and pass through unchanged.
export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!raw) return fallback;

  const m = raw.match(/^sidecar (\d{3}): ([\s\S]*)$/);
  if (!m) return raw; // already-friendly (network/helper text) or a plain message

  const [, status, body = ""] = m;
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: unknown; message?: unknown };
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    // Prefer `message` (the global handler's human text); fall back to `error`
    // (explicit catches). This is what stops a bare "Error" reaching the user.
    detail = pick(parsed.message) || pick(parsed.error) || detail;
  } catch {
    /* body wasn't JSON — keep the text */
  }

  if (detail) return detail;
  if (status === "404") return "That isn't available.";
  if (status === "403") return "You don't have permission to do that.";
  return fallback;
}
