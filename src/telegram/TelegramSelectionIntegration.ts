/** Adds a Clean Forward action to Telegram's verified native selection toolbar. */
import { CLEAN_FORWARD_RUNTIME_FINGERPRINT } from "../app/CleanForwardRuntime";
import type { Logger } from "../utils/logger";
import type { TelegramSelectionContext } from "./TelegramSelectionDomAdapter";

const ACTION_ATTRIBUTE = "data-clean-forward-selection-action";
const ACTION_OWNER_ATTRIBUTE = "data-clean-forward-runtime-owner";
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
    const existingActions = Array.from(
      context.toolbar.querySelectorAll<HTMLElement>(`[${ACTION_ATTRIBUTE}]`),
    );
    const ownedAction = existingActions.find((candidate) => this.states.has(candidate));
    if (ownedAction) {
      for (const staleAction of existingActions) {
        if (staleAction !== ownedAction) staleAction.remove();
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
      for (const staleAction of existingActions) staleAction.remove();
      this.log.info("Удалён stale selection action предыдущего runtime.", {
        previousOwners,
        owner: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
      });
    }

    // cloneNode preserves Telegram's current button presentation but deliberately copies no
    // listener. Removing the native Forward marker prevents delegated native forwarding.
    const action = context.nativeForward.cloneNode(false) as HTMLElement;
    action.classList.remove(NATIVE_FORWARD_CLASS);
    action.classList.add(ACTION_CLASS);
    action.removeAttribute("disabled");
    this.stampOwner(action);
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

  private stampOwner(action: HTMLElement): void {
    action.setAttribute(ACTION_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
    action.setAttribute(ACTION_OWNER_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
  }
}
