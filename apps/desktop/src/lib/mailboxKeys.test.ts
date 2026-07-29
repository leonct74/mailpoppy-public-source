// @vitest-environment node
// libsodium's from_string() uses TextEncoder; under jsdom that returns a
// cross-realm Uint8Array that libsodium's instanceof checks reject ("unsupported
// input type"). This crypto-only test needs no DOM, so run it in node (the Tauri
// webview is a single realm, so production is unaffected).
import { describe, it, expect, beforeEach } from "vitest";
import _sodium from "libsodium-wrappers-sumo";
import {
  generateContentKey,
  encryptWithContentKey,
  wrapContentKey,
  type Sodium,
  type MailboxKeyRecord,
} from "@mailpoppy/core";
import {
  establishMailboxKeysForLogin,
  getMailboxKeySession,
  clearMailboxKeySession,
  decryptEml,
  decryptAttachmentBytes,
} from "./mailboxKeys";

let s: Sodium;
beforeEach(async () => {
  await _sodium.ready;
  s = _sodium as unknown as Sodium;
  clearMailboxKeySession();
});

/** In-memory backend (GET/PUT /mailbox-keys). */
function fakeStore() {
  let record: MailboxKeyRecord | null = null;
  return {
    getMailboxKeys: async () => ({ record }),
    putMailboxKeys: async (r: MailboxKeyRecord) => {
      record = r;
      return { ok: true };
    },
  };
}

/** Seal a payload to a pubkey the way the inbound Lambda does, returning the
 *  {encWrappedKey, ciphertext} a client would receive. */
function sealForMailbox(publicKey: string, plaintext: Uint8Array) {
  const ck = generateContentKey(s);
  return { encWrappedKey: wrapContentKey(s, publicKey, ck), ciphertext: encryptWithContentKey(s, ck, plaintext) };
}

describe("desktop mailboxKeys read path", () => {
  it("decrypts an .eml sealed to the signed-in mailbox", async () => {
    await establishMailboxKeysForLogin(fakeStore(), "hunter2");
    const pub = getMailboxKeySession()!.publicKey;
    const eml = "Subject: hi\r\n\r\nthe secret body";
    const { encWrappedKey, ciphertext } = sealForMailbox(pub, s.from_string(eml));

    const out = await decryptEml({ encrypted: true, encWrappedKey }, ciphertext);
    expect(out).toBe(eml);
  });

  it("decrypts an attachment sealed to the signed-in mailbox", async () => {
    await establishMailboxKeysForLogin(fakeStore(), "hunter2");
    const pub = getMailboxKeySession()!.publicKey;
    const blob = new Uint8Array([0, 1, 2, 250, 255]);
    const { encWrappedKey, ciphertext } = sealForMailbox(pub, blob);

    const out = await decryptAttachmentBytes({ encrypted: true, encWrappedKey }, ciphertext);
    expect(Array.from(out)).toEqual(Array.from(blob));
  });

  it("passes plaintext mail straight through (no encryption)", async () => {
    await establishMailboxKeysForLogin(fakeStore(), "hunter2");
    const eml = "Subject: clear\r\n\r\nnot encrypted";
    expect(await decryptEml({ encrypted: false }, eml)).toBe(eml);
    expect(await decryptEml({}, eml)).toBe(eml);
  });

  it("throws a locked-mailbox error when signed out", async () => {
    await establishMailboxKeysForLogin(fakeStore(), "hunter2");
    const pub = getMailboxKeySession()!.publicKey;
    const { encWrappedKey, ciphertext } = sealForMailbox(pub, s.from_string("body"));
    clearMailboxKeySession();
    await expect(decryptEml({ encrypted: true, encWrappedKey }, ciphertext)).rejects.toThrow(/locked/i);
  });
});
