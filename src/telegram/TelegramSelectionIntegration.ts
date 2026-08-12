/** Adds a Clean Forward action to Telegram's verified native selection toolbar. */
import type { Logger } from "../utils/logger";
import type { TelegramSelectionContext } from "./TelegramSelectionDomAdapter";

const ACTION_ATTRIBUTE = "data-clean-forward-selection-action";
const ACTION_CLASS = "clean-forward-selection-action";
const NATIVE_FORWARD_CLASS = "selection-container-forward";
const ACTION_LABEL = "Отправить как новое";

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
    const existing = context.toolbar.querySelector<HTMLElement>(`[${ACTION_ATTRIBUTE}]`);
    if (existing) {
      const state = this.states.get(existing);
      if (state) {
        state.onSelect = onSelect;
        state.activated = false;
      }
      return;
    }

    // cloneNode preserves Telegram's current button presentation but deliberately copies no
    // listener. Removing the native Forward marker prevents delegated native forwarding.
    const action = context.nativeForward.cloneNode(false) as HTMLElement;
    action.classList.remove(NATIVE_FORWARD_CLASS);
    action.classList.add(ACTION_CLASS);
    action.removeAttribute("disabled");
    action.setAttribute(ACTION_ATTRIBUTE, "");
    action.setAttribute("aria-label", ACTION_LABEL);
    action.setAttribute("title", ACTION_LABEL);
    if (action instanceof HTMLButtonElement) {
      action.type = "button";
    }

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

    context.nativeForward.before(action);
    this.log.info("Clean Forward action добавлен в native selection toolbar.");
  }
}
