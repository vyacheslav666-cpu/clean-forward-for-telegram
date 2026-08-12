/** Shared contracts for small source-message capture strategies. */
import type { UnsupportedSource } from "../../domain/MessagePayload";
import type { SourceMessageDescriptor } from "../../domain/SourceMessageDescriptor";
import type { TransferUnit } from "../../domain/TransferUnit";
import type { TelegramSourceSnapshot } from "../TelegramSourceSnapshot";

/** Failure code that can be surfaced as one atomic unsupported source result. */
export type CaptureAdapterFailureCode = UnsupportedSource["reason"]["code"];

/** Carries a deliberate fail-closed classification across strategy boundaries. */
export class CaptureAdapterError extends Error {
  public constructor(
    public readonly code: CaptureAdapterFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureAdapterError";
  }
}

/** Context needed to construct one immutable transfer unit. */
export interface SourceCaptureAdapterContext {
  readonly snapshot: TelegramSourceSnapshot;
  readonly descriptor: SourceMessageDescriptor;
  readonly signal?: AbortSignal;
}

/** One explicit message-family strategy. */
export interface SourceCaptureAdapter {
  /** Reports whether this strategy owns the already discriminated source family. */
  supports(snapshot: TelegramSourceSnapshot): boolean;

  /** Materializes one immutable unit or throws a classified fail-closed error. */
  capture(context: SourceCaptureAdapterContext): Promise<TransferUnit>;
}

/** Stops byte acquisition at the same atomic boundary used by the capture service. */
export function throwIfCaptureAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Source capture cancelled.", "AbortError");
  }
}
