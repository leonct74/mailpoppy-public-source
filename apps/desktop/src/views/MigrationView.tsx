import { useEffect, useMemo, useRef, useState, type ReactNode, type InputHTMLAttributes, type ComponentType } from "react";
import { Server, KeyRound, Route, User, Lock, RadioTower, Check as CheckIcon, Inbox, ArrowRight, ChevronDown } from "lucide-react";
import {
  testImap as defaultTest,
  runMigration as defaultRun,
  type ImapFolderInfo,
  type MigrateSummary,
} from "../lib/migration";
import { listMailboxes, type Mailbox } from "../lib/mailbox";
import { resolveStackName } from "../lib/deploymentConfig";
import { Button, Card, Spinner, cn } from "../ui";
import { friendlyError } from "../lib/errors";

// Phase 4 — "Bring your old mail across." Connects to the user's existing
// WorkMail / IMAP account (credentials stay on this machine, in the sidecar),
// previews the folders, and imports the selected ones into the deployed
// MailPoppy backend. Imported mail appears in the normal Inbox afterwards.

/**
 * Themed mailbox picker (native <select> can't be styled to match the dark UI).
 * A styled trigger + a dark popover listbox, with mailboxes grouped by domain —
 * a MailPoppy admin typically runs many mailboxes across several domains.
 */
function MailboxSelect({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (email: string) => void;
  groups: [string, Mailbox[]][];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Destination mailbox"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg border bg-surface-container-lowest px-3 py-2.5 text-left transition-all focus:outline-none focus:ring-2 focus:ring-primary/30",
          open ? "border-primary ring-2 ring-primary/30" : "border-outline-variant/30 hover:border-outline-variant/60",
        )}
      >
        <Inbox className="size-4 shrink-0 text-outline" />
        <span className={cn("flex-1 truncate font-mono text-[13px]", value ? "text-on-surface" : "text-outline-variant")}>
          {value || "Select a mailbox…"}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-on-surface-variant transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Choose a mailbox"
          className="absolute z-20 mt-1.5 max-h-72 w-full overflow-auto rounded-xl border border-outline-variant/20 bg-surface-container-high p-1.5 shadow-xl shadow-black/40"
        >
          {groups.map(([domain, list], gi) => (
            <div key={domain} className={gi > 0 ? "mt-1 border-t border-outline-variant/10 pt-1" : ""}>
              <div className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant/60">
                {domain}
              </div>
              {list.map((mb) => {
                const selected = mb.email === value;
                return (
                  <button
                    key={mb.email}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(mb.email);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left font-mono text-[13px] transition-colors",
                      selected ? "bg-primary/15 text-primary" : "text-on-surface hover:bg-surface-container-highest",
                    )}
                  >
                    <span className="flex-1 truncate">{mb.email}</span>
                    {selected && <CheckIcon className="size-4 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A section heading inside a form card — mono, uppercase, with a leading icon and a divider. */
function SectionHeader({ icon: Icon, children }: { icon: ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 border-b border-outline-variant/10 pb-3 font-mono text-xs font-medium uppercase tracking-wider text-primary">
      <Icon className="size-4" />
      {children}
    </div>
  );
}

/** A labelled field wrapper. */
function Field({ label, hint, className, children }: { label: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="text-sm text-on-surface-variant">{label}</span>
      {children}
      {hint && <p className="text-xs leading-relaxed text-on-surface-variant/70">{hint}</p>}
    </div>
  );
}

/** Dark text input, optionally with a leading icon (and monospaced for technical values). */
function TextInput({
  icon: Icon,
  mono,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ComponentType<{ className?: string }>; mono?: boolean }) {
  return (
    <div className="relative">
      {Icon && <Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-outline" />}
      {/* These are technical values (host, email/username, password) — never let
          the webview capitalize the first letter or autocorrect them. Defaults
          come before {...props} so a caller could still override if needed. */}
      <input
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest py-2.5 text-sm text-on-surface placeholder:text-outline-variant",
          "transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
          Icon ? "pl-10 pr-4" : "px-4",
          mono && "font-mono text-[13px]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** Stitch-style custom checkbox. */
function Checkbox({
  ariaLabel,
  checked,
  onChange,
  children,
}: {
  ariaLabel: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="group flex cursor-pointer items-center gap-3">
      <span className="relative flex items-center justify-center">
        <input
          aria-label={ariaLabel}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer size-5 cursor-pointer appearance-none rounded border border-outline-variant/50 bg-surface-container-low transition-all checked:border-primary checked:bg-primary"
        />
        <CheckIcon className="pointer-events-none absolute size-3.5 text-on-primary opacity-0 transition-opacity peer-checked:opacity-100" />
      </span>
      <span className="text-sm text-on-surface transition-colors group-hover:text-primary">{children}</span>
    </label>
  );
}

/** A data table styled per the design's "Resource Tables" spec. */
function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn("border-b border-outline-variant/10 px-3 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-on-surface-variant", className)}>
      {children}
    </th>
  );
}
function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("border-b border-outline-variant/10 px-3 py-2.5 text-sm", className)}>{children}</td>;
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export function MigrationView({
  test = defaultTest,
  run = defaultRun,
  // The backend is resolved (one per install), not typed — see deploymentConfig.
  stackName = resolveStackName(),
  loadMailboxes = listMailboxes,
  // When the user arrives here from a domain's "Import old mail" action, focus
  // the destination on that domain so imports can't land on the wrong domain.
  preselectDomain,
}: {
  test?: typeof defaultTest;
  run?: typeof defaultRun;
  stackName?: string;
  loadMailboxes?: typeof listMailboxes;
  preselectDomain?: string;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [dryRun, setDryRun] = useState(false);

  // Destination is chosen from the mailboxes that actually exist in the deployed
  // backend. A MailPoppy admin typically runs many mailboxes across several
  // domains, so a picker (not a free-text field) makes the target unmistakable
  // and prevents importing into a typo'd address no one could ever sign in to.
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [mbLoading, setMbLoading] = useState(true);
  const [mbNotice, setMbNotice] = useState<string | null>(null);

  const [folders, setFolders] = useState<ImapFolderInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<MigrateSummary | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "run">("");
  const [error, setError] = useState<string | null>(null);

  // Load the destination mailboxes from the deployed backend (one user pool;
  // mailboxes may span several domains).
  useEffect(() => {
    let cancelled = false;
    setMbLoading(true);
    setMbNotice(null);
    loadMailboxes(stackName)
      .then((res) => {
        if (cancelled) return;
        setMailboxes(res.mailboxes);
        if (res.mailboxes.length === 1) {
          setMailbox(res.mailboxes[0]!.email); // exactly one → preselect it
        } else if (res.mailboxes.length === 0) {
          setMbNotice("No mailboxes exist yet. Create one in the Setup tab first — that's where imported mail will land.");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setMailboxes([]);
        const msg = String(e);
        setMbNotice(
          /\b404\b/.test(msg) && /No deployed MailPoppy backend/i.test(msg)
            ? "No backend is deployed yet. Run Setup (deploy a backend, then create a mailbox) before importing mail."
            : `Couldn't load your mailboxes: ${friendlyError(e)}`,
        );
      })
      .finally(() => {
        if (!cancelled) setMbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadMailboxes, stackName]);

  // Group mailboxes by domain so a multi-domain setup is easy to scan.
  const mailboxesByDomain = useMemo(() => {
    const m = new Map<string, Mailbox[]>();
    for (const mb of mailboxes ?? []) {
      const domain = mb.email.split("@")[1] ?? "";
      const list = m.get(domain);
      if (list) list.push(mb);
      else m.set(domain, [mb]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mailboxes]);

  // Focus the destination on the domain the user drilled in from. Runs when the
  // requested domain or the loaded mailbox list changes. Keeps a destination the
  // user already chose if it's on that domain; otherwise picks the first mailbox
  // on it. If the domain has no mailboxes, leaves the current selection alone.
  useEffect(() => {
    if (!preselectDomain || !mailboxes || mailboxes.length === 0) return;
    const onDomain = mailboxes.filter((mb) => domainOf(mb.email) === preselectDomain.toLowerCase());
    if (onDomain.length === 0) return;
    setMailbox((prev) => (prev && onDomain.some((mb) => mb.email === prev) ? prev : onDomain[0]!.email));
  }, [preselectDomain, mailboxes]);

  function source() {
    return { host, port: Number(port) || undefined, secure, user, password };
  }

  async function onTest() {
    setBusy("test");
    setError(null);
    setSummary(null);
    try {
      const res = await test(source());
      setFolders(res.folders);
      // Pre-select non-empty folders.
      setSelected(new Set(res.folders.filter((f) => f.messages > 0).map((f) => f.path)));
    } catch (e) {
      setFolders(null);
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  async function onRun() {
    setBusy("run");
    setError(null);
    try {
      const res = await run({
        source: source(),
        mailbox,
        stackName,
        folders: [...selected],
        dryRun,
      });
      setSummary(res);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const canTest = !!(host && user && password) && busy === "";
  const canRun = !!(folders && selected.size > 0 && mailbox) && busy === "";

  return (
    <section className="mx-auto max-w-3xl">
      <header className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight text-on-surface">Bring your old mail across</h2>
        <p className="mt-2 max-w-2xl text-lg text-on-surface-variant">
          Works with <strong className="text-on-surface">any mailbox that supports IMAP</strong> — AWS WorkMail,
          Yahoo, Fastmail, iCloud, your web host's mailbox, and more. Import all your existing mail into your new
          MailPoppy mailbox before the old account is shut down. Your credentials stay on this machine — sent only to
          the local helper, never to us.
        </p>
      </header>

      <Card className="p-8">
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-12">
          {/* Server configuration */}
          <div className="md:col-span-12">
            <SectionHeader icon={Server}>Server configuration</SectionHeader>
          </div>
          <Field
            label="IMAP host"
            className="md:col-span-8"
            hint={
              <>
                Your provider's incoming (IMAP) server — e.g. AWS WorkMail{" "}
                <code className="font-mono text-on-surface-variant">imap.mail.&lt;region&gt;.awsapps.com</code>, Yahoo{" "}
                <code className="font-mono text-on-surface-variant">imap.mail.yahoo.com</code>, Fastmail{" "}
                <code className="font-mono text-on-surface-variant">imap.fastmail.com</code>, or your web host's{" "}
                <code className="font-mono text-on-surface-variant">mail.yourdomain.com</code>.
              </>
            }
          >
            <TextInput
              aria-label="IMAP host"
              icon={Server}
              mono
              value={host}
              placeholder="imap.yourprovider.com"
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          <Field label="Port" className="md:col-span-4">
            <TextInput aria-label="IMAP port" mono value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>

          {/* Authentication */}
          <div className="md:col-span-12">
            <SectionHeader icon={KeyRound}>Authentication</SectionHeader>
          </div>
          <Field label="Username" className="md:col-span-6">
            <TextInput aria-label="IMAP username" icon={User} mono value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field
            label="Password"
            className="md:col-span-6"
            hint="The password for the OLD account you're importing from — not your new MailPoppy mailbox. Some providers (e.g. Yahoo, iCloud, Fastmail) require an app-specific password — and IMAP enabled in the account's settings — rather than your normal login password when 2-factor sign-in is on."
          >
            <TextInput
              aria-label="IMAP password"
              icon={Lock}
              type="password"
              mono
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {/* Routing */}
          <div className="md:col-span-12">
            <SectionHeader icon={Route}>Routing</SectionHeader>
          </div>
          <Field
            label="Destination mailbox"
            className="md:col-span-12"
            hint={
              <>
                Imported mail lands in this MailPoppy mailbox. Don't see the one you want? Create it in the{" "}
                <strong className="text-on-surface">Setup</strong> tab first.
              </>
            }
          >
            {mbLoading ? (
              <div className="flex items-center gap-2 rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-4 py-2.5 text-sm text-on-surface-variant">
                <Spinner /> Loading your mailboxes…
              </div>
            ) : mailboxes && mailboxes.length > 0 ? (
              <MailboxSelect value={mailbox} onChange={setMailbox} groups={mailboxesByDomain} />
            ) : (
              <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn-bright">
                {mbNotice ?? "No mailboxes available."}
              </div>
            )}
          </Field>

          {/* Options */}
          <div className="flex flex-col gap-4 rounded-lg border border-outline-variant/10 bg-surface-container-lowest/50 p-4 sm:flex-row sm:gap-8 md:col-span-12">
            <Checkbox ariaLabel="Use TLS" checked={secure} onChange={setSecure}>
              Implicit TLS (993)
            </Checkbox>
            <Checkbox ariaLabel="Preview only" checked={dryRun} onChange={setDryRun}>
              Preview only (count, don't import)
            </Checkbox>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-10 flex justify-end border-t border-outline-variant/10 pt-6">
          <Button disabled={!canTest} onClick={() => void onTest()}>
            {busy === "test" ? <Spinner className="border-white/40 border-t-white" /> : <RadioTower className="size-4" />}
            {busy === "test" ? "Connecting…" : "Test connection"}
          </Button>
        </div>
      </Card>

      <p className="mt-6 flex items-center justify-center gap-2 text-xs text-on-surface-variant/80">
        <Lock className="size-3.5" />
        Your credentials remain securely local to this machine and are never transmitted externally.
      </p>

      {error && (
        <div className="mt-6 rounded-lg border border-tertiary/30 bg-tertiary-container/10 px-4 py-3 text-sm text-tertiary">
          {error}
        </div>
      )}

      {folders && (
        <Card className="mt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <strong className="text-on-surface">
                Folders on <span className="font-mono text-sm text-on-surface-variant">{host}</span>
              </strong>
              <div className="mt-1 flex items-center gap-1.5 text-sm text-on-surface-variant">
                <ArrowRight className="size-3.5 shrink-0 text-secondary" />
                Importing into{" "}
                {mailbox ? (
                  <span className="font-mono text-secondary">{mailbox}</span>
                ) : (
                  <span className="text-warn">— choose a destination mailbox above</span>
                )}
              </div>
            </div>
            <Button disabled={!canRun} onClick={() => void onRun()}>
              {busy === "run" ? <Spinner className="border-white/40 border-t-white" /> : <ArrowRight className="size-4" />}
              {busy === "run" ? "Importing…" : dryRun ? "Preview selected" : `Import ${selected.size} folder${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
          {folders.length === 0 ? (
            <p className="mt-4 text-sm text-on-surface-variant">No folders found.</p>
          ) : (
            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr>
                  <Th>Import</Th>
                  <Th>IMAP folder</Th>
                  <Th>→ MailPoppy folder</Th>
                  <Th>Messages</Th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.path} className="transition-colors hover:bg-on-surface/5">
                    <Td>
                      <input
                        aria-label={`Include ${f.path}`}
                        type="checkbox"
                        className="size-4 cursor-pointer accent-primary"
                        checked={selected.has(f.path)}
                        onChange={() => toggle(f.path)}
                      />
                    </Td>
                    <Td className="font-mono text-on-surface">{f.path}</Td>
                    <Td className="font-mono text-on-surface-variant">{f.mappedFolder}</Td>
                    <Td className="text-on-surface">{f.messages}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {summary && (
        <Card className="mt-6 border-secondary/30 bg-secondary/[0.06]">
          <strong className="text-secondary">{summary.dryRun ? "Preview" : "Import complete"}</strong>
          <p className="my-2 text-sm text-on-surface">
            {summary.dryRun
              ? `${summary.totalImported} messages would be imported into ${summary.mailbox}.`
              : `Imported ${summary.totalImported} messages into ${summary.mailbox} (${summary.totalSkipped} skipped). They're in your Inbox now.`}
          </p>
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr>
                <Th>IMAP folder</Th>
                <Th>→ MailPoppy folder</Th>
                <Th>{summary.dryRun ? "Would import" : "Imported"}</Th>
                <Th>Skipped</Th>
              </tr>
            </thead>
            <tbody>
              {summary.folders.map((r) => (
                <tr key={r.path} className="transition-colors hover:bg-on-surface/5">
                  <Td className="font-mono text-on-surface">{r.path}</Td>
                  <Td className="font-mono text-on-surface-variant">{r.mappedFolder}</Td>
                  <Td className="text-on-surface">{r.imported}</Td>
                  <Td className="text-on-surface">{r.skipped}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
