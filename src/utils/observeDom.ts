/** Provides one batched observer for reacting to Telegram's dynamic DOM. */

const OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
};

/** Handle returned by the shared DOM observation utility. */
export interface DomObservation {
  /** Stops future callbacks and releases the observer. */
  disconnect(): void;
}

/**
 * Observes a root with one MutationObserver and collapses mutation bursts into one callback.
 * Batching matters because Telegram can render one menu through several consecutive mutations.
 */
export function observeDom(root: Node, callback: () => void): DomObservation {
  let callbackQueued = false;

  const observer = new MutationObserver(() => {
    if (callbackQueued) {
      return;
    }

    callbackQueued = true;
    queueMicrotask(() => {
      callbackQueued = false;
      callback();
    });
  });

  observer.observe(root, OBSERVER_OPTIONS);

  return {
    disconnect: () => observer.disconnect(),
  };
}
