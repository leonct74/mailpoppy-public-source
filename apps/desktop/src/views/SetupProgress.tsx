import { Check, Lock, Clock } from "lucide-react";
import { Spinner, cn } from "../ui";
import type { PhaseView, PhaseKey } from "../lib/setupProgress";

// The persistent progress stepper, pinned at the top of the setup view. A compact
// HORIZONTAL rail shows every phase at a glance — done (✓), the live one
// (highlighted / spinner), and what's still ahead — so the whole journey stays
// visible without a tall stacked list. Below the rail, a single line spells out
// the CURRENT step one at a time: its plain-language detail, a live spinner, and
// an amber stall note on steps AWS can hold up (DKIM verification).

// Short labels for the rail (the full phrasing lives in the current-step line).
const SHORT_LABEL: Record<PhaseKey, string> = {
  connect: "AWS account",
  deploy: "Email service",
  domain: "Your domain",
  verify: "Verify",
  mailbox: "Mailbox",
};

function Node({ phase, index }: { phase: PhaseView; index: number }) {
  const base = "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold";
  if (phase.busy) {
    return (
      <span className={cn(base, "bg-primary/15 text-primary")}>
        <Spinner className="size-4" />
      </span>
    );
  }
  if (phase.status === "done") {
    return (
      <span className={cn(base, "bg-secondary/20 text-secondary")}>
        <Check className="size-4" />
      </span>
    );
  }
  if (phase.status === "current") {
    // "Your turn" — a filled, gently pulsing badge draws the eye to the live step.
    return (
      <span className={cn(base, "relative bg-primary text-on-primary")}>
        <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/40" />
        <span className="relative">{index + 1}</span>
      </span>
    );
  }
  return (
    <span className={cn(base, "border border-outline-variant/30 text-on-surface-variant/50")}>
      <Lock className="size-3" />
    </span>
  );
}

export function SetupProgress({ phases, reconciling }: { phases: PhaseView[]; reconciling?: boolean }) {
  const done = phases.filter((p) => p.status === "done").length;
  const current = phases.find((p) => p.status === "current") ?? null;
  const allDone = done === phases.length;
  const last = phases.length - 1;

  return (
    <section aria-label="Setup progress" className="rounded-xl border border-outline-variant/15 bg-surface-container p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-on-surface">Your setup progress</h3>
        {reconciling ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant">
            <Spinner className="size-3.5" /> Checking…
          </span>
        ) : (
          <span className="font-mono text-xs text-on-surface-variant/70">
            {done}/{phases.length}
          </span>
        )}
      </div>

      {/* Horizontal rail — every phase at a glance, connectors filled as you go. */}
      <ol className="flex items-start">
        {phases.map((p, idx) => (
          <li
            key={p.key}
            aria-current={p.status === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 flex-col items-center"
          >
            <div className="flex w-full items-center">
              <span
                className={cn(
                  "h-0.5 flex-1 rounded-full",
                  idx === 0 ? "opacity-0" : phases[idx - 1]?.status === "done" ? "bg-secondary/50" : "bg-outline-variant/20",
                )}
              />
              <Node phase={p} index={idx} />
              <span
                className={cn(
                  "h-0.5 flex-1 rounded-full",
                  idx === last ? "opacity-0" : p.status === "done" ? "bg-secondary/50" : "bg-outline-variant/20",
                )}
              />
            </div>
            <span
              className={cn(
                "mt-1.5 px-1 text-center text-[11px] leading-tight",
                p.status === "upcoming"
                  ? "text-on-surface-variant/50"
                  : p.status === "current"
                    ? "font-semibold text-primary"
                    : "text-on-surface-variant",
              )}
            >
              {SHORT_LABEL[p.key]}
            </span>
          </li>
        ))}
      </ol>

      {/* The active step, spelled out one at a time — what's happening + time. */}
      <div className="mt-3 border-t border-outline-variant/10 pt-3">
        {current ? (
          <div className="flex items-start gap-2 text-sm">
            {current.busy ? (
              <Spinner className="mt-0.5 size-4 shrink-0" />
            ) : (
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
            )}
            <div className="min-w-0">
              <span className="font-semibold text-on-surface">{current.label}</span>
              <span className="text-on-surface-variant"> — {current.detail}</span>
              {current.canStall && (
                <div className="mt-1.5 inline-flex items-start gap-1 rounded border border-warn/30 bg-warn/10 px-1.5 py-1 text-[11px] leading-snug text-warn-bright">
                  <Clock className="mt-px size-3 shrink-0" />
                  <span>This can take a while — it runs automatically, so you can leave the app and come back.</span>
                </div>
              )}
            </div>
          </div>
        ) : allDone ? (
          <div className="flex items-center gap-2 text-sm font-medium text-secondary">
            <Check className="size-4" /> All set — your mail backend is live.
          </div>
        ) : null}
      </div>
    </section>
  );
}
