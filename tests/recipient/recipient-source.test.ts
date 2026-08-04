import { describe, expect, it, vi } from "vitest";
import { TelegramRecipientSourceAdapter } from "../../src/telegram/TelegramRecipientSourceAdapter";
import { installDialogRow } from "../helpers";

describe("TelegramRecipientSourceAdapter", () => {
  it("deduplicates rows with the same peerId", async () => {
    vi.useFakeTimers();
    installDialogRow("42", "First");
    installDialogRow("42", "Duplicate");
    installDialogRow("43", "Other");
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.map((recipient) => recipient.peerKey)).toEqual(["42", "43"]);
    expect(result[0]?.title).toBe("First");
  });

  it("keeps a composite peerId visible but unsupported", async () => {
    vi.useFakeTimers();
    installDialogRow("42_7", "Topic");
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject([{ peerKey: "42_7", supported: false }]);
  });
});
