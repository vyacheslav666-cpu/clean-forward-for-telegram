import { vi } from "vitest";
import {
  createMessagePayload,
  migrateTelegramDeliveryPayload,
  type MessagePayload,
} from "../src/domain/MessagePayload";
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
} from "../src/domain/SourceMessageDescriptor";
import type { TelegramDeliveryPayload } from "../src/domain/TelegramDeliveryPayload";
import { createPlainTextContent } from "../src/domain/TransferableContent";
import { createTextTransferUnit } from "../src/domain/TransferUnit";
import type { Logger } from "../src/utils/logger";

const FIXTURE_SOURCE_PEER = "fixture-source";
const FIXTURE_SOURCE_MID = 1;

export function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Builds a deterministic generalized source bundle around an existing delivery fixture. */
export function createMessagePayloadFixture(
  payload: TelegramDeliveryPayload,
  peerKey = FIXTURE_SOURCE_PEER,
): MessagePayload {
  return migrateTelegramDeliveryPayload({
    operationId: `fixture-operation-${peerKey}`,
    source: createSourceChatDescriptor(peerKey, "Fixture source"),
    message: createSourceMessageDescriptor({
      resolution: "telegram-model",
      sourcePeerKey: peerKey,
      mid: FIXTURE_SOURCE_MID,
      date: 1,
      order: 0,
    }),
    payload,
    ...(payload.kind === "image" ? { binaryFingerprint: "fixture-image-fingerprint" } : {}),
  });
}

/** Creates the common one-text bundle used by integration fixtures. */
export function createTextMessagePayload(
  text: string,
  peerKey = FIXTURE_SOURCE_PEER,
): MessagePayload {
  return createMessagePayloadFixture({ kind: "text", text }, peerKey);
}

/** Builds an ordered multi-message bundle for sequential delivery regression tests. */
export function createTextBundlePayload(
  texts: readonly string[],
  peerKey = FIXTURE_SOURCE_PEER,
): MessagePayload {
  const source = createSourceChatDescriptor(peerKey, "Fixture source");
  const messages = texts.map((_, index) => createSourceMessageDescriptor({
    resolution: "telegram-model",
    sourcePeerKey: source.peerKey,
    mid: index + 1,
    date: index + 1,
    order: index,
  }));
  return createMessagePayload({
    operationId: "fixture-ordered-bundle",
    source,
    messages,
    units: messages.map((message, index) =>
      createTextTransferUnit([message], createPlainTextContent(texts[index]!))),
  });
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
