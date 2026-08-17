/** Locates the one active Telegram composer and its chat-scoped controls. */
import { readTelegramText } from "./readTelegramText";

const ACTIVE_COMPOSER_SELECTOR =
  '.input-message-input[contenteditable="true"][data-peer-id]';
const COMPOSER_CONTAINER_SELECTOR = ".chat-input-main";
const MAIN_CHATS_SELECTOR = "#column-center > .chats-container";
const ACTIVE_MAIN_CHAT_SELECTOR = ":scope > .chat.tabs-tab.active";
const OWNED_COMPOSER_CONTAINER_SELECTOR = ":scope > .chat-input.chat-input-main";
const ACTIVE_DIALOG_ROW_IDENTITY_SELECTOR =
  ".tabs-tab.chatlist-parts.active a.row.chatlist-chat.active[data-peer-id]";
const TOPBAR_PEER_IDENTITY_SELECTOR = ".topbar .person-avatar[data-peer-id]";

/** Verified DOM context for the currently active destination chat. */
export interface TelegramComposerContext {
  readonly composer: HTMLElement;
  readonly container: HTMLElement;
  /** Main active chat pane. Null exists only for isolated test/legacy DOMs without TWeb shell. */
  readonly chat: HTMLElement | null;
  readonly peerId: string;
}

/** Controls how strictly the message input itself must be visible. */
export interface ActiveComposerLookupOptions {
  /**
   * Selection mode hides TWeb's message input while the selection plate owns the same container.
   * Read-only source lookups must still resolve the peer there, so only the composer's own
   * visibility rule is relaxed: containment, uniqueness, and a visible container still apply.
   * Every path that writes into the composer must keep the default strict lookup.
   */
  readonly allowHiddenComposer?: boolean;
}

/** Returns only the real composer owned by TWeb's one active main chat pane. */
export function findActiveComposerContext(
  { allowHiddenComposer = false }: ActiveComposerLookupOptions = {},
): TelegramComposerContext | null {
  const composerHidden = (composer: HTMLElement): boolean =>
    !composer.isConnected || (!allowHiddenComposer && isHidden(composer));
  const mainChats = document.querySelector<HTMLElement>(MAIN_CHATS_SELECTOR);
  if (mainChats) {
    const activeChats = mainChats.querySelectorAll<HTMLElement>(ACTIVE_MAIN_CHAT_SELECTOR);
    if (activeChats.length !== 1) {
      return null;
    }

    const chat = activeChats.item(0);
    const ownedContainers = chat.querySelectorAll<HTMLElement>(OWNED_COMPOSER_CONTAINER_SELECTOR);
    if (ownedContainers.length !== 1) {
      return null;
    }
    const container = ownedContainers.item(0);
    if (isHidden(container)) {
      return null;
    }
    const composers = container.querySelectorAll<HTMLElement>(ACTIVE_COMPOSER_SELECTOR);
    if (composers.length !== 1) {
      return null;
    }
    const composer = composers.item(0);
    const peerId = composer.dataset.peerId?.trim() ?? "";
    if (
      !peerId ||
      composer.closest(".chat") !== chat ||
      composerHidden(composer) ||
      composer.getAttribute("aria-disabled") === "true"
    ) {
      return null;
    }
    return { composer, container, chat, peerId };
  }

  // Isolated fixtures and older shells have no main-chat root. Keep the same fail-closed
  // uniqueness rule there; production TWeb always takes the scoped branch above.
  const composers = document.querySelectorAll<HTMLElement>(ACTIVE_COMPOSER_SELECTOR);
  if (composers.length !== 1) {
    return null;
  }

  const composer = composers.item(0);
  const container = composer.closest<HTMLElement>(COMPOSER_CONTAINER_SELECTOR);
  const peerId = composer.dataset.peerId;
  if (!container || !peerId) {
    return null;
  }

  if (composerHidden(composer) || isHidden(container)) {
    return null;
  }

  return { composer, container, chat: null, peerId };
}

/** Confirms that Telegram still points at the peer captured before an async operation. */
export function isActivePeer(peerId: string): boolean {
  return findActiveComposerContext()?.peerId === peerId;
}

/**
 * Requires production peer identity independent from the composer binding.
 *
 * TWeb can retain a stale composer briefly while another chat already owns the visible topbar.
 * Search-only chats may have no active sidebar row, so a same-chat topbar avatar is the fallback.
 */
export function hasIndependentActivePeerProof(
  context: TelegramComposerContext,
  expectedPeerId: string,
): boolean {
  if (!context.chat) {
    return true;
  }

  const activeRows = Array.from(
    document.querySelectorAll<HTMLElement>(ACTIVE_DIALOG_ROW_IDENTITY_SELECTOR),
  );
  if (activeRows.length === 1 && activeRows[0]?.dataset.peerId === expectedPeerId) {
    return true;
  }

  const topbarPeers = Array.from(
    context.chat.querySelectorAll<HTMLElement>(TOPBAR_PEER_IDENTITY_SELECTOR),
  ).map((element) => element.dataset.peerId?.trim() ?? "").filter(Boolean);
  return topbarPeers.length === 1 && topbarPeers[0] === expectedPeerId;
}

/** Reports whether the current composer contains a user-visible draft. */
export function isComposerEmpty(context: TelegramComposerContext): boolean {
  return readTelegramText(context.composer).trim().length === 0;
}

function isHidden(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.classList.contains("hide") ||
    element.classList.contains("is-hidden") ||
    element.closest('[hidden], [aria-hidden="true"], .chat.hide, .chat.is-hidden')
  ) {
    return true;
  }
  const style = getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}
