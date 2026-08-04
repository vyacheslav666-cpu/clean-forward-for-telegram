/** Locates the one active Telegram composer and its chat-scoped controls. */
import { readTelegramText } from "./readTelegramText";

const ACTIVE_COMPOSER_SELECTOR =
  '.input-message-input[contenteditable="true"][data-peer-id]';
const COMPOSER_CONTAINER_SELECTOR = ".chat-input-main";

/** Verified DOM context for the currently active destination chat. */
export interface TelegramComposerContext {
  readonly composer: HTMLElement;
  readonly container: HTMLElement;
  readonly peerId: string;
}

/** Returns the composer only when exactly one active peer-scoped instance is present. */
export function findActiveComposerContext(): TelegramComposerContext | null {
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

  return { composer, container, peerId };
}

/** Confirms that Telegram still points at the peer captured before an async operation. */
export function isActivePeer(peerId: string): boolean {
  return findActiveComposerContext()?.peerId === peerId;
}

/** Reports whether the current composer contains a user-visible draft. */
export function isComposerEmpty(context: TelegramComposerContext): boolean {
  return readTelegramText(context.composer).trim().length === 0;
}
