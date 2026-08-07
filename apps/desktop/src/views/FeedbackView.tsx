// The mandatory Feedback tab (AGENTS.md §9a) — the LAST tab in every poppy.
//
// We render the platform's own element rather than building a rating widget, a request form and a
// donate flow of our own: a user who installs three poppies must find the same four things in the
// same place. The element is vendored verbatim from the AgentsPoppy SDK (`npm run sync-feedback`;
// `npm run check-feedback` fails if the copy drifts).
//
// It needs the host, so it exists only inside the AgentsPoppy container — App hides the tab when
// MailPoppy runs as its own standalone window.
import { useEffect, useRef } from "react";
import { openExternalViaHost } from "../lib/hostBridge";
import { defineFeedbackTab } from "../vendor/agentspoppy-feedback-tab";

/** This poppy's manifest id — what the rating is recorded against. */
const POPPY_ID = "com.mailpoppy.desktop";

/** Where a bug goes — the public issue tracker, mirroring `bugsUrl` in extension.json. */
const BUGS_URL = "https://github.com/leonct74/mailpoppy-public-source/issues";

// The tab calls the AgentsPoppy feedback API itself; the only thing it needs from the host is
// `openExternal` (a sandboxed frame can't open an OS window).
defineFeedbackTab({ openExternal: openExternalViaHost });

export function FeedbackView() {
  const slot = useRef<HTMLDivElement>(null);

  // Created imperatively so React never tries to reconcile the custom element's shadow DOM.
  useEffect(() => {
    const mount = slot.current;
    if (!mount || mount.firstChild) return;
    const el = document.createElement("agentspoppy-feedback");
    el.setAttribute("poppy", POPPY_ID);
    el.setAttribute("bugs", BUGS_URL);
    el.setAttribute("name", "MailPoppy");
    mount.appendChild(el);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">Feedback</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Tell us how MailPoppy is doing. Your rating shows on the AgentsPoppy catalogue, and
          everything here is anonymous unless you choose to leave your email.
        </p>
      </div>
      <div ref={slot} />
    </div>
  );
}
