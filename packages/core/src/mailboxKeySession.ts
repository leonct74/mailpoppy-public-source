// Mailbox-key lifecycle, shared by every client (desktop/web/mobile).
//
// This is the orchestration that sits on top of the raw primitives in
// `mailboxCrypto.ts`: it decides, on each login, whether to GENERATE a keypair
// (first login), UNWRAP the stored one with the password, or RE-KEY when the
// stored wrapping can no longer be opened (an admin reset — see
// docs/mailbox-encryption-design.md §4/§6). Like the primitives, it is
// BINDING-AGNOSTIC: the caller injects a ready libsodium instance and a tiny
// transport (`MailboxKeyStore`) that the MailpoppyClient already satisfies.

import {
  type Sodium,
  type MailboxKeyRecord,
  createMailboxKeyRecord,
  unwrapPrivateKey,
  rewrapPrivateKey,
  generateRecoveryKey,
  bytesToB64,
} from "./mailboxCrypto";

/** The minimal backend surface the lifecycle needs — `GET`/`PUT /mailbox-keys`.
 *  `MailpoppyClient` (api-client) structurally satisfies this; tests pass a fake. */
export interface MailboxKeyStore {
  getMailboxKeys(): Promise<{ record: MailboxKeyRecord | null }>;
  putMailboxKeys(record: MailboxKeyRecord): Promise<unknown>;
}

/** The unlocked key material a signed-in client caches IN MEMORY for the session
 *  (never persisted — it's re-derived from the password on the next login). */
export interface MailboxKeySession {
  publicKey: string; // base64
  privateKey: Uint8Array;
}

export interface EstablishResult extends MailboxKeySession {
  /** A keypair was just generated server-side: first login OR a re-key. */
  created: boolean;
  /** True only when an EXISTING record couldn't be unwrapped (admin reset) and we
   *  generated a fresh keypair. Mail received under the old keypair is now
   *  unrecoverable — by design (§4/§6). Surface this to the user. */
  rekeyed: boolean;
  /** base64 recovery key — present only when `created` and recovery is enabled.
   *  Show it to the user ONCE; it is never stored server-side in the clear. */
  recoveryKey?: string;
}

export interface EstablishOptions {
  /** Generate a recovery key on (re-)keygen and store its second wrapping so the
   *  user can rescue old mail after a forgotten/reset password. Default: true. */
  withRecoveryKey?: boolean;
}

function freshRecord(s: Sodium, password: string, withRecovery: boolean) {
  const recoveryKeyBytes = withRecovery ? generateRecoveryKey(s) : undefined;
  const { record, privateKey } = createMailboxKeyRecord(s, password, { recoveryKey: recoveryKeyBytes });
  return {
    record,
    privateKey,
    recoveryKey: recoveryKeyBytes ? bytesToB64(s, recoveryKeyBytes) : undefined,
  };
}

/**
 * Establish the mailbox keypair for a just-authenticated session and return the
 * unlocked private key to cache. Call this right after a successful sign-in /
 * new-password challenge, while the plaintext password is still in hand.
 *
 *   no record         → first login: generate, upload, return (created)
 *   record + password → unwrap and return                       (created:false)
 *   record + ✗unwrap  → admin reset: re-key, upload, return     (created, rekeyed)
 *
 * The password reaching the `record + ✗unwrap` branch is necessarily the user's
 * CURRENT password (Cognito just authenticated it), so a failure to open `WPK`
 * means the wrapping is stale — the only safe move is a fresh keypair.
 */
export async function establishMailboxKeys(
  s: Sodium,
  store: MailboxKeyStore,
  password: string,
  opts: EstablishOptions = {},
): Promise<EstablishResult> {
  const withRecovery = opts.withRecoveryKey ?? true;
  const { record } = await store.getMailboxKeys();

  if (record) {
    try {
      const privateKey = unwrapPrivateKey(s, password, record);
      return { publicKey: record.publicKey, privateKey, created: false, rekeyed: false };
    } catch {
      const fresh = freshRecord(s, password, withRecovery);
      await store.putMailboxKeys(fresh.record);
      return {
        publicKey: fresh.record.publicKey,
        privateKey: fresh.privateKey,
        created: true,
        rekeyed: true,
        recoveryKey: fresh.recoveryKey,
      };
    }
  }

  const fresh = freshRecord(s, password, withRecovery);
  await store.putMailboxKeys(fresh.record);
  return {
    publicKey: fresh.record.publicKey,
    privateKey: fresh.privateKey,
    created: true,
    rekeyed: false,
    recoveryKey: fresh.recoveryKey,
  };
}

/**
 * User-initiated password change (the user knows the OLD password): unwrap with
 * the old password, re-wrap the SAME private key under the new one → no data
 * loss, and the keypair is preserved so all existing mail still opens. The
 * existing recovery wrapping is preserved untouched (it wraps the same private
 * key, so the user's saved recovery key keeps working). Throws "wrong password"
 * if `oldPassword` is wrong.
 */
export async function changeMailboxPassword(
  s: Sodium,
  store: MailboxKeyStore,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const { record } = await store.getMailboxKeys();
  if (!record) throw new Error("no mailbox keys to re-wrap");
  const priv = unwrapPrivateKey(s, oldPassword, record); // throws on wrong old password
  const rewrapped = rewrapPrivateKey(s, priv, newPassword); // keypair unchanged
  await store.putMailboxKeys({ ...record, ...rewrapped }); // keeps existing wrappedPrivateKeyRecovery
}
