// The set of mailboxes added to this install, and which one is active — the
// desktop twin of the mobile app's accounts store. Every added mailbox lives in
// the ONE deployed backend (one Cognito user pool), so they all share the saved
// DeploymentConfig — only the signed-in user changes. Each mailbox's Cognito
// tokens already persist in localStorage keyed by its storage username; this
// store only remembers the *list* (email + that storage username) and the active
// email, so the switcher restores after a restart.

const KEY = "mailpoppy.accounts";

export interface MailboxAccount {
  /** The mailbox address, e.g. support@acme.com — what the user sees and picks. */
  email: string;
  /** The username amazon-cognito-identity-js stored this session under (its
   *  `LastAuthUser`), captured right after sign-in. Used to fetch a token / sign
   *  this specific mailbox out without disturbing the others. */
  username: string;
}

export interface AccountsState {
  accounts: MailboxAccount[];
  activeEmail: string | null;
}

const EMPTY: AccountsState = { accounts: [], activeEmail: null };

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Load the persisted mailbox list + active email (EMPTY on first run / any error). */
export function loadAccounts(): AccountsState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<AccountsState>;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(
          (a): a is MailboxAccount => !!a && typeof a.email === "string" && typeof a.username === "string",
        )
      : [];
    const activeEmail =
      typeof parsed.activeEmail === "string" && accounts.some((a) => a.email === parsed.activeEmail)
        ? parsed.activeEmail
        : (accounts[0]?.email ?? null);
    return { accounts, activeEmail };
  } catch {
    return EMPTY;
  }
}

export function saveAccounts(state: AccountsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/**
 * Add (or update) a mailbox and make it active. Pure on the passed-in state so
 * it's unit-testable; the caller persists the result. De-duplicates by email
 * (a re-add refreshes its stored username).
 */
export function withMailbox(state: AccountsState, account: MailboxAccount): AccountsState {
  const email = normaliseEmail(account.email);
  const rest = state.accounts.filter((a) => a.email !== email);
  return { accounts: [...rest, { email, username: account.username }], activeEmail: email };
}

/** Remove a mailbox; if it was active, fall back to the first remaining one. */
export function withoutMailbox(state: AccountsState, email: string): AccountsState {
  const target = normaliseEmail(email);
  const accounts = state.accounts.filter((a) => a.email !== target);
  const activeEmail = state.activeEmail === target ? (accounts[0]?.email ?? null) : state.activeEmail;
  return { accounts, activeEmail };
}

/** Set the active mailbox (no-op if it isn't in the list). */
export function withActive(state: AccountsState, email: string): AccountsState {
  const target = normaliseEmail(email);
  if (!state.accounts.some((a) => a.email === target)) return state;
  return { ...state, activeEmail: target };
}
