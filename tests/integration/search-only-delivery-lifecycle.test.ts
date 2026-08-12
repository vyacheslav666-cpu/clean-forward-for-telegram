import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { TransferUnit } from "../../src/domain/TransferUnit";
import type { Recipient } from "../../src/recipient/Recipient";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { findActiveComposerContext } from "../../src/telegram/TelegramComposerDom";
import { TelegramRecipientSourceAdapter } from "../../src/telegram/TelegramRecipientSourceAdapter";
import type { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";
import { createLogger, createTextMessagePayload } from "../helpers";

const source: Recipient = { peerKey: "30", title: "Source fixture", supported: true };
const first: Recipient = {
  peerKey: "10",
  title: "First display",
  searchQuery: "@first_fixture",
  supported: true,
};
const second: Recipient = {
  peerKey: "20",
  title: "Second display",
  searchQuery: "@second_fixture",
  supported: true,
};

function installMainChat(peerKey: string): void {
  document.querySelector("#column-center")?.remove();
  const column = document.createElement("section");
  column.id = "column-center";
  const chats = document.createElement("div");
  chats.className = "chats-container";
  const chat = document.createElement("div");
  chat.className = "chat tabs-tab active";
  const owner = document.createElement("div");
  owner.className = "chat-input chat-input-main";
  const composer = document.createElement("div");
  composer.className = "input-message-input";
  composer.setAttribute("contenteditable", "true");
  composer.dataset.peerId = peerKey;
  owner.append(composer);
  chat.append(owner);
  chats.append(chat);
  column.append(chats);
  document.body.append(column);
}

function installNativeSearch(): void {
  const column = document.createElement("aside");
  column.id = "column-left";
  const main = document.createElement("div");
  main.className = "sidebar-slider-item item-main";
  const header = document.createElement("div");
  header.className = "sidebar-header";
  const back = document.createElement("button");
  back.className = "sidebar-back-button";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "input-search-input";
  header.append(back, input);
  const searchContainer = document.createElement("div");
  searchContainer.id = "search-container";
  const results = document.createElement("div");
  results.className = "search-super-content-chats";
  searchContainer.append(results);
  main.append(header, searchContainer);
  column.append(main);
  document.body.append(column);

  input.addEventListener("focus", () => main.classList.add("is-search-active"));
  back.addEventListener("click", () => main.classList.remove("is-search-active"));
  input.addEventListener("input", () => {
    results.replaceChildren();
    const byQuery: Record<string, Recipient> = {
      "@first_fixture": first,
      "@second_fixture": second,
      "Source fixture": source,
    };
    const recipient = byQuery[input.value];
    if (!recipient) {
      return;
    }
    const row = document.createElement("a");
    row.className = "row chatlist-chat";
    row.dataset.peerId = recipient.peerKey;
    const title = document.createElement("span");
    title.className = "peer-title";
    title.textContent = recipient.title;
    row.append(title);
    row.addEventListener("mousedown", () => {
      // TWeb's autonomous search row disappears as close-search starts; peer readiness lands later.
      results.replaceChildren();
      main.classList.remove("is-search-active");
      input.value = "";
      window.setTimeout(() => installMainChat(recipient.peerKey), 30);
    });
    results.append(row);
  });
}

describe("search-only delivery lifecycle", () => {
  it("delivers two one-shot search targets exactly once and restores source through the same navigator", async () => {
    installMainChat(source.peerKey);
    installNativeSearch();
    const log = createLogger();
    const recipientSource = new TelegramRecipientSourceAdapter();
    const navigator = new TelegramChatNavigator(log, recipientSource);
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("captured payload", source.peerKey));
    const preparedPeers: string[] = [];
    const sentPeers: string[] = [];
    const composer = {
      beginDraftTransaction: vi.fn((peerKey: string) => ({
        success: true as const,
        message: "snapshotted",
        transaction: {
          peerKey,
          hadDraft: false,
          restore: vi.fn(async () => ({ success: true as const, message: "restored" })),
        },
      })),
      prepareUnit: vi.fn(async (_unit: TransferUnit, peerKey: string) => {
        expect(findActiveComposerContext()?.peerId).toBe(peerKey);
        preparedPeers.push(peerKey);
        return { success: true as const, message: "prepared" };
      }),
      cancelPreparedUnit: vi.fn(async () => true),
    } as unknown as ComposerAdapter;
    const sender = {
      sendPreparedUnit: vi.fn(async (
        _unit: TransferUnit,
        peerKey: string,
        _signal: AbortSignal,
        onSendClicked: () => void,
      ) => {
        expect(findActiveComposerContext()?.peerId).toBe(peerKey);
        sentPeers.push(peerKey);
        onSendClicked();
        return { status: "sent" as const, messageId: `mid-${peerKey}` };
      }),
      notifyDomChanged: vi.fn(),
    } as unknown as TelegramSendAdapter;
    const progress = {
      show: vi.fn(), update: vi.fn(), hide: vi.fn(),
    } as unknown as DeliveryProgressPanel;
    const config: AppConfig = { debug: { showDeliveryResultDialog: true } };
    const coordinator = new DeliveryCoordinator(
      navigator,
      composer,
      sender,
      pending,
      progress,
      log,
      config,
    );

    const run = coordinator.start([first, second], source);
    if (!run) throw new Error("Lifecycle batch did not start");
    const result = await run;

    expect(preparedPeers).toEqual(["10", "20"]);
    expect(sentPeers).toEqual(["10", "20"]);
    expect(new Set(sentPeers).size).toBe(2);
    expect(result.sentCount).toBe(2);
    expect(result.unknownCount).toBe(0);
    expect(result.safetyFailure).toBeUndefined();
    expect(findActiveComposerContext()?.peerId).toBe(source.peerKey);
  }, 10_000);
});
