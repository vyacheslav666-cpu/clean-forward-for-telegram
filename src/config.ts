/** Explicit development-only UI flags kept separate from delivery state. */
export interface AppConfig {
  readonly debug: {
    readonly showDeliveryResultDialog: boolean;
  };
}

/** Production defaults for the distributed Tampermonkey userscript. */
export const appConfig: AppConfig = Object.freeze({
  debug: Object.freeze({
    showDeliveryResultDialog: false,
  }),
});
