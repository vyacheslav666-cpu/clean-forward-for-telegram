/** Manages one cancellable Escape listener for a project-owned modal lifecycle. */

/** Guard and callback used by the active modal Escape listener. */
export interface EscapeKeyBinding {
  readonly shouldHandle: (event: KeyboardEvent) => boolean;
  readonly onEscape: () => void;
}

/** Ensures repeated popup openings never accumulate Escape listeners. */
export class EscapeKeyLifecycle {
  private binding: EscapeKeyBinding | null = null;
  private consumeEscapeKeyup = false;

  /** Installs the capture listeners before the host page can register its modal handlers. */
  public constructor() {
    window.addEventListener(
      "keydown",
      (event) => {
        const binding = this.binding;
        if (event.key !== "Escape" || !binding || !binding.shouldHandle(event)) {
          return;
        }

        this.consumeEscapeKeyup = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
    window.addEventListener(
      "keyup",
      (event) => {
        const binding = this.binding;
        if (event.key !== "Escape" || !binding || !this.consumeEscapeKeyup) {
          return;
        }

        this.consumeEscapeKeyup = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        binding.onEscape();
      },
      { capture: true },
    );
  }

  /** Replaces any earlier listener with one binding scoped to the current popup opening. */
  public activate(binding: EscapeKeyBinding): void {
    this.deactivate();
    this.binding = binding;
  }

  /** Removes the current listener and releases its callback references. */
  public deactivate(): void {
    this.binding = null;
    this.consumeEscapeKeyup = false;
  }
}
