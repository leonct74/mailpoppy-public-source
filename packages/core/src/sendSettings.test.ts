import { describe, it, expect } from "vitest";
import {
  sendSettingsKey,
  normalizeSendSettings,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MIN_MAX_ATTACHMENT_BYTES,
  MAX_MAX_ATTACHMENT_BYTES,
} from "./sendSettings";

const MB = 1024 * 1024;

describe("send settings", () => {
  it("uses one global settings key", () => {
    expect(sendSettingsKey()).toBe("settings#send");
  });

  it("defaults to 10 MB when unset or invalid", () => {
    expect(normalizeSendSettings(undefined).maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(normalizeSendSettings(null).maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(normalizeSendSettings({}).maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
    expect(normalizeSendSettings({ maxAttachmentBytes: NaN }).maxAttachmentBytes).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES,
    );
    expect(normalizeSendSettings({ maxAttachmentBytes: -5 }).maxAttachmentBytes).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES,
    );
  });

  it("keeps a valid in-range value", () => {
    expect(normalizeSendSettings({ maxAttachmentBytes: 15 * MB }).maxAttachmentBytes).toBe(15 * MB);
  });

  it("clamps below the minimum and above the SES ceiling", () => {
    expect(normalizeSendSettings({ maxAttachmentBytes: 100 }).maxAttachmentBytes).toBe(
      MIN_MAX_ATTACHMENT_BYTES,
    );
    expect(normalizeSendSettings({ maxAttachmentBytes: 999 * MB }).maxAttachmentBytes).toBe(
      MAX_MAX_ATTACHMENT_BYTES,
    );
  });
});
