import { describe, it, expect, beforeAll } from "vitest";
import _sodium from "libsodium-wrappers-sumo";
import {
  type Sodium,
  type MailboxKeyRecord,
  createMailboxKeyRecord,
  unwrapPrivateKey,
  recoverPrivateKey,
  sealString,
  openString,
  bytesToB64,
  b64ToBytes,
} from "./mailboxCrypto";
import { establishMailboxKeys, changeMailboxPassword, type MailboxKeyStore } from "./mailboxKeySession";

let s: Sodium;
beforeAll(async () => {
  await _sodium.ready;
  s = _sodium as unknown as Sodium;
});

const PASSWORD = "correct horse battery staple";

/** In-memory backend mirroring GET/PUT /mailbox-keys. */
function fakeStore(initial: MailboxKeyRecord | null = null) {
  const state = { record: initial, puts: 0 };
  const store: MailboxKeyStore = {
    getMailboxKeys: async () => ({ record: state.record }),
    putMailboxKeys: async (r) => {
      state.record = r;
      state.puts += 1;
      return { ok: true };
    },
  };
  return { store, state };
}

describe("establishMailboxKeys", () => {
  it("first login: generates a keypair, uploads it, returns a recovery key, and the key opens mail", async () => {
    const { store, state } = fakeStore(null);
    const r = await establishMailboxKeys(s, store, PASSWORD);

    expect(r.created).toBe(true);
    expect(r.rekeyed).toBe(false);
    expect(r.recoveryKey).toBeTruthy();
    expect(state.puts).toBe(1); // uploaded exactly once
    expect(state.record).not.toBeNull();

    // The returned private key actually decrypts mail sealed to the stored pubkey.
    const sealed = sealString(s, r.publicKey, "hello encrypted world");
    expect(openString(s, r.publicKey, r.privateKey, sealed)).toBe("hello encrypted world");
  });

  it("returning login: unwraps the stored key with the password — no upload, no re-key", async () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD);
    const { store, state } = fakeStore(record);

    const r = await establishMailboxKeys(s, store, PASSWORD);
    expect(r.created).toBe(false);
    expect(r.rekeyed).toBe(false);
    expect(r.recoveryKey).toBeUndefined();
    expect(state.puts).toBe(0); // nothing written
    expect(bytesToB64(s, r.privateKey)).toBe(bytesToB64(s, unwrapPrivateKey(s, PASSWORD, record)));
  });

  it("admin reset: stored wrapping won't open under the current password → re-keys with a fresh keypair", async () => {
    // The record was wrapped under the OLD password; Cognito now authenticates a NEW one.
    const { record: oldRecord } = createMailboxKeyRecord(s, "the-old-password");
    const { store, state } = fakeStore(oldRecord);

    const r = await establishMailboxKeys(s, store, "the-new-password-after-reset");
    expect(r.created).toBe(true);
    expect(r.rekeyed).toBe(true);
    expect(r.recoveryKey).toBeTruthy();
    expect(state.puts).toBe(1);
    // A genuinely new keypair (old mail under the old pubkey is now unrecoverable).
    expect(r.publicKey).not.toBe(oldRecord.publicKey);
    // The fresh key works under the new password.
    expect(bytesToB64(s, unwrapPrivateKey(s, "the-new-password-after-reset", state.record!))).toBe(
      bytesToB64(s, r.privateKey),
    );
  });

  it("respects withRecoveryKey: false (no recovery key, no recovery wrapping stored)", async () => {
    const { store, state } = fakeStore(null);
    const r = await establishMailboxKeys(s, store, PASSWORD, { withRecoveryKey: false });
    expect(r.recoveryKey).toBeUndefined();
    expect(state.record?.wrappedPrivateKeyRecovery).toBeUndefined();
  });
});

describe("changeMailboxPassword", () => {
  it("re-wraps the SAME keypair under a new password: old mail still opens, recovery key preserved", async () => {
    // Seed a record that also has a recovery wrapping.
    const recoveryKeyB64 = (await establishMailboxKeys(s, fakeStore(null).store, PASSWORD)).recoveryKey!;
    const { record } = createMailboxKeyRecord(s, PASSWORD, { recoveryKey: b64ToBytes(s, recoveryKeyB64) });
    const { store, state } = fakeStore(record);

    // Mail encrypted before the password change.
    const sealed = sealString(s, record.publicKey, "minutes from before the change");

    await changeMailboxPassword(s, store, PASSWORD, "a brand new password");

    expect(state.puts).toBe(1);
    // Old password no longer unwraps; new one does.
    expect(() => unwrapPrivateKey(s, PASSWORD, state.record!)).toThrow(/wrong password/i);
    const priv = unwrapPrivateKey(s, "a brand new password", state.record!);
    // Same keypair → old mail still opens.
    expect(openString(s, state.record!.publicKey, priv, sealed)).toBe("minutes from before the change");
    // The pre-existing recovery key still rescues the (unchanged) private key.
    const recovered = recoverPrivateKey(s, b64ToBytes(s, recoveryKeyB64), state.record!);
    expect(bytesToB64(s, recovered)).toBe(bytesToB64(s, priv));
  });

  it("throws on the wrong old password", async () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD);
    const { store } = fakeStore(record);
    await expect(changeMailboxPassword(s, store, "not the password", "whatever")).rejects.toThrow(/wrong password/i);
  });

  it("throws when there is no key record to re-wrap", async () => {
    const { store } = fakeStore(null);
    await expect(changeMailboxPassword(s, store, PASSWORD, "new")).rejects.toThrow(/no mailbox keys/i);
  });
});
