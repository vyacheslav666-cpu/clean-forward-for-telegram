import { describe, expect, it, vi } from "vitest";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger } from "../helpers";

function installActiveChat(
  peerKey: string,
  title: string | null,
  draft = "",
): { readonly chat: HTMLElement; readonly message: HTMLElement; readonly title: HTMLElement | null } {
  const center = document.createElement("div");
  center.id = "column-center";
  const chats = document.createElement("div");
  chats.className = "chats-container";
  const chat = document.createElement("div");
  chat.className = "chat tabs-tab active";
  let titleNode: HTMLElement | null = null;
  if (title !== null) {
    const topbar = document.createElement("div");
    topbar.className = "topbar";
    titleNode = document.createElement("span");
    titleNode.className = "peer-title";
    titleNode.textContent = title;
    topbar.append(titleNode);
    chat.append(topbar);
  }
  const message = document.createElement("div");
  message.className = "bubble";
  message.dataset.peerId = peerKey;
  message.dataset.mid = "10";
  message.innerHTML = '<div class="message">source fixture</div>';
  const owner = document.createElement("div");
  owner.className = "chat-input chat-input-main";
  const composer = document.createElement("div");
  composer.className = "input-message-input";
  composer.setAttribute("contenteditable", "true");
  composer.dataset.peerId = peerKey;
  composer.textContent = draft;
  owner.append(composer);
  chat.append(message, owner);
  chats.append(chat);
  center.append(chats);
  document.body.append(center);
  return { chat, message, title: titleNode };
}

function installNativeSearch(peerKey: string, query: string, title: string): HTMLInputElement {
  const column = document.createElement("div");
  column.id = "column-left";
  const header = document.createElement("div");
  header.className = "sidebar-header";
  const input = document.createElement("input");
  input.className = "input-search-input";
  input.type = "text";
  input.value = query;
  header.append(input);
  const container = document.createElement("div");
  container.id = "search-container";
  const results = document.createElement("div");
  results.className = "search-super-content-chats";
  const row = document.createElement("a");
  row.className = "row chatlist-chat";
  row.dataset.peerId = peerKey;
  row.innerHTML = `<span class="peer-title">${title}</span>`;
  results.append(row);
  container.append(results);
  column.append(header, container);
  document.body.append(column);
  return input;
}

describe("immutable Telegram source target", () => {
  it("captures the active title and the exact native query that currently resolves its peer", () => {
    const fixture = installActiveChat("20", "Original source");
    installNativeSearch("20", "@exact_source", "Original source");
    const target = new TelegramDomAdapter(createLogger()).readSourceTargetSnapshot(
      "20",
      fixture.message,
    );

    expect(target).toEqual({
      peerKey: "20",
      title: "Original source",
      searchQuery: "@exact_source",
    });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("never treats composer draft text as a source title or query", () => {
    const fixture = installActiveChat("20", null, "private unsent draft");
    const target = new TelegramDomAdapter(createLogger()).readSourceTargetSnapshot(
      "20",
      fixture.message,
    );

    expect(target).toEqual({ peerKey: "20", title: null });
  });

  it("rejects a same-peer-looking message mounted outside the exact active main chat", () => {
    const fixture = installActiveChat("20", "Original source");
    const staleChat = document.createElement("div");
    staleChat.className = "chat tabs-tab";
    const stale = document.createElement("div");
    stale.className = "bubble";
    stale.dataset.peerId = "20";
    stale.dataset.mid = "11";
    stale.innerHTML = '<div class="message">stale fixture</div>';
    staleChat.append(stale);
    fixture.chat.parentElement!.append(staleChat);
    const dom = new TelegramDomAdapter(createLogger());

    expect(dom.readMessageSnapshot(stale, "20")).toBeNull();
    expect(dom.readSourceTargetSnapshot("20", stale)).toBeNull();
  });

  it("binds a context action to the target captured at contextmenu time", () => {
    const fixture = installActiveChat("20", "Original source");
    const input = installNativeSearch("20", "@original_source", "Original source");
    const dom = new TelegramDomAdapter(createLogger());
    dom.startTrackingContextTargets(vi.fn());
    fixture.message.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    input.value = "@later_recipient";
    if (fixture.title) fixture.title.textContent = "Later title";
    const menu = document.createElement("div");
    menu.className = "btn-menu contextmenu active has-items-wrapper";
    menu.innerHTML = '<div class="btn-menu-items"></div>';
    document.body.append(menu);

    expect(dom.findOpenMessageContext()?.sourceTarget).toEqual({
      peerKey: "20",
      title: "Original source",
      searchQuery: "@original_source",
    });
    dom.stopTrackingContextTargets();
  });
});
