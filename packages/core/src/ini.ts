// Minimal INI section upsert — used to write an AWS credentials profile
// (`~/.aws/credentials`) from the in-app "paste your keys" onboarding without a
// dependency, and **without ever clobbering the user's other profiles**. We only
// ever touch the one named section; everything else in the file is preserved
// byte-for-byte. Pure + unit-tested precisely because a bug here could corrupt a
// user's real credentials file.

const sectionHeader = (name: string): RegExp => new RegExp(`^\\s*\\[\\s*${escapeRegExp(name)}\\s*\\]\\s*$`);
const anyHeader = /^\s*\[.+\]\s*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert or replace one `[section]` in INI `content`, preserving every other
 * section and the file's surrounding text. If the section exists, its body is
 * replaced with `lines`; otherwise the section is appended. The result always
 * ends with a single trailing newline.
 *
 * @param content existing file text ("" for a new file)
 * @param section section name WITHOUT brackets (e.g. "mailpoppy")
 * @param lines   the section's body lines (e.g. ["aws_access_key_id = AKIA…"])
 */
export function upsertIniSection(content: string, section: string, lines: string[]): string {
  const block = [`[${section}]`, ...lines];
  const src = content.replace(/\r\n/g, "\n");
  const rows = src.length ? src.split("\n") : [];

  const headerRe = sectionHeader(section);
  const start = rows.findIndex((l) => headerRe.test(l));

  if (start === -1) {
    // Append. Trim trailing blank lines, then separate with one blank line.
    const trimmed = [...rows];
    while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
    const prefix = trimmed.length ? [...trimmed, ""] : [];
    return [...prefix, ...block].join("\n") + "\n";
  }

  // Replace from the header line up to (but not including) the next section
  // header, or end of file.
  let end = start + 1;
  while (end < rows.length && !anyHeader.test(rows[end]!)) end += 1;
  const next = [...rows.slice(0, start), ...block, ...rows.slice(end)];
  return next.join("\n").replace(/\n*$/, "") + "\n";
}
