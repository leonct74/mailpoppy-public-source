// Mailbox-access authentication (DESIGN §6). This is the *mailbox plane*, not the
// provisioning plane: it never touches AWS admin credentials — the user signs in
// to the deployment's Cognito User Pool and we get a JWT, which the MailClient
// sends to API Gateway. amazon-cognito-identity-js does SRP client-side and works
// in the Tauri webview today and React Native later, so this module is portable.
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import type { DeploymentConfig } from "./deploymentConfig";

/**
 * Pull the `email` claim out of a Cognito ID token (JWT). When the pool uses
 * email as an *alias*, the token's username / `sub` is an opaque UUID, so the
 * `email` claim is the only reliable source of the mailbox address. Pure and
 * defensive — returns null on any malformed input. Exported for unit testing.
 */
export function emailFromJwt(idToken: string): string | null {
  try {
    const part = idToken.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const claims = JSON.parse(atob(b64 + pad)) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export interface SignInResult {
  status: "signed-in" | "new-password-required";
  email: string;
}

/** The surface LoginView depends on — so tests can inject a fake. */
export interface Authenticator {
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Admin-created users must set a password on first sign-in. */
  completeNewPassword(newPassword: string): Promise<SignInResult>;
  /** A fresh id token (JWT), refreshing if needed. Rejects if signed out. */
  getToken(): Promise<string>;
  signOut(): void;
  hasSession(): boolean;
  /** The signed-in mailbox address, or null when signed out. Resolved from the
   *  ID-token claims, so it's the real email even when the pool uses email as an
   *  alias (username is then an opaque UUID). Works for restored sessions. */
  currentEmail(): Promise<string | null>;
}

export class CognitoAuth implements Authenticator {
  private readonly pool: CognitoUserPool;
  private readonly clientId: string;
  private pendingUser: CognitoUser | null = null;
  // The storage username (amazon-cognito `LastAuthUser`) of the mailbox the app is
  // currently acting as. When set, getToken() serves THIS mailbox's token even
  // though several mailboxes' sessions coexist in localStorage. Null falls back to
  // the library's "current user" (single-session / legacy path).
  private activeUsername: string | null = null;

  constructor(cfg: DeploymentConfig) {
    this.clientId = cfg.clientId;
    this.pool = new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.clientId });
  }

  /** amazon-cognito's per-pool `LastAuthUser` storage key. */
  private lastAuthKey(): string {
    return `CognitoIdentityServiceProvider.${this.clientId}.LastAuthUser`;
  }

  /** The username the last successful sign-in cached its tokens under (whatever the
   *  library used — email or an opaque sub). Read straight after signIn to record it. */
  lastAuthUsername(): string | null {
    try {
      return localStorage.getItem(this.lastAuthKey());
    } catch {
      return null;
    }
  }

  /** Point the app at a specific mailbox's session (by its storage username). Also
   *  syncs `LastAuthUser` so getCurrentUser()/hasSession() agree with getToken(). */
  setActiveUsername(username: string | null): void {
    this.activeUsername = username;
    try {
      if (username) localStorage.setItem(this.lastAuthKey(), username);
    } catch {
      /* ignore */
    }
  }

  /** A fresh ID token for a SPECIFIC mailbox (by storage username), refreshing if
   *  needed. This is how one install serves several coexisting mailbox sessions. */
  getTokenFor(username: string): Promise<string> {
    const user = new CognitoUser({ Username: username, Pool: this.pool });
    return new Promise((resolve, reject) => {
      user.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session) return reject(err ?? new Error("no session"));
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }

  /** Sign ONE mailbox out (drop just its cached tokens), leaving the others intact. */
  signOutUser(username: string): void {
    const user = new CognitoUser({ Username: username, Pool: this.pool });
    user.signOut();
    if (this.activeUsername === username) this.activeUsername = null;
  }

  signIn(email: string, password: string): Promise<SignInResult> {
    const user = new CognitoUser({ Username: email, Pool: this.pool });
    const auth = new AuthenticationDetails({ Username: email, Password: password });
    return new Promise((resolve, reject) => {
      user.authenticateUser(auth, {
        onSuccess: () => {
          // The fresh sign-in is now the active mailbox — getToken()/key
          // establishment right after this must serve the NEW user, not whichever
          // mailbox the switcher pointed at before.
          this.activeUsername = this.lastAuthUsername();
          resolve({ status: "signed-in", email });
        },
        onFailure: (err) => reject(err),
        newPasswordRequired: () => {
          this.pendingUser = user; // keep for completeNewPassword
          resolve({ status: "new-password-required", email });
        },
      });
    });
  }

  completeNewPassword(newPassword: string): Promise<SignInResult> {
    const user = this.pendingUser;
    if (!user) return Promise.reject(new Error("no pending password challenge"));
    return new Promise((resolve, reject) => {
      user.completeNewPasswordChallenge(
        newPassword,
        {},
        {
          onSuccess: () => {
            this.pendingUser = null;
            this.activeUsername = this.lastAuthUsername();
            resolve({ status: "signed-in", email: user.getUsername() });
          },
          onFailure: (err) => reject(err),
        },
      );
    });
  }

  getToken(): Promise<string> {
    if (this.activeUsername) return this.getTokenFor(this.activeUsername);
    const user = this.pool.getCurrentUser();
    if (!user) return Promise.reject(new Error("not signed in"));
    return new Promise((resolve, reject) => {
      user.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session) return reject(err ?? new Error("no session"));
        resolve(session.getIdToken().getJwtToken());
      });
    });
  }

  signOut(): void {
    this.pool.getCurrentUser()?.signOut();
    this.pendingUser = null;
    this.activeUsername = null;
  }

  hasSession(): boolean {
    return this.pool.getCurrentUser() != null;
  }

  async currentEmail(): Promise<string | null> {
    // The Cognito *username* is an opaque UUID when the pool uses email as an
    // alias, so getUsername() isn't the address — the email lives in the ID-token
    // claims. getToken() returns a fresh ID token (loading/refreshing the restored
    // session as needed), so this works after sign-in and across restarts.
    try {
      return emailFromJwt(await this.getToken());
    } catch {
      return null;
    }
  }
}
