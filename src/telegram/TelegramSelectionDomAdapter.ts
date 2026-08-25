/** Reads native Telegram selection state through the strict fail-closed DOM fallback. */
import type { Logger } from "../utils/logger";
import { findActiveComposerContext } from "./TelegramComposerDom";
import type { TelegramDomAdapter } from "./TelegramDomAdapter";
import type {
  TelegramMessageSnapshot,
  TelegramSourceTargetSnapshot,
} from "./TelegramSourceSnapshot";
import {
  CHECKED_SELECTION_SELECTOR,
  GROUPED_MESSAGE_SELECTOR,
  MESSAGE_IDENTITY_SELECTOR,
  SELECTED_MESSAGE_SELECTOR,
  SELECTING_HISTORY_SELECTOR,
  SELECTION_COUNT_SELECTOR,
  SELECTION_FORWARD_SELECTOR,
  SELECTION_TOOLBAR_SELECTOR,
  SELECTION_WRAPPER_SELECTOR,
} from "./domContract";

const STRICT_COUNT_PATTERN = /^(?:\D*?)(\d+)(?:\D*)$/;

/** Active normal-chat selection toolbar verified against the pinned Web K source revision. */
export interface TelegramSelectionContext {
  readonly history: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly nativeForward: HTMLElement;
  readonly countElement: HTMLElement;
  readonly sourcePeerKey: string;
  readonly sourceTarget: TelegramSourceTargetSnapshot;
}

/** Fail-closed result of projecting Telegram's native selected set through visible DOM. */
export type TelegramSelectionSnapshotResult =
  | { readonly kind: "captured"; readonly snapshots: readonly TelegramMessageSnapshot[] }
  | {
      readonly kind: "rejected";
      readonly code:
        | "selection-unavailable"
        | "protected-content"
        | "count-unreadable"
        | "virtualized-selection"
        | "identity-unavailable"
        | "mixed-peer"
        | "group-model-required";
      readonly message: string;
    };

/** Encapsulates every Telegram-specific selector used by native source multi-selection. */
export class TelegramSelectionDomAdapter {
  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly log: Logger,
  ) {}

  /**
   * Finds one normal selection toolbar tied to the active peer-scoped composer.
   *
   * The application's shared MutationObserver calls this on every Telegram mutation batch, so the
   * order of the guards is a performance contract, not a style choice: selector matching is cheap,
   * while composer resolution reaches `getComputedStyle` and forces a synchronous style
   * recalculation of the whole app. Checking selection markers first keeps every non-selection
   * mutation — which is nearly all of them, including Telegram's entire startup — flush-free.
   */
  public findActiveContext(): TelegramSelectionContext | null {
    const histories = document.querySelectorAll<HTMLElement>(SELECTING_HISTORY_SELECTOR);
    if (histories.length !== 1) {
      return null;
    }
    const wrappers = document.querySelectorAll<HTMLElement>(SELECTION_WRAPPER_SELECTOR);
    if (wrappers.length !== 1) {
      return null;
    }

    const wrapper = wrappers.item(0);
    const history = histories.item(0);
    const toolbar = wrapper.querySelector<HTMLElement>(SELECTION_TOOLBAR_SELECTOR);
    const nativeForward = toolbar?.querySelector<HTMLElement>(SELECTION_FORWARD_SELECTOR);
    const countElement = toolbar?.querySelector<HTMLElement>(SELECTION_COUNT_SELECTOR);
    if (!toolbar || !nativeForward || !countElement) {
      return null;
    }

    // Selection mode replaces the visible message input with this plate, so the composer element
    // proves peer identity here without being required to stay visible itself.
    const composer = findActiveComposerContext({ allowHiddenComposer: true });
    const sourceTarget = composer ? this.dom.readSourceTargetSnapshot(composer.peerId) : null;
    if (
      !composer ||
      !composer.container.contains(wrapper) ||
      (composer.chat !== null && !composer.chat.contains(history)) ||
      !sourceTarget
    ) {
      return null;
    }

    return {
      history,
      toolbar,
      nativeForward,
      countElement,
      sourcePeerKey: composer.peerId,
      sourceTarget,
    };
  }

  /** Reports whether the same native selection session still owns the toolbar. */
  public isContextActive(context: TelegramSelectionContext): boolean {
    return (
      context.history.isConnected &&
      context.toolbar.isConnected &&
      this.findActiveContext()?.toolbar === context.toolbar
    );
  }

  /**
   * Reads a complete visible projection or rejects virtualization and group ambiguity.
   * Equality with native count is the only safe fallback while selectedMids remains module-private.
   */
  public readSelectedSnapshots(
    context: TelegramSelectionContext,
  ): TelegramSelectionSnapshotResult {
    if (!this.isContextActive(context)) {
      return this.reject("selection-unavailable", "Native selection Telegram уже недоступен.");
    }
    if (context.nativeForward.hasAttribute("disabled")) {
      return this.reject(
        "protected-content",
        "Telegram запретил forward выбранного набора; capture остановлен до выбора получателя.",
      );
    }

    const expectedCount = this.readSelectionCount(context.countElement);
    if (expectedCount === null || expectedCount < 1) {
      return this.reject("count-unreadable", "Не удалось надёжно прочитать Telegram selection count.");
    }

    const selectedElements = this.collectSelectedElements(context.history);
    const identities = new Map<string, HTMLElement>();
    for (const element of selectedElements) {
      const peerKey = element.dataset.peerId?.trim() ?? "";
      const mid = Number(element.dataset.mid);
      if (!peerKey || !Number.isSafeInteger(mid)) {
        return this.reject("identity-unavailable", "У выбранного сообщения нет надёжной identity.");
      }
      identities.set(`${peerKey}:${mid}`, element);
    }

    if (identities.size !== expectedCount) {
      return this.reject(
        "virtualized-selection",
        "Часть выбранных сообщений не отрисована Telegram; partial capture запрещён.",
      );
    }

    const snapshots: TelegramMessageSnapshot[] = [];
    for (const element of identities.values()) {
      if (element.dataset.peerId !== context.sourcePeerKey) {
        return this.reject("mixed-peer", "Выбранные сообщения относятся к разным source peer.");
      }
      const snapshot = this.dom.readMessageSnapshot(element, context.sourceTarget.peerKey);
      if (!snapshot) {
        return this.reject(
          "identity-unavailable",
          "Telegram rerender не позволил завершить atomic message snapshot.",
        );
      }
      snapshots.push(snapshot);
    }

    // Grouped elements are allowed through above so the model bridge can identify their album. When
    // it could not, the DOM alone is back to knowing only that some group exists — which is the
    // state this adapter has always refused, with this same reason.
    if (snapshots.some((snapshot) => snapshot.group.kind === "ambiguous-dom")) {
      return this.reject(
        "group-model-required",
        "Album требует verified grouped_id и полного model snapshot; DOM fallback недостаточен.",
      );
    }

    snapshots.sort((left, right) => left.mid - right.mid);
    return { kind: "captured", snapshots: Object.freeze(snapshots) };
  }

  /** Exits selection through Telegram's real count button, never through synthetic Escape. */
  public dismiss(context: TelegramSelectionContext): boolean {
    if (!this.isContextActive(context)) {
      return false;
    }
    const cancelButton = context.countElement.closest<HTMLButtonElement>("button");
    if (!cancelButton || !context.toolbar.contains(cancelButton)) {
      this.log.warn("Native selection cancel button не соответствует проверенному contract.");
      return false;
    }
    cancelButton.click();
    return true;
  }

  /**
   * Collects one element per selected message.
   *
   * An album contributes its items, never its container. Upstream marks the container selected too
   * once all of its mids are (`selection.ts`, `updateElementSelection(groupContainer, …)`), and that
   * container reads as every photo of the album at once — so keeping it would both inflate the
   * count and hand capture an element that is not one message.
   */
  private collectSelectedElements(history: HTMLElement): readonly HTMLElement[] {
    const elements = new Set<HTMLElement>(
      history.querySelectorAll<HTMLElement>(SELECTED_MESSAGE_SELECTOR),
    );
    for (const checkbox of history.querySelectorAll<HTMLInputElement>(CHECKED_SELECTION_SELECTOR)) {
      const element = checkbox.closest<HTMLElement>(MESSAGE_IDENTITY_SELECTOR);
      if (element) {
        elements.add(element);
      }
    }
    // Filtered once, after both sources, so a container cannot arrive through the checkbox path.
    return [...elements].filter((element) => !element.querySelector(GROUPED_MESSAGE_SELECTOR));
  }

  private readSelectionCount(element: HTMLElement): number | null {
    const match = element.textContent?.trim().match(STRICT_COUNT_PATTERN);
    if (!match?.[1]) {
      return null;
    }
    const count = Number(match[1]);
    return Number.isSafeInteger(count) ? count : null;
  }

  private reject(
    code: Extract<TelegramSelectionSnapshotResult, { kind: "rejected" }>["code"],
    message: string,
  ): TelegramSelectionSnapshotResult {
    this.log.warn(message, { code });
    return { kind: "rejected", code, message };
  }
}
