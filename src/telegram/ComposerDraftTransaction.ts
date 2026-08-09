/** Result of starting or restoring one peer-scoped composer draft transaction. */
export interface ComposerDraftTransactionResult {
  readonly success: boolean;
  readonly message: string;
}

/** Restores the exact plain-text draft captured before Clean Forward prepared its payload. */
export interface ComposerDraftTransaction {
  readonly peerKey: string;
  readonly hadDraft: boolean;
  restore(): Promise<ComposerDraftTransactionResult>;
}

/** Fail-closed result of snapshotting and temporarily clearing one composer. */
export type ComposerDraftTransactionStart =
  | {
      readonly success: true;
      readonly message: string;
      readonly transaction: ComposerDraftTransaction;
    }
  | {
      readonly success: false;
      readonly message: string;
    };
