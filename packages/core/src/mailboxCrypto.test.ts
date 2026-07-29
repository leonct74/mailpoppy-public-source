import { describe, it, expect, beforeAll } from "vitest";
import _sodium from "libsodium-wrappers-sumo";
import {
  type Sodium,
  type SealedPayload,
  createMailboxKeyRecord,
  unwrapPrivateKey,
  recoverPrivateKey,
  rewrapPrivateKey,
  generateRecoveryKey,
  deriveMasterKey,
  randomSalt,
  sealString,
  sealBytes,
  openString,
  openBytes,
  bytesToB64,
  mailboxKeysKey,
  isMailboxKeyRecord,
  generateContentKey,
  encryptWithContentKey,
  decryptWithContentKey,
  wrapContentKey,
  unwrapContentKey,
} from "./mailboxCrypto";

// One ready libsodium instance, injected into every binding-agnostic helper.
let s: Sodium;
beforeAll(async () => {
  await _sodium.ready;
  s = _sodium as unknown as Sodium;
});

const PASSWORD = "correct horse battery staple";

describe("mailboxCrypto: password-wrapped key lifecycle", () => {
  it("round-trips: correct password unwraps the private key; record is all base64", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    // Everything stored is base64 (admin-visible, useless without the password).
    expect(record.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(record.wrappedPrivateKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(record.salt.length).toBeGreaterThan(0);
    const unwrapped = unwrapPrivateKey(s, PASSWORD, record);
    expect(bytesToB64(s, unwrapped)).toBe(bytesToB64(s, privateKey));
  });

  it("rejects the wrong password (the admin holds the verifier, not the password)", () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD);
    expect(() => unwrapPrivateKey(s, "not the password", record)).toThrow(/wrong password/i);
  });

  it("user-initiated password change preserves the keypair → no data loss on old mail", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    // Encrypt some mail under the original public key.
    const sealed = sealString(s, record.publicKey, "minutes from the old meeting");

    // Change password (knowing the old one) → re-wrap the SAME private key.
    const priv = unwrapPrivateKey(s, PASSWORD, record);
    const rewrapped = rewrapPrivateKey(s, priv, "a brand new password");
    const updated = { ...record, ...rewrapped };

    expect(() => unwrapPrivateKey(s, PASSWORD, updated)).toThrow(/wrong password/i); // old password no longer works
    const priv2 = unwrapPrivateKey(s, "a brand new password", updated);
    expect(bytesToB64(s, priv2)).toBe(bytesToB64(s, privateKey));
    // Old mail still opens — the keypair didn't change.
    expect(openString(s, updated.publicKey, priv2, sealed)).toBe("minutes from the old meeting");
  });
});

describe("mailboxCrypto: recovery key (rescue old mail without a backdoor)", () => {
  it("recovers the private key after a forgotten password", () => {
    const recoveryKey = generateRecoveryKey(s);
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD, { recoveryKey });
    const recovered = recoverPrivateKey(s, recoveryKey, record);
    expect(bytesToB64(s, recovered)).toBe(bytesToB64(s, privateKey));
  });

  it("rejects a wrong recovery key", () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD, { recoveryKey: generateRecoveryKey(s) });
    expect(() => recoverPrivateKey(s, generateRecoveryKey(s), record)).toThrow(/invalid recovery key/i);
  });

  it("throws if no recovery key was ever set (none-policy mailbox)", () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD);
    expect(() => recoverPrivateKey(s, generateRecoveryKey(s), record)).toThrow(/no recovery key/i);
  });
});

describe("mailboxCrypto: per-message seal/open", () => {
  it("seals a string to a public key and opens it with the private key", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    const payload = sealString(s, record.publicKey, "Subject: Q3 numbers");
    expect(payload.ciphertext).not.toContain("Q3");
    expect(openString(s, record.publicKey, privateKey, payload)).toBe("Subject: Q3 numbers");
  });

  it("seals and opens raw bytes (attachments)", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    const blob = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const payload = sealBytes(s, record.publicKey, blob);
    expect(Array.from(openBytes(s, record.publicKey, privateKey, payload))).toEqual(Array.from(blob));
  });

  it("rejects tampered ciphertext (authenticated encryption)", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    const payload = sealString(s, record.publicKey, "do not modify me");
    const raw = b64ToBytesLocal(payload.ciphertext);
    raw[raw.length - 1] ^= 0x01; // flip a bit
    const tampered: SealedPayload = { ...payload, ciphertext: bytesToB64(s, raw) };
    expect(() => openString(s, record.publicKey, privateKey, tampered)).toThrow();
  });

  it("a different mailbox's key cannot open the payload", () => {
    const a = createMailboxKeyRecord(s, PASSWORD);
    const b = createMailboxKeyRecord(s, "different user");
    const payload = sealString(s, a.record.publicKey, "for A only");
    expect(() => openString(s, b.record.publicKey, b.privateKey, payload)).toThrow();
  });

  function b64ToBytesLocal(str: string): Uint8Array {
    return _sodium.from_base64(str, _sodium.base64_variants.ORIGINAL);
  }
});

describe("mailboxCrypto: multi-recipient envelope", () => {
  it("encrypts once and lets every wrapped recipient decrypt the SAME ciphertext", () => {
    // A message to two local mailboxes: one content key, one ciphertext, two wraps.
    const a = createMailboxKeyRecord(s, "alice");
    const b = createMailboxKeyRecord(s, "bob");
    const ck = generateContentKey(s);
    const ciphertext = encryptWithContentKey(s, ck, s.from_string("the shared message body"));
    const wrapA = wrapContentKey(s, a.record.publicKey, ck);
    const wrapB = wrapContentKey(s, b.record.publicKey, ck);

    const ckA = unwrapContentKey(s, a.record.publicKey, a.privateKey, wrapA);
    const ckB = unwrapContentKey(s, b.record.publicKey, b.privateKey, wrapB);
    expect(s.to_string(decryptWithContentKey(s, ckA, ciphertext))).toBe("the shared message body");
    expect(s.to_string(decryptWithContentKey(s, ckB, ciphertext))).toBe("the shared message body");
  });

  it("a recipient cannot open another recipient's wrap", () => {
    const a = createMailboxKeyRecord(s, "alice");
    const b = createMailboxKeyRecord(s, "bob");
    const ck = generateContentKey(s);
    const wrapA = wrapContentKey(s, a.record.publicKey, ck);
    // Bob's keypair can't open the wrap that was sealed to Alice.
    expect(() => unwrapContentKey(s, b.record.publicKey, b.privateKey, wrapA)).toThrow();
  });

  it("rejects a tampered ciphertext under the right content key", () => {
    const ck = generateContentKey(s);
    const ct = encryptWithContentKey(s, ck, s.from_string("do not modify"));
    const raw = _sodium.from_base64(ct, _sodium.base64_variants.ORIGINAL);
    raw[raw.length - 1] ^= 0x01;
    const tampered = _sodium.to_base64(raw, _sodium.base64_variants.ORIGINAL);
    expect(() => decryptWithContentKey(s, ck, tampered)).toThrow();
  });

  it("single-recipient sealString is just the one-wrap case (still round-trips)", () => {
    const { record, privateKey } = createMailboxKeyRecord(s, PASSWORD);
    const payload = sealString(s, record.publicKey, "one recipient");
    expect(openString(s, record.publicKey, privateKey, payload)).toBe("one recipient");
  });
});

describe("mailboxCrypto: KDF determinism", () => {
  it("same password+salt → same master key; different salt → different", () => {
    const salt = randomSalt(s);
    const k1 = deriveMasterKey(s, PASSWORD, salt);
    const k2 = deriveMasterKey(s, PASSWORD, salt);
    expect(bytesToB64(s, k1)).toBe(bytesToB64(s, k2));
    const k3 = deriveMasterKey(s, PASSWORD, randomSalt(s));
    expect(bytesToB64(s, k3)).not.toBe(bytesToB64(s, k1));
  });
});

describe("mailboxCrypto: backend storage helpers", () => {
  it("derives a per-mailbox settings key (normalised, namespaced)", () => {
    expect(mailboxKeysKey("Demo@Youord.com")).toBe("keys#demo@youord.com");
    expect(mailboxKeysKey(" a@b.io ")).toBe("keys#a@b.io");
  });

  it("accepts a real record and rejects malformed ones (the PUT validator)", () => {
    const { record } = createMailboxKeyRecord(s, PASSWORD);
    expect(isMailboxKeyRecord(record)).toBe(true);
    expect(isMailboxKeyRecord({ ...record, recoveryKey: undefined })).toBe(true);

    expect(isMailboxKeyRecord(null)).toBe(false);
    expect(isMailboxKeyRecord({})).toBe(false);
    expect(isMailboxKeyRecord({ ...record, publicKey: "" })).toBe(false);
    expect(isMailboxKeyRecord({ ...record, salt: 123 })).toBe(false);
    expect(isMailboxKeyRecord({ ...record, kdf: { opsLimit: 1 } })).toBe(false);
    expect(isMailboxKeyRecord({ ...record, wrappedPrivateKeyRecovery: 5 })).toBe(false);
  });
});
