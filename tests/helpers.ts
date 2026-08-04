import { vi } from "vitest";
import type { Logger } from "../src/utils/logger";

export function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function installComposer(peerId: string, text = ""): HTMLElement {
  const container = document.createElement("div");
  container.className = "chat-input-main";
  const composer = document.createElement("div");
  composer.className = "input-message-input";
  composer.setAttribute("contenteditable", "true");
  composer.dataset.peerId = peerId;
  composer.textContent = text;
  container.append(composer);
  document.body.append(container);
  return composer;
}

export function installDialogRow(peerId: string, title = "Chat"): HTMLElement {
  let list = document.querySelector<HTMLElement>("ul.chatlist");
  if (!list) {
    const tab = document.createElement("div");
    tab.className = "tabs-tab chatlist-parts active";
    list = document.createElement("ul");
    list.className = "chatlist virtual-chatlist";
    tab.append(list);
    document.body.append(tab);
  }
  const row = document.createElement("a");
  row.className = "row chatlist-chat";
  row.dataset.peerId = peerId;
  const titleNode = document.createElement("span");
  titleNode.className = "peer-title";
  titleNode.textContent = title;
  row.append(titleNode);
  list.append(row);
  return row;
}
