/** Captures stable source identity without retaining Telegram models or DOM nodes. */

/** Identifies the chat in which a source snapshot was captured. */
export interface SourceChatDescriptor {
  readonly peerKey: string;
  readonly title: string | null;
  /** Exact native-search locator captured while the source peer was still addressable. */
  readonly searchQuery?: string;
}

interface SourceMessageDescriptorBase {
  readonly sourcePeerKey: string;
  readonly mid: number;
  readonly groupedId?: string;
  readonly order: number;
}

/** Descriptor resolved from Telegram's read-only message model. */
export interface ModelSourceMessageDescriptor extends SourceMessageDescriptorBase {
  readonly resolution: "telegram-model";
  readonly date: number;
}

/**
 * Descriptor captured from the currently verified DOM fallback.
 * `date` stays explicit instead of being fabricated when the model bridge is unavailable.
 */
export interface DomSourceMessageDescriptor extends SourceMessageDescriptorBase {
  readonly resolution: "dom-fallback";
  readonly date: number | null;
}

/** Immutable identity and ordering metadata for one source message. */
export type SourceMessageDescriptor =
  | ModelSourceMessageDescriptor
  | DomSourceMessageDescriptor;

/** Creates an immutable source-chat snapshot safe to retain in memory. */
export function createSourceChatDescriptor(
  peerKey: string,
  title: string | null,
  searchQuery?: string,
): SourceChatDescriptor {
  if (!peerKey.trim()) {
    throw new Error("Source peerKey must not be empty.");
  }
  if (searchQuery !== undefined && !searchQuery.trim()) {
    throw new Error("Source searchQuery must not be empty when present.");
  }

  return Object.freeze({
    peerKey,
    title,
    ...(searchQuery === undefined ? {} : { searchQuery: searchQuery.trim() }),
  });
}

/** Copies and freezes source-message identity so later caller mutation cannot alter a transfer. */
export function createSourceMessageDescriptor(
  descriptor: SourceMessageDescriptor,
): SourceMessageDescriptor {
  if (!descriptor.sourcePeerKey.trim()) {
    throw new Error("Source message peerKey must not be empty.");
  }
  if (!Number.isSafeInteger(descriptor.mid)) {
    throw new Error("Source message mid must be a safe integer.");
  }
  if (!Number.isSafeInteger(descriptor.order) || descriptor.order < 0) {
    throw new Error("Source message order must be a non-negative safe integer.");
  }
  if (descriptor.resolution === "telegram-model" && !Number.isFinite(descriptor.date)) {
    throw new Error("Model-backed source message date must be finite.");
  }
  if (descriptor.resolution === "dom-fallback" && descriptor.date !== null && !Number.isFinite(descriptor.date)) {
    throw new Error("DOM source message date must be finite when present.");
  }

  return Object.freeze({ ...descriptor });
}

/** Returns the Telegram identity key used for duplicate and membership checks. */
export function sourceMessageIdentity(descriptor: SourceMessageDescriptor): string {
  return `${descriptor.sourcePeerKey}:${descriptor.mid}`;
}
