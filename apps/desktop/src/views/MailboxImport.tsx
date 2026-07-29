import { useRef, useState } from "react";
import { Upload, Download, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, ArrowRight } from "lucide-react";
import type { MailboxImportPlan } from "@mailpoppy/core";
import {
  parseMailboxImport as defaultParse,
  saveMailboxImportTemplate as defaultSaveTemplate,
  fileToBase64 as defaultFileToBase64,
  createMailbox as defaultCreateMailbox,
  type Mailbox,
  type BackendInfo,
} from "../lib/mailbox";
import { runMigration as defaultRunMigration, type RunInput, type MigrateSummary } from "../lib/migration";
import { Button, Spinner, cn } from "../ui";
import { friendlyError } from "../lib/errors";

// Bulk-create mailboxes (and optionally migrate their old mail) from a chosen
// spreadsheet. Parsing + validation happen in the sidecar (ExcelJS → @mailpoppy/core);
// this component shows the resulting plan as a preview, then drives the EXISTING
// per-mailbox create + migrate endpoints one row at a time, so it can show live
// progress and a bad row never aborts the rest. Scoped to one domain by the
// parent (DomainView), which only renders it once the domain can send.

type RowStatus =
  | { kind: "pending" }
  | { kind: "skipped" } // has validation errors → excluded from the run
  | { kind: "creating" }
  | { kind: "migrating" }
  | { kind: "ok"; existed: boolean; imported?: number; migrateError?: string }
  | { kind: "failed"; message: string };

type ParseFn = (input: { domain: string; fileBase64: string; filename?: string }) => Promise<{ ok: true; plan: MailboxImportPlan }>;
type CreateFn = (input: { email: string; password: string; stackName?: string }) => Promise<BackendInfo & { ok: true; mailbox: Mailbox }>;
type MigrateFn = (input: RunInput) => Promise<MigrateSummary & { ok: true }>;

export function MailboxImport({
  domain,
  stackName,
  onImported,
  parse = defaultParse,
  saveTemplate = defaultSaveTemplate,
  readFileBase64 = defaultFileToBase64,
  createMailbox = defaultCreateMailbox,
  runMigration = defaultRunMigration,
}: {
  domain: string;
  stackName?: string;
  onImported?: () => void;
  parse?: ParseFn;
  saveTemplate?: (domain: string) => Promise<{ ok: true; path: string; filename: string; dir: string }>;
  readFileBase64?: (file: File) => Promise<string>;
  createMailbox?: CreateFn;
  runMigration?: MigrateFn;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MailboxImportPlan | null>(null);
  const [statuses, setStatuses] = useState<Record<number, RowStatus>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState<{ filename: string; dir: string } | null>(null);

  function reset() {
    setFileName(null);
    setParseError(null);
    setPlan(null);
    setStatuses({});
    setRunning(false);
    setFinished(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onPick(file: File) {
    reset();
    setFileName(file.name);
    setParsing(true);
    try {
      const fileBase64 = await readFileBase64(file);
      const { plan } = await parse({ domain, fileBase64, filename: file.name });
      setPlan(plan);
      const init: Record<number, RowStatus> = {};
      for (const r of plan.rows) init[r.row] = r.errors.length ? { kind: "skipped" } : { kind: "pending" };
      setStatuses(init);
    } catch (e) {
      setParseError(friendlyError(e));
    } finally {
      setParsing(false);
    }
  }

  async function downloadTemplate() {
    setParseError(null);
    setTemplateSaved(null);
    setSavingTemplate(true);
    try {
      // The webview can't trigger a file save (blob <a download> is ignored, and
      // the opener plugin only allows http/https), so the local sidecar writes the
      // file to disk for us and tells us where it landed.
      const { filename, dir } = await saveTemplate(domain);
      setTemplateSaved({ filename, dir });
    } catch (e) {
      setParseError(friendlyError(e));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function run() {
    if (!plan) return;
    setRunning(true);
    setFinished(false);
    for (const r of plan.rows) {
      if (r.errors.length) continue; // already marked "skipped"
      setStatuses((s) => ({ ...s, [r.row]: { kind: "creating" } }));
      let existed = false;
      try {
        await createMailbox({ email: r.email, password: r.password, stackName });
      } catch (e) {
        const msg = String(e);
        // Re-running an import shouldn't fail on mailboxes that already exist —
        // treat that as "already there" and still attempt the optional migration.
        if (/exist/i.test(msg)) existed = true;
        else {
          setStatuses((s) => ({ ...s, [r.row]: { kind: "failed", message: friendlyError(e) } }));
          continue;
        }
      }
      if (r.willMigrate && r.imap) {
        setStatuses((s) => ({ ...s, [r.row]: { kind: "migrating" } }));
        try {
          const sum = await runMigration({ source: r.imap, mailbox: r.email, stackName });
          setStatuses((s) => ({ ...s, [r.row]: { kind: "ok", existed, imported: sum.totalImported } }));
        } catch (e) {
          // The mailbox exists; only the import failed — surface that without
          // calling the whole row a failure.
          setStatuses((s) => ({ ...s, [r.row]: { kind: "ok", existed, migrateError: friendlyError(e) } }));
        }
      } else {
        setStatuses((s) => ({ ...s, [r.row]: { kind: "ok", existed } }));
      }
    }
    setRunning(false);
    setFinished(true);
    onImported?.();
  }

  // ---- Render helpers ----
  const list = Object.values(statuses);
  const okCount = list.filter((s) => s.kind === "ok").length;
  const failCount = list.filter((s) => s.kind === "failed").length;
  const migratedCount = list.filter((s) => s.kind === "ok" && s.imported != null).length;

  const inputId = "mailbox-import-file";

  return (
    <div className="rounded-lg border border-outline-variant/20 bg-surface-container-lowest/40 p-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="size-4 text-primary" />
        <h4 className="font-semibold text-on-surface">Import mailboxes from a spreadsheet</h4>
      </div>
      <p className="mt-1 text-sm text-on-surface-variant">
        Add many mailboxes at once from an Excel (.xlsx) or CSV file. Only an{" "}
        <b className="text-on-surface">email</b> and a <b className="text-on-surface">password</b> are required per
        row — the IMAP columns are <b className="text-on-surface">optional</b>, used only if you also want to import a
        mailbox's old mail.
      </p>
      <p className="mt-1 text-xs text-on-surface-variant/70">
        Tip: if you edit the template in Apple Numbers, export it back to Excel or CSV
        (File ▸ Export To) before uploading — Numbers' own <code className="font-mono">.numbers</code> files can't be read.
      </p>

      {/* File chooser + template download (always available). */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          id={inputId}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="sr-only"
          aria-label="Choose a spreadsheet to import"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
          }}
        />
        <Button variant="secondary" size="sm" disabled={running} onClick={() => fileInput.current?.click()}>
          <Upload className="size-4" /> {plan || parsing ? "Choose a different file" : "Choose file"}
        </Button>
        <Button variant="ghost" size="sm" disabled={running || savingTemplate} onClick={() => void downloadTemplate()}>
          {savingTemplate ? <Spinner /> : <Download className="size-4" />} Download template
        </Button>
        {fileName && (
          <span className="truncate font-mono text-xs text-on-surface-variant" title={fileName}>
            {fileName}
          </span>
        )}
      </div>

      {templateSaved && (
        <div className="mt-2 rounded-lg border border-secondary/30 bg-secondary/10 p-2.5 text-sm text-on-surface">
          ✅ Template saved as <b>{templateSaved.filename}</b> in{" "}
          <code className="font-mono text-xs text-on-surface-variant">{templateSaved.dir}</code>.
        </div>
      )}

      {parsing && (
        <div className="mt-3 flex items-center gap-2 text-sm text-on-surface-variant">
          <Spinner /> Reading the spreadsheet…
        </div>
      )}

      {parseError && (
        <div className="mt-3 rounded-lg border border-tertiary/30 bg-tertiary-container/10 p-3 text-sm text-tertiary">
          {parseError}
        </div>
      )}

      {plan && (
        <div className="mt-4">
          {/* Summary of what the file will do. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-on-surface">
              <b>{plan.validCount}</b> {plan.validCount === 1 ? "mailbox" : "mailboxes"} to create
            </span>
            {plan.migrateCount > 0 && (
              <span className="text-on-surface-variant">
                <b className="text-on-surface">{plan.migrateCount}</b> will also import old mail
              </span>
            )}
            {plan.errorCount > 0 && (
              <span className="text-warn">
                <b>{plan.errorCount}</b> {plan.errorCount === 1 ? "row has" : "rows have"} problems and will be skipped
              </span>
            )}
          </div>

          {/* Per-row preview / progress. */}
          <ul className="mt-3 flex flex-col divide-y divide-outline-variant/10 overflow-hidden rounded-lg border border-outline-variant/15">
            {plan.rows.map((r) => {
              const st = statuses[r.row] ?? { kind: "pending" };
              return (
                <li key={r.row} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-container-lowest/40 px-3 py-2 text-sm">
                  <StatusIcon st={st} />
                  <span className="font-mono text-on-surface">
                    {r.email || <span className="text-on-surface-variant italic">(no email)</span>}
                  </span>
                  {r.willMigrate && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-secondary/20 bg-secondary/10 px-2 py-0.5 text-[11px] text-secondary">
                      <ArrowRight className="size-3" /> import old mail
                    </span>
                  )}
                  <span className="ml-auto text-xs text-on-surface-variant">
                    <StatusText st={st} />
                  </span>
                  {(r.errors.length > 0 || r.warnings.length > 0) && (
                    <div className="w-full pl-7 text-xs">
                      {r.errors.map((e, i) => (
                        <div key={`e${i}`} className="text-tertiary">
                          • {e}
                        </div>
                      ))}
                      {r.warnings.map((w, i) => (
                        <div key={`w${i}`} className="text-warn/90">
                          • {w}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Run + result. */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => void run()} disabled={running || finished || plan.validCount === 0}>
              {running ? <Spinner className="border-white/40 border-t-white" /> : <Upload className="size-4" />}
              {running
                ? "Importing…"
                : finished
                  ? "Done"
                  : `Create ${plan.validCount} ${plan.validCount === 1 ? "mailbox" : "mailboxes"}`}
            </Button>
            {finished && (
              <span className="text-sm text-on-surface">
                ✅ Created <b>{okCount}</b>
                {migratedCount > 0 && (
                  <>
                    , imported mail for <b>{migratedCount}</b>
                  </>
                )}
                {failCount > 0 && <span className="text-tertiary"> · {failCount} failed</span>}.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ st }: { st: RowStatus }) {
  switch (st.kind) {
    case "skipped":
      return <XCircle className="size-4 shrink-0 text-tertiary" aria-label="skipped" />;
    case "creating":
    case "migrating":
      return <Spinner aria-label="working" />;
    case "ok":
      return st.migrateError ? (
        <AlertTriangle className="size-4 shrink-0 text-warn" aria-label="created, import warning" />
      ) : (
        <CheckCircle2 className="size-4 shrink-0 text-secondary" aria-label="done" />
      );
    case "failed":
      return <XCircle className="size-4 shrink-0 text-tertiary" aria-label="failed" />;
    default:
      return <span className="inline-block size-4 shrink-0 rounded-full border border-outline-variant/40" aria-label="pending" />;
  }
}

function StatusText({ st }: { st: RowStatus }) {
  switch (st.kind) {
    case "skipped":
      return <>will be skipped</>;
    case "creating":
      return <>creating…</>;
    case "migrating":
      return <>importing mail…</>;
    case "ok":
      if (st.migrateError) return <span className="text-warn">created · mail import failed</span>;
      if (st.imported != null) return <>{st.existed ? "already existed" : "created"} · {st.imported} imported</>;
      return <>{st.existed ? "already existed" : "created"}</>;
    case "failed":
      return <span className="text-tertiary" title={st.message}>{st.message}</span>;
    default:
      return <>ready</>;
  }
}
