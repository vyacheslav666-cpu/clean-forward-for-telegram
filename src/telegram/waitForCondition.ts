/** Waits for Telegram DOM state through explicit predicates without fixed-delay sequencing. */

/**
 * Resolves when a predicate returns a value, using the timeout only as an upper safety boundary.
 * Animation frames keep the observer-free polling aligned with Telegram's render lifecycle.
 */
export function waitForCondition<T>(
  probe: () => T | null,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let frameId = 0;
    let settled = false;

    const finish = (complete: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      window.cancelAnimationFrame(frameId);
      complete();
    };

    const check = (): void => {
      try {
        const value = probe();
        if (value !== null) {
          finish(() => resolve(value));
          return;
        }
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      frameId = window.requestAnimationFrame(check);
    };

    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
    }, timeoutMs);

    check();
  });
}
