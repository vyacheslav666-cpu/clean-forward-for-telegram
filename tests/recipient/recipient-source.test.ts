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

  function appendSearchRow(
    container: HTMLElement,
    peerKey: string,
    title: string,
    subtitle?: string,
  ): HTMLElement {
    const list = document.createElement("ul");
    list.className = "chatlist";
    const row = document.createElement("a");
    row.className = "row chatlist-chat";
    row.dataset.peerId = peerKey;
    const peerTitle = document.createElement("span");
    peerTitle.className = "peer-title";
    peerTitle.textContent = title;
    row.append(peerTitle);
    if (subtitle) {
      const subtitleNode = document.createElement("span");
      subtitleNode.className = "row-subtitle";
      const status = document.createElement("span");
      status.className = "i18n";
      status.textContent = subtitle;
      subtitleNode.append(status);
      row.append(subtitleNode);
    }
    list.append(row);
    container.append(list);
    return row;
  }

  function installActiveComposer(row: HTMLElement, contenteditable: "true" | "false"): void {
    row.classList.add("active");
    const composer = document.createElement("div");
    composer.className = "input-message-input";
    composer.dataset.peerId = row.dataset.peerId;
    composer.setAttribute("contenteditable", contenteditable);
    document.body.append(composer);
  }

  async function readRecipients(): Promise<readonly import("../../src/recipient/Recipient").Recipient[]> {
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(16);
    return promise;
  }

  it("snapshots the active source chat without retaining its DOM row", () => {
    const row = installDialogRow("42", "Source chat");
    row.classList.add("active");
    const adapter = new TelegramRecipientSourceAdapter();

    const source = adapter.getActiveRecipient();
    row.remove();

    expect(source).toEqual({ peerKey: "42", title: "Source chat", supported: true });
  });

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

  it("omits a composite peerId instead of presenting an ineligible row", async () => {
    vi.useFakeTimers();
    installDialogRow("42_7", "Unsupported fixture");
    const promise = new TelegramRecipientSourceAdapter().listLoadedRecipients(
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    expect(await promise).toEqual([]);
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

  it("omits sponsored and forum rows", async () => {
    vi.useFakeTimers();
    const sponsored = installDialogRow("42", "Sponsored fixture");
    sponsored.dataset.sponsored = "true";
    const forum = installDialogRow("43", "Forum fixture");
    forum.append(Object.assign(document.createElement("span"), { className: "is-forum" }));
    expect(await readRecipients()).toEqual([]);
  });

  it("omits an explicitly disabled recent row", async () => {
    vi.useFakeTimers();
    const disabled = installDialogRow("42", "Unavailable fixture");
    disabled.setAttribute("aria-disabled", "true");
    expect(await readRecipients()).toEqual([]);
  });

  it("omits an active peer whose Telegram composer is read-only", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("-42", "Read-only channel");
    installActiveComposer(row, "false");
    expect(await readRecipients()).toEqual([]);
  });

  it("omits an active peer whose Telegram composer is hidden", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("-42", "Hidden composer channel");
    installActiveComposer(row, "true");
    document.querySelector<HTMLElement>('.input-message-input[data-peer-id="-42"]')!.style.display =
      "none";
    expect(await readRecipients()).toEqual([]);
  });

  it("keeps an active admin-postable channel with a writable composer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("-42", "Writable channel");
    const subtitle = document.createElement("span");
    subtitle.className = "row-subtitle";
    subtitle.innerHTML = '<span class="i18n">811 subscribers</span>';
    row.append(subtitle);
    installActiveComposer(row, "true");
    expect((await readRecipients()).map((recipient) => recipient.peerKey)).toEqual(["-42"]);
  });

  it("preserves Telegram order while omitting ineligible peers", async () => {
    vi.useFakeTimers();
    installDialogRow("10", "Private A");
    const disabled = installDialogRow("11", "Unavailable");
    disabled.classList.add("is-disabled");
    installDialogRow("-12", "Writable group");
    expect((await readRecipients()).map((recipient) => recipient.peerKey)).toEqual(["10", "-12"]);
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
    expect(updates[updates.length - 1]?.[0]?.searchQuery).toBe("Remote fixture");
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

  it("does not settle search cleanup before Telegram's destruction window", async () => {
    vi.useFakeTimers();
    installNativeSearch(() => undefined);
    const adapter = new TelegramRecipientSourceAdapter();
    adapter.searchRecipients("remote", new AbortController().signal, () => undefined);
    adapter.clearSearch();
    let settled = false;
    const settlement = adapter.waitForSearchSettled(new AbortController().signal)
      .then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(175);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await settlement;
    expect(settled).toBe(true);
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

  it("includes private users and groups but omits read-only broadcasts from search", async () => {
    installNativeSearch((query, results) => {
      if (query === "mixed") {
        appendSearchRow(results, "10", "Private user", "last seen recently");
        appendSearchRow(results, "-11", "Writable group", "62 members");
        appendSearchRow(results, "-12", "Read-only broadcast", "811 subscribers");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "mixed",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["10", "-11"]),
    );
  });

  it("keeps an admin-postable broadcast in search when its active composer is writable", async () => {
    const recent = installDialogRow("-12", "Admin channel");
    installActiveComposer(recent, "true");
    installNativeSearch((query, results) => {
      if (query === "admin") {
        appendSearchRow(results, "-12", "Admin channel", "811 subscribers");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "admin",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["-12"]),
    );
  });

  it("does not let search reintroduce a peer already observed as read-only", async () => {
    const recent = installDialogRow("-12", "Read-only broadcast");
    installActiveComposer(recent, "false");
    installNativeSearch((query, results) => {
      if (query === "broadcast") {
        appendSearchRow(results, "-12", "Read-only broadcast");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    const adapter = new TelegramRecipientSourceAdapter();
    adapter.searchRecipients(
      "broadcast",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() => expect(updates[updates.length - 1]).toEqual([]));
  });

  it("keeps unknown partial search metadata instead of guessing that it is read-only", async () => {
    installNativeSearch((query, results) => {
      if (query === "unknown") {
        appendSearchRow(results, "-99", "Unknown peer");
      }
    });
    const updates: Array<readonly import("../../src/recipient/Recipient").Recipient[]> = [];
    new TelegramRecipientSourceAdapter().searchRecipients(
      "unknown",
      new AbortController().signal,
      (recipients) => updates.push([...recipients]),
    );
    await vi.waitFor(() =>
      expect(updates[updates.length - 1]?.map((item) => item.peerKey)).toEqual(["-99"]),
    );
  });
});
