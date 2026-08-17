/** Adds a Clean Forward action to Telegram's verified native selection toolbar. */
import { CLEAN_FORWARD_RUNTIME_FINGERPRINT } from "../app/CleanForwardRuntime";
import type { Logger } from "../utils/logger";
import type { TelegramSelectionContext } from "./TelegramSelectionDomAdapter";

const ACTION_ATTRIBUTE = "data-clean-forward-selection-action";
const ACTION_OWNER_ATTRIBUTE = "data-clean-forward-runtime-owner";
const SLOT_ATTRIBUTE = "data-clean-forward-selection-slot";
const ACTION_CLASS = "clean-forward-selection-action";
const NATIVE_FORWARD_CLASS = "selection-container-forward";
const ACTION_LABEL = "Отправить как новое";
/** The toolbar is icon-sized on mobile, so the visible wording stays short; `title` carries the rest. */
const ACTION_SHORT_LABEL = "Как новое";
/** Telegram's own side-slot class, reused so the action inherits the plate's button sizing. */
const PLATE_SIDE_CLASS = "chat-input-plate-side";
/** Same tgico glyph the context-menu item already uses. */
const ACTION_ICON = "";

interface SelectionActionState {
  onSelect: () => void;
  activated: boolean;
}

/** Integrates one guarded action without invoking or wrapping native Forward. */
export class TelegramSelectionIntegration {
  private readonly states = new WeakMap<HTMLElement, SelectionActionState>();

  public constructor(private readonly log: Logger) {}

  /** Ensures a reused Telegram toolbar contains exactly one current action callback. */
  public ensureAction(context: TelegramSelectionContext, onSelect: () => void): void {
    const existingActions = Array.from(
      context.toolbar.querySelectorAll<HTMLElement>(`[${ACTION_ATTRIBUTE}]`),
    );
    const ownedAction = existingActions.find((candidate) => this.states.has(candidate));
    if (ownedAction) {
      for (const staleAction of existingActions) {
        if (staleAction !== ownedAction) this.removeAction(staleAction);
      }
      const state = this.states.get(ownedAction)!;
      state.onSelect = onSelect;
      state.activated = false;
      this.stampOwner(ownedAction);
      return;
    }

    if (existingActions.length > 0) {
      const previousOwners = existingActions.map(
        (action) => action.getAttribute(ACTION_OWNER_ATTRIBUTE) ?? "legacy/unknown",
      );
      for (const staleAction of existingActions) this.removeAction(staleAction);
      this.log.info("Удалён stale selection action предыдущего runtime.", {
        previousOwners,
        owner: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
      });
    }

    // A shallow clone of the native button copies no listener, but it also copies no icon: Telegram
    // renders that as a child node, so the cloned control used to occupy the toolbar while being
    // completely invisible. Borrow only the class names that carry sizing and ripple behaviour,
    // drop the native Forward marker so no delegated forwarding can reach it, and supply the
    // project's own visible content.
    const action = document.createElement("button");
    action.type = "button";
    for (const className of context.nativeForward.classList) {
      if (className !== NATIVE_FORWARD_CLASS) {
        action.classList.add(className);
      }
    }
    action.classList.add(ACTION_CLASS);
    this.stampOwner(action);
    action.setAttribute("aria-label", ACTION_LABEL);
    action.setAttribute("title", ACTION_LABEL);

    const icon = document.createElement("span");
    icon.className = "tgico";
    icon.textContent = ACTION_ICON;
    const label = document.createElement("span");
    label.className = `${ACTION_CLASS}-label`;
    label.textContent = ACTION_SHORT_LABEL;
    action.append(icon, label);
    // The icon glyph depends on Telegram's font being applied to this node; the text label is the
    // guarantee that the control is findable even when that font or class does not resolve.
    action.style.width = "auto";
    action.style.minWidth = "0";
    action.style.padding = "0 10px";
    action.style.display = "inline-flex";
    action.style.alignItems = "center";
    action.style.gap = "4px";
    action.style.whiteSpace = "nowrap";
    action.style.fontWeight = "500";

    const state: SelectionActionState = { onSelect, activated: false };
    this.states.set(action, state);
    const activate = (): void => {
      const current = this.states.get(action);
      if (!current || current.activated) {
        return;
      }
      current.activated = true;
      try {
        current.onSelect();
      } catch (error) {
        this.log.error("Ошибка Clean Forward selection action.", error);
      }
    };
    const consume = (event: Event): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    action.addEventListener("pointerdown", (event) => {
      consume(event);
      if ((event as PointerEvent).button === 0) {
        activate();
      }
    });
    action.addEventListener("mousedown", consume);
    action.addEventListener("click", (event) => {
      consume(event);
      // Keyboard activation has no pointerdown, so click remains the accessibility path.
      activate();
    });

    // Telegram's plate is a three-slot layout whose side slots reserve symmetric space for exactly
    // one icon button each. Adding a second control inside the Forward slot squeezes it out of
    // view, so the action gets its own slot of the same kind instead.
    const forwardSlot = context.nativeForward.closest<HTMLElement>(`.${PLATE_SIDE_CLASS}`);
    if (forwardSlot && context.toolbar.contains(forwardSlot)) {
      const slot = document.createElement("div");
      slot.className = PLATE_SIDE_CLASS;
      slot.setAttribute(SLOT_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
      slot.style.width = "auto";
      slot.append(action);
      forwardSlot.before(slot);
    } else {
      context.nativeForward.before(action);
    }
    this.log.info("Clean Forward action добавлен в native selection toolbar.", {
      ownSlot: Boolean(forwardSlot),
    });
  }

  /** Removes an action together with the slot this project added for it, never a Telegram slot. */
  private removeAction(action: HTMLElement): void {
    const slot = action.parentElement;
    action.remove();
    if (slot?.hasAttribute(SLOT_ATTRIBUTE) && slot.childElementCount === 0) {
      slot.remove();
    }
  }

  private stampOwner(action: HTMLElement): void {
    action.setAttribute(ACTION_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
    action.setAttribute(ACTION_OWNER_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
  }
}
