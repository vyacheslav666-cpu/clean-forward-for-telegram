import { describe, expect, it } from "vitest";
import {
  findActiveComposerContext,
  isActivePeer,
} from "../../src/telegram/TelegramComposerDom";

function installMainChat(peerKey: string, options: {
  readonly active?: boolean;
  readonly hiddenOwner?: boolean;
} = {}): HTMLElement {
  let column = document.querySelector<HTMLElement>("#column-center");
  if (!column) {
    column = document.createElement("section");
    column.id = "column-center";
    const chats = document.createElement("div");
    chats.className = "chats-container";
    column.append(chats);
    document.body.append(column);
  }
  const chat = document.createElement("div");
  chat.className = `chat tabs-tab${options.active === false ? "" : " active"}`;
  const owner = document.createElement("div");
  owner.className = `chat-input chat-input-main${options.hiddenOwner ? " is-hidden" : ""}`;
  const composer = document.createElement("div");
  composer.className = "input-message-input";
  composer.setAttribute("contenteditable", "true");
  composer.dataset.peerId = peerKey;
  owner.append(composer);
  chat.append(owner);
  column.querySelector(".chats-container")!.append(chat);
  return composer;
}

describe("TelegramComposerDom", () => {
  it("scopes ownership to the one active main chat and ignores stale mounted chats", () => {
    installMainChat("old-peer", { active: false });
    const expected = installMainChat("target-peer");

    const context = findActiveComposerContext();
    expect(context?.composer).toBe(expected);
    expect(context?.peerId).toBe("target-peer");
    expect(context?.chat?.classList.contains("active")).toBe(true);
    expect(isActivePeer("target-peer")).toBe(true);
    expect(isActivePeer("old-peer")).toBe(false);
  });

  it("fails closed when two main chats claim to be active", () => {
    installMainChat("one");
    installMainChat("two");
    expect(findActiveComposerContext()).toBeNull();
  });

  it("rejects a composer whose owner is hidden", () => {
    installMainChat("target-peer", { hiddenOwner: true });
    expect(findActiveComposerContext()).toBeNull();
  });
});
