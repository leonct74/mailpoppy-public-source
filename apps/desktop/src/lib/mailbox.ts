// Desktop client for the sidecar's mailbox (Cognito) endpoints. Mailboxes are
// users in the deployed backend's Cognito user pool; the sidecar resolves the
// pool from the stack's CloudFormation outputs.
import { sidecar } from "./sidecar";
import type { MailboxImportPlan } from "@mailpoppy/core";

export interface Mailbox {
  email: string;
  status: string;
  createdAt?: string;
}

/** The bits the Inbox tab needs to connect to the deployed backend. */
export interface BackendInfo {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
}

export function listMailboxes(
  stackName: string,
): Promise<BackendInfo & { ok: true; mailboxes: Mailbox[] }> {
  return sidecar(`/mailbox/list/${encodeURIComponent(stackName)}`);
}

export function createMailbox(input: {
  email: string;
  password: string;
  stackName?: string;
}): Promise<BackendInfo & { ok: true; mailbox: Mailbox }> {
  return sidecar(`/mailbox/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export interface MailboxDeletion {
  ok: true;
  email: string;
  userDeleted: boolean;
  deletedMessages: number;
  deletedObjects: number;
  freedBytes: number;
}

/** Permanently delete a mailbox: its sign-in user AND all its stored mail. */
export function deleteMailbox(input: { email: string; stackName?: string }): Promise<MailboxDeletion> {
  return sidecar(`/mailbox/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Admin-set a mailbox's sign-in password to a new permanent value. */
export function resetMailboxPassword(input: {
  email: string;
  password: string;
  stackName?: string;
}): Promise<{ ok: true; email: string }> {
  return sidecar(`/mailbox/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---- Bulk import from a spreadsheet ----

/** Read a chosen file as base64 (the sidecar's import/parse endpoint wants that). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.onload = () => {
      // readAsDataURL → "data:<type>;base64,<data>"; keep just the base64 payload.
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Parse + validate an uploaded .xlsx/.csv into a per-row import plan (no writes). */
export function parseMailboxImport(input: {
  domain: string;
  fileBase64: string;
  filename?: string;
}): Promise<{ ok: true; plan: MailboxImportPlan }> {
  return sidecar(`/mailbox/import/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Generate the friendly .xlsx template and save it to the user's machine,
 * returning where it landed. The sidecar writes the file (the webview can't),
 * normally into the Downloads folder.
 */
export function saveMailboxImportTemplate(
  domain: string,
): Promise<{ ok: true; path: string; filename: string; dir: string }> {
  return sidecar(`/mailbox/import/template`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
}
