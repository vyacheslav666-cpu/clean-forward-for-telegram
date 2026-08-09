import { describe, expect, it, vi } from "vitest";
import { TelegramRecipientSourceAdapter } from "../../src/telegram/TelegramRecipientSourceAdapter";
import { installDialogRow } from "../helpers";

describe("TelegramRecipientSourceAdapter", () => {
  function installNativeSearch(
    onQuery: (query: string, results: HTMLElement) => void,
  ): { readonly results: HTMLElement } {
    const column = document.createElement("div");
    column.id = "column-left";
    const main = document.createElement("div");
    main.className = "sidebar-slider-item item-main active";
    const header = document.createElement("div");
    header.className = "sidebar-header";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "input-search-input";
    const back = document.createElement("div");
    back.className = "sidebar-back-button";
    header.append(input, back);
    const searchContainer = document.createElement("div");
    searchContainer.id = "search-container";
    const results = document.createElement("div");
    results.className = "search-super-content-container search-super-content-chats";
    searchContainer.append(results);
    main.append(header, searchContainer);
    column.append(main);
    document.body.append(column);
    input.addEventListener("focus", () => main.classList.add("is-search-active"));
    back.addEventListener("click", () => main.classList.remove("is-search-active"));
    input.addEventListener("input", () => onQuery(input.value, results));
    return { results };
  }

  function appendSearchRow(container: HTMLElement, peerKey: string, title: string): void {
    const list = document.createElement("ul");
    list.className = "chatlist";
    const row = document.createElement("a");
    row.className = "row chatlist-chat";
    row.dataset.peerId = peerKey;
    const peerTitle = document.createElement("span");
    peerTitle.className = "peer-title";
    peerTitle.textContent = title;
    row.append(peerTitle);
    list.append(row);
    container.append(list);
  }

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

  it("finds a recipient through native search when it is absent from visible recent rows", async () => {
    installDialogRow("42", "Visible recent");
    const nativeSearch = installNativeSearch((query, results) => {
      if (query === "Remote fixture") {
        appendSearchRow(results, "99", "Remote fixture");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "Remote fixture",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["99"]),
    );
    appendSearchRow(nativeSearch.results, "100", "Later remote fixture");
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["99", "100"]),
    );
  });

  it("keeps the first search alive when Telegram replaces its input during activation", async () => {
    installNativeSearch((query, results) => {
      const original = document.querySelector<HTMLInputElement>(
        "#column-left .sidebar-header input.input-search-input",
      )!;
      const replacement = original.cloneNode() as HTMLInputElement;
      replacement.value = query;
      original.replaceWith(replacement);
      original.value = "";
      appendSearchRow(results, "99", "Remote after activation");
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "remote_username",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["99"]),
    );
  });

  it("restores Telegram recent view when project search is cleared", () => {
    installNativeSearch(() => undefined);
    const adapter = new TelegramRecipientSourceAdapter();
    const controller = new AbortController();
    adapter.searchRecipients("remote", controller.signal, () => undefined);
    const main = document.querySelector("#column-left .sidebar-slider-item.item-main")!;
    expect(main.classList.contains("is-search-active")).toBe(true);

    adapter.clearSearch();
    expect(main.classList.contains("is-search-active")).toBe(false);
    expect(document.querySelector<HTMLInputElement>(".input-search-input")?.value).toBe("");
  });

  it("finds Saved Messages through native search by its stable self peer key", async () => {
    installNativeSearch((query, results) => {
      if (query === "Saved Messages") {
        appendSearchRow(results, "5015040583", "Saved Messages");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "Saved Messages",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() => expect(updates[updates.length - 1]).toMatchObject([
      { peerKey: "5015040583", title: "Saved Messages", supported: true },
    ]));
  });
});
