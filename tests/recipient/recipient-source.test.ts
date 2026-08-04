import { describe, expect, it, vi } from "vitest";
import { TelegramRecipientSourceAdapter } from "../../src/telegram/TelegramRecipientSourceAdapter";
import { installDialogRow } from "../helpers";

describe("TelegramRecipientSourceAdapter", () => {
  async function readRecipients(): Promise<readonly import("../../src/recipient/Recipient").Recipient[]> {
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(16);
    return promise;
  }

  it("deduplicates rows with the same peerId", async () => {
    vi.useFakeTimers();
    installDialogRow("42", "Fixture recipient A");
    installDialogRow("42", "Duplicate fixture");
    installDialogRow("43", "Fixture recipient B");
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.map((recipient) => recipient.peerKey)).toEqual(["42", "43"]);
    expect(result[0]?.title).toBe("Fixture recipient A");
  });

  it("keeps a composite peerId visible but unsupported", async () => {
    vi.useFakeTimers();
    installDialogRow("42_7", "Unsupported fixture");
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject([{ peerKey: "42_7", supported: false }]);
  });

  it("extracts only direct real dialog rows", async () => {
    vi.useFakeTimers();
    installDialogRow("42", "Direct fixture");
    const list = document.querySelector("ul.chatlist")!;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = '<a class="row chatlist-chat" data-peer-id="99"><span class="peer-title">Nested fixture</span></a>';
    list.append(wrapper);
    expect((await readRecipients()).map((recipient) => recipient.peerKey)).toEqual(["42"]);
  });

  it("does not treat nested data-peer-id elements as dialog rows", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("42", "Direct fixture");
    const nested = document.createElement("span");
    nested.dataset.peerId = "777";
    row.append(nested);
    expect((await readRecipients()).map((recipient) => recipient.peerKey)).toEqual(["42"]);
  });

  it("extracts title, subtitle, and avatar", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("42", "Fixture title");
    const subtitle = document.createElement("span");
    subtitle.className = "row-subtitle";
    subtitle.textContent = "Fixture subtitle";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.innerHTML = '<img src="blob:avatar">';
    row.append(subtitle, avatar);
    expect(await readRecipients()).toMatchObject([
      { peerKey: "42", title: "Fixture title", subtitle: "Fixture subtitle", avatarUrl: "blob:avatar" },
    ]);
  });

  it("supports rows without subtitle", async () => {
    vi.useFakeTimers();
    installDialogRow("42", "Fixture without subtitle");
    expect(await readRecipients()).toEqual([
      { peerKey: "42", title: "Fixture without subtitle", supported: true },
    ]);
  });

  it("supports rows without avatar", async () => {
    vi.useFakeTimers();
    installDialogRow("42", "Fixture without avatar");
    expect((await readRecipients())[0]).not.toHaveProperty("avatarUrl");
  });

  it("preserves a composite peerId without numeric conversion", async () => {
    vi.useFakeTimers();
    installDialogRow("42_7", "Composite fixture");
    expect((await readRecipients())[0]?.peerKey).toBe("42_7");
  });

  it("does not log titles or peerIds", async () => {
    vi.useFakeTimers();
    const consoleSpies = [
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    installDialogRow("44", "Sensitive fixture title");
    await readRecipients();
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it("fails safely with a clear error for an empty list", async () => {
    vi.useFakeTimers();
    const tab = document.createElement("div");
    tab.className = "tabs-tab chatlist-parts active";
    tab.innerHTML = '<ul class="chatlist virtual-chatlist"></ul>';
    document.body.append(tab);
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    const rejection = expect(promise).rejects.toThrow("нет загруженных строк диалогов");
    await vi.advanceTimersByTimeAsync(16);
    await rejection;
  });
});
