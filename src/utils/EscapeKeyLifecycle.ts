/** Manages one cancellable Escape listener for a project-owned modal lifecycle. */

/** Guard and callback used by the active modal Escape listener. */
export interface EscapeKeyBinding {
  readonly shouldHandle: (event: KeyboardEvent) => boolean;
  readonly onEscape: () => void;
}

/** Ensures repeated popup openings never accumulate document keydown listeners. */
export class EscapeKeyLifecycle {
  private controller: AbortController | null = null;

  /** Replaces any earlier listener with one binding scoped to the current popup opening. */
  public activate(binding: EscapeKeyBinding): void {
    this.deactivate();
    const controller = new AbortController();
    this.controller = controller;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !binding.shouldHandle(event)) {
          return;
        }

        // Consuming Escape prevents an underlying Telegram layer from reacting after the
        // project popup has already treated the key as an explicit cancellation.
        event.preventDefault();
        event.stopImmediatePropagation();
        binding.onEscape();
      },
      { capture: true, signal: controller.signal },
    );
  }

  /** Removes the current listener and releases its callback references. */
  public deactivate(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
