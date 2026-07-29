// Mailbox encryption primitives ("even the admin can't read your mail").
//
// Envelope encryption hung on the one secret the admin never has — the user's
// password (Cognito stores only an SRP verifier). See docs/mailbox-encryption-design.md.
//
//   password P ──Argon2id(salt)──▶ master key MK
//   mailbox keypair (pub, priv) generated client-side on first login
//   wrapped priv  WPK = secretbox(MK, priv)         ← stored; useless without P
//   per message:  CK = random; ct = secretbox(CK, plaintext)
//                 wrappedKey = box_seal(pub, CK)    ← sender needs only pub
//   read: MK = Argon2id(P,salt) → priv = open(WPK) → CK = seal_open(priv) → plaintext
//
// This module is BINDING-AGNOSTIC: it never imports a sodium implementation.
// Each platform injects a ready libsodium instance — `libsodium-wrappers` on the
// Node Lambda / web / Tauri desktop, `react-native-libsodium` on mobile — so the
// exact same algorithms run everywhere. Crypto is composed only from libsodium
// primitives (Argon2id, X25519 sealed boxes, XSalsa20-Poly1305 secretbox); nothing
// is hand-rolled.

/** The subset of the libsodium API this module uses. Both `libsodium-wrappers`
 *  and `react-native-libsodium` satisfy it (after their respective `ready`). */
export interface Sodium {
  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_secretbox_KEYBYTES: number;
  crypto_secretbox_NONCEBYTES: number;
  base64_variants: { ORIGINAL: number };
  randombytes_buf(length: number): Uint8Array;
  crypto_pwhash(
    keyLength: number,
    password: Uint8Array | string,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_secretbox_easy(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_secretbox_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  to_base64(input: Uint8Array, variant: number): string;
  from_base64(input: string, variant: number): Uint8Array;
  to_string(bytes: Uint8Array): string;
  from_string(str: string): Uint8Array;
}

/** Argon2id cost parameters. Stored alongside the salt so they can be raised later
 *  without breaking existing wrapped keys. Defaults to INTERACTIVE — safe across
 *  phones, browsers and Lambda; bump for higher-value deployments. */
export interface KdfParams {
  opsLimit: number;
  memLimit: number;
}

export function defaultKdfParams(s: Sodium): KdfParams {
  return { opsLimit: s.crypto_pwhash_OPSLIMIT_INTERACTIVE, memLimit: s.crypto_pwhash_MEMLIMIT_INTERACTIVE };
}

/** A user's public material as stored in the backend. The admin can see all of
 *  this and still cannot read mail — `wrappedPrivateKey` is useless without the
 *  password, and `publicKey` only lets senders *encrypt* to the mailbox. */
export interface MailboxKeyRecord {
  publicKey: string; // base64
  wrappedPrivateKey: string; // base64 — secretbox(MK, priv)
  salt: string; // base64 — Argon2id salt (not secret)
  kdf: KdfParams;
  /** Optional second wrapping under a user-held recovery key (base64). */
  wrappedPrivateKeyRecovery?: string;
}

/** A single encrypted field/message: ciphertext + the content key sealed to a pubkey. */
export interface SealedPayload {
  ciphertext: string; // base64 — secretbox(CK, plaintext)
  wrappedKey: string; // base64 — box_seal(pub, CK)
}

const b64 = (s: Sodium, bytes: Uint8Array) => s.to_base64(bytes, s.base64_variants.ORIGINAL);
const unb64 = (s: Sodium, str: string) => s.from_base64(str, s.base64_variants.ORIGINAL);

/** secretbox with a fresh nonce, stored as nonce ‖ ciphertext. */
function secretboxSeal(s: Sodium, key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of {@link secretboxSeal}. Throws if the key is wrong or the data was tampered. */
function secretboxOpen(s: Sodium, key: Uint8Array, packed: Uint8Array): Uint8Array {
  const n = s.crypto_secretbox_NONCEBYTES;
  if (packed.length < n) throw new Error("ciphertext too short");
  const nonce = packed.subarray(0, n);
  const ct = packed.subarray(n);
  return s.crypto_secretbox_open_easy(ct, nonce, key); // throws on auth failure
}

// ── Key derivation & mailbox keypair ────────────────────────────────────────

export function randomSalt(s: Sodium): Uint8Array {
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

/** Derive the master key (KEK) from the user's password. Deterministic for a given
 *  (password, salt, params) — that's what lets any device re-derive it. */
export function deriveMasterKey(s: Sodium, password: string, salt: Uint8Array, params?: KdfParams): Uint8Array {
  const p = params ?? defaultKdfParams(s);
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES,
    s.from_string(password),
    salt,
    p.opsLimit,
    p.memLimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export function generateMailboxKeypair(s: Sodium): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return s.crypto_box_keypair();
}

/** A high-entropy recovery key (raw bytes). Show it to the user once (base64) and
 *  never store it server-side — only a wrapping of the private key under it. */
export function generateRecoveryKey(s: Sodium): Uint8Array {
  return s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
}

// ── First-login: build the storable key record ──────────────────────────────

/** Create the record stored in the backend on first login. `recoveryKey`, if given,
 *  adds the second wrapping so the user can rescue old mail after a password reset. */
export function createMailboxKeyRecord(
  s: Sodium,
  password: string,
  opts: { recoveryKey?: Uint8Array; params?: KdfParams } = {},
): { record: MailboxKeyRecord; privateKey: Uint8Array } {
  const salt = randomSalt(s);
  const params = opts.params ?? defaultKdfParams(s);
  const mk = deriveMasterKey(s, password, salt, params);
  const { publicKey, privateKey } = generateMailboxKeypair(s);
  const record: MailboxKeyRecord = {
    publicKey: b64(s, publicKey),
    wrappedPrivateKey: b64(s, secretboxSeal(s, mk, privateKey)),
    salt: b64(s, salt),
    kdf: params,
  };
  if (opts.recoveryKey) {
    record.wrappedPrivateKeyRecovery = b64(s, secretboxSeal(s, opts.recoveryKey, privateKey));
  }
  return { record, privateKey };
}

/** Unwrap the private key with the password (used at every login). Throws on wrong password. */
export function unwrapPrivateKey(s: Sodium, password: string, record: MailboxKeyRecord): Uint8Array {
  const mk = deriveMasterKey(s, password, unb64(s, record.salt), record.kdf);
  try {
    return secretboxOpen(s, mk, unb64(s, record.wrappedPrivateKey));
  } catch {
    throw new Error("wrong password");
  }
}

/** Recover the private key with the recovery key (after a forgotten/reset password). */
export function recoverPrivateKey(s: Sodium, recoveryKey: Uint8Array, record: MailboxKeyRecord): Uint8Array {
  if (!record.wrappedPrivateKeyRecovery) throw new Error("no recovery key was set for this mailbox");
  try {
    return secretboxOpen(s, recoveryKey, unb64(s, record.wrappedPrivateKeyRecovery));
  } catch {
    throw new Error("invalid recovery key");
  }
}

/** Re-wrap an already-unwrapped private key under a new password (user-initiated
 *  password change → no data loss; the keypair is preserved). */
export function rewrapPrivateKey(
  s: Sodium,
  privateKey: Uint8Array,
  newPassword: string,
  opts: { recoveryKey?: Uint8Array; params?: KdfParams } = {},
): Pick<MailboxKeyRecord, "wrappedPrivateKey" | "salt" | "kdf" | "wrappedPrivateKeyRecovery"> {
  const salt = randomSalt(s);
  const params = opts.params ?? defaultKdfParams(s);
  const mk = deriveMasterKey(s, newPassword, salt, params);
  const out: Pick<MailboxKeyRecord, "wrappedPrivateKey" | "salt" | "kdf" | "wrappedPrivateKeyRecovery"> = {
    wrappedPrivateKey: b64(s, secretboxSeal(s, mk, privateKey)),
    salt: b64(s, salt),
    kdf: params,
  };
  if (opts.recoveryKey) out.wrappedPrivateKeyRecovery = b64(s, secretboxSeal(s, opts.recoveryKey, privateKey));
  return out;
}

// ── Multi-recipient envelope ─────────────────────────────────────────────────
// One CONTENT KEY (CK) per message. The (large) ciphertext is produced ONCE and
// stored once; only the small CK is sealed separately to each recipient's public
// key. This is what the inbound Lambda needs: a single message addressed to
// several local mailboxes is encrypted a single time, and CK is wrapped per
// recipient. (Single-recipient seal/open below are just the 1-recipient case.)

/** A fresh random content key for one message. */
export function generateContentKey(s: Sodium): Uint8Array {
  return s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
}

/** Encrypt bytes under a content key → base64 (nonce ‖ ciphertext). Store once. */
export function encryptWithContentKey(s: Sodium, contentKey: Uint8Array, plaintext: Uint8Array): string {
  return b64(s, secretboxSeal(s, contentKey, plaintext));
}

/** Inverse of {@link encryptWithContentKey}. Throws if the key is wrong or tampered. */
export function decryptWithContentKey(s: Sodium, contentKey: Uint8Array, ciphertextB64: string): Uint8Array {
  return secretboxOpen(s, contentKey, unb64(s, ciphertextB64));
}

/** Seal a content key to a recipient's PUBLIC key → base64 (anonymous sealed box;
 *  the sender needs no key of its own). Store one wrap per recipient. */
export function wrapContentKey(s: Sodium, recipientPublicKeyB64: string, contentKey: Uint8Array): string {
  return b64(s, s.crypto_box_seal(contentKey, unb64(s, recipientPublicKeyB64)));
}

/** Recover a content key from this recipient's wrap, using their keypair. Throws if
 *  the wrap wasn't sealed to this public key or was tampered. */
export function unwrapContentKey(
  s: Sodium,
  publicKeyB64: string,
  privateKey: Uint8Array,
  wrappedKeyB64: string,
): Uint8Array {
  return s.crypto_box_seal_open(unb64(s, wrappedKeyB64), unb64(s, publicKeyB64), privateKey);
}

// ── Single-recipient seal / open (envelope with one wrap) ─────────────────────

/** Encrypt raw bytes to ONE recipient's public key. */
export function sealBytes(s: Sodium, recipientPublicKeyB64: string, plaintext: Uint8Array): SealedPayload {
  const ck = generateContentKey(s);
  return {
    ciphertext: encryptWithContentKey(s, ck, plaintext),
    wrappedKey: wrapContentKey(s, recipientPublicKeyB64, ck),
  };
}

/** Encrypt a string (body, subject, …) to ONE recipient's public key. */
export function sealString(s: Sodium, recipientPublicKeyB64: string, plaintext: string): SealedPayload {
  return sealBytes(s, recipientPublicKeyB64, s.from_string(plaintext));
}

/** Open a {@link SealedPayload} back to raw bytes. Throws if the data was tampered. */
export function openBytes(s: Sodium, publicKeyB64: string, privateKey: Uint8Array, payload: SealedPayload): Uint8Array {
  const ck = unwrapContentKey(s, publicKeyB64, privateKey, payload.wrappedKey);
  return decryptWithContentKey(s, ck, payload.ciphertext);
}

/** Open a {@link SealedPayload} back to a string, using the recipient's keypair. */
export function openString(s: Sodium, publicKeyB64: string, privateKey: Uint8Array, payload: SealedPayload): string {
  return s.to_string(openBytes(s, publicKeyB64, privateKey, payload));
}

// ── Encoding helpers (for showing/storing the recovery key) ──────────────────

export const bytesToB64 = b64;
export const b64ToBytes = unb64;

// ── Backend storage ──────────────────────────────────────────────────────────

/** Settings-table partition key holding a mailbox's {@link MailboxKeyRecord}.
 *  Stored under every owned address so the inbound-processor can find the public
 *  key to seal to, no matter which alias received the mail. */
export function mailboxKeysKey(address: string): string {
  return `keys#${address.trim().toLowerCase()}`;
}

/** Validate an untrusted value as a {@link MailboxKeyRecord} (the access-api PUT
 *  path — the client uploads this on first login / password change). */
export function isMailboxKeyRecord(x: unknown): x is MailboxKeyRecord {
  const r = x as Partial<MailboxKeyRecord> | null;
  if (!r || typeof r !== "object") return false;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!str(r.publicKey) || !str(r.wrappedPrivateKey) || !str(r.salt)) return false;
  if (!r.kdf || typeof r.kdf.opsLimit !== "number" || typeof r.kdf.memLimit !== "number") return false;
  if (r.wrappedPrivateKeyRecovery !== undefined && !str(r.wrappedPrivateKeyRecovery)) return false;
  return true;
}
