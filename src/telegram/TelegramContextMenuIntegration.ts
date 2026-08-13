/** Adds the Clean Forward action using the verified Telegram Web K menu structure. */
import { CLEAN_FORWARD_RUNTIME_FINGERPRINT } from "../app/CleanForwardRuntime";
import type { Logger } from "../utils/logger";

const ACTION_ATTRIBUTE = "data-clean-forward-context-action";
const ACTION_OWNER_ATTRIBUTE = "data-clean-forward-runtime-owner";
const ACTION_LABEL = "Отправить как новое";
const NATIVE_ITEM_SELECTOR = ":scope > .btn-menu-item";
const NATIVE_ITEM_TEXT_SELECTOR = ".btn-menu-item-text";
const FORWARD_LABEL = "Forward";
const MENU_VIEWPORT_PADDING = 8;

interface ContextActionState {
  onSelect: () => void;
  activated: boolean;
}

/** Adds one isolated action to an already verified Telegram context-menu element. */
export class ContextMenuIntegration {
  private readonly states = new WeakMap<HTMLElement, ContextActionState>();

  public constructor(private readonly log: Logger) {}

  /**
   * Ensures that a menu has exactly one action and refreshes its callback when Telegram reuses DOM.
   */
  public ensureAction(menu: HTMLElement, onSelect: () => void): void {
    const existingItems = Array.from(
      menu.querySelectorAll<HTMLElement>(`[${ACTION_ATTRIBUTE}]`),
    );
    const ownedItem = existingItems.find((candidate) => this.states.has(candidate));
    if (ownedItem) {
      for (const staleItem of existingItems) {
        if (staleItem !== ownedItem) staleItem.remove();
      }
      const state = this.states.get(ownedItem)!;
      state.onSelect = onSelect;
      state.activated = false;
      this.stampOwner(ownedItem);
      this.log.debug("Контекстный пункт найден повторно; callback обновлён.", {
        connected: ownedItem.isConnected,
      });
      return;
    }

    if (existingItems.length > 0) {
      const previousOwners = existingItems.map(
        (item) => item.getAttribute(ACTION_OWNER_ATTRIBUTE) ?? "legacy/unknown",
      );
      for (const staleItem of existingItems) staleItem.remove();
      this.log.info("Удалён stale контекстный пункт предыдущего runtime.", {
        previousOwners,
        owner: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
      });
    }

    const item = document.createElement("div");
    item.classList.add("btn-menu-item", "rp-overflow");
    this.stampOwner(item);

    const icon = document.createElement("span");
    icon.classList.add("tgico", "btn-menu-item-icon");
    icon.textContent = "";

    const label = document.createElement("span");
    label.classList.add("btn-menu-item-text");
    label.textContent = ACTION_LABEL;
    item.append(icon, label);

    const state: ContextActionState = { onSelect, activated: false };
    this.states.set(item, state);
    this.log.info("Создан пункт контекстного меню.");

    const activate = (eventName: "pointerdown" | "click"): void => {
      const currentState = this.states.get(item);
      this.log.info(`Получено событие ${eventName} на пункте.`, {
        connected: item.isConnected,
        hasState: Boolean(currentState),
        alreadyActivated: currentState?.activated ?? null,
      });
      if (!currentState || currentState.activated) {
        return;
      }

      currentState.activated = true;
      try {
        currentState.onSelect();
      } catch (error) {
        this.log.error("Ошибка callback контекстного пункта.", error);
      }
    };

    item.addEventListener("pointerdown", (event) => {
      this.log.debug("pointerdown контекстного пункта.", {
        button: event.button,
        connected: item.isConnected,
      });
      if (event.button === 0) {
        // Telegram can tear down its menu before the later click event. Starting on primary
        // pointerdown preserves the source-message closure while the menu is still connected.
        activate("pointerdown");
      }
    });
    item.addEventListener("mousedown", (event) => {
      this.log.debug("mousedown контекстного пункта.", {
        button: event.button,
        connected: item.isConnected,
      });
    });
    item.addEventListener("click", (event) => {
      this.log.debug("click контекстного пункта.", { connected: item.isConnected });
      event.preventDefault();
      // Keyboard activation has no pointerdown, so click remains the accessibility fallback.
      activate("click");
    });
    this.log.info("Listeners контекстного пункта навешаны.");

    const forwardItem = Array.from(menu.querySelectorAll<HTMLElement>(NATIVE_ITEM_SELECTOR)).find(
      (candidate) =>
        candidate.querySelector<HTMLElement>(NATIVE_ITEM_TEXT_SELECTOR)?.textContent?.trim() ===
        FORWARD_LABEL,
    );
    if (forwardItem) {
      forwardItem.after(item);
    } else {
      const dangerItem = menu.querySelector<HTMLElement>(`${NATIVE_ITEM_SELECTOR}.danger`);
      if (dangerItem) {
        dangerItem.before(item);
      } else {
        menu.append(item);
      }
    }

    this.clampMenuToViewport(menu);
    this.log.info("Пункт контекстного меню добавлен в Telegram DOM.", {
      connected: item.isConnected,
      placedNextToForward: Boolean(forwardItem),
    });
  }

  private stampOwner(item: HTMLElement): void {
    item.setAttribute(ACTION_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
    item.setAttribute(ACTION_OWNER_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
  }

  /** Repeats Telegram's vertical viewport clamp after the late menu-item insertion. */
  private clampMenuToViewport(menuItems: HTMLElement): void {
    const menu = menuItems.closest<HTMLElement>(".btn-menu.contextmenu.active");
    const view = menu?.ownerDocument.defaultView;
    if (!menu || !view) {
      return;
    }

    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => {
        if (!menu.isConnected || !menu.classList.contains("active")) {
          return;
        }

        const rect = menu.getBoundingClientRect();
        const minimumTop = MENU_VIEWPORT_PADDING;
        const maximumBottom = view.innerHeight - MENU_VIEWPORT_PADDING;
        const overflowBottom = Math.max(0, rect.bottom - maximumBottom);
        const overflowTop = Math.max(0, minimumTop - rect.top);
        if (overflowBottom === 0 && overflowTop === 0) {
          return;
        }

        const currentTop = Number.parseFloat(menu.style.top);
        if (!Number.isFinite(currentTop)) {
          return;
        }

        menu.style.top = `${currentTop - overflowBottom + overflowTop}px`;
      });
    });
  }
}
