/** Groups transferable content into explicit units with fail-closed delivery contracts. */
import type { SourceMessageDescriptor } from "./SourceMessageDescriptor";
import type { TransferMediaItem, TransferTextContent } from "./TransferableContent";
import { fingerprintText } from "./TransferableContent";

const DEFAULT_MAX_BINARY_BYTES = 64 * 1024 * 1024;
const DEFAULT_PREPARATION_TIMEOUT_MS = 30_000;

/** Native UI capability required to prepare one unit. */
export type PrepareCapability =
  | "text-composer"
  | "media-upload"
  | "document-upload"
  | "album-upload"
  | "poll-composer";

/** Confirmation shape expected after the native Send click. */
export type OutgoingExpectation =
  | { readonly kind: "single-message"; readonly expectedCount: 1 }
  | {
      readonly kind: "media-groups";
      readonly expectedCount: number;
      readonly groups: readonly ExpectedMediaGroup[];
    };

/** Explicit partition expected from Telegram for one captured album. */
export interface ExpectedMediaGroup {
  readonly groupIndex: number;
  readonly itemOrders: readonly number[];
}

/** Safety and confirmation requirements consumed by a concrete delivery adapter. */
export interface TransferUnitDeliveryContract {
  readonly prepareCapability: PrepareCapability;
  readonly sendClickCount: 1;
  readonly atomicity: "single" | "album";
  readonly outgoing: OutgoingExpectation;
  readonly contentFingerprint: string;
  readonly limits: {
    readonly maxBinaryBytes: number;
    readonly preparationTimeoutMs: number;
  };
}

interface TransferUnitBase {
  readonly source: readonly SourceMessageDescriptor[];
  readonly delivery: TransferUnitDeliveryContract;
}

/** One text reproduction unit. */
export interface TextTransferUnit extends TransferUnitBase {
  readonly kind: "text";
  readonly content: TransferTextContent;
}

/** One independently uploaded file with an explicit Telegram media role. */
export interface FileTransferUnit extends TransferUnitBase {
  readonly kind: "file";
  readonly role: "photo" | "video" | "animation" | "document" | "audio";
  readonly item: TransferMediaItem;
}

/** One atomic Telegram album rather than an accidental list of unrelated files. */
export interface MediaGroupTransferUnit extends TransferUnitBase {
  readonly kind: "media-group";
  readonly groupedId: string;
  readonly items: readonly TransferMediaItem[];
  readonly expectedGroups: readonly ExpectedMediaGroup[];
}

/** Poll template excludes results and identities because only a new poll can be reproduced. */
export interface PollTemplateContent {
  readonly question: string;
  readonly options: readonly string[];
  readonly anonymous: boolean;
  readonly multipleChoice: boolean;
  readonly mode: "poll" | "quiz";
  readonly correctOptionIndex?: number;
  readonly explanation?: string;
}

/** One verified poll/quiz template for a future native popup adapter. */
export interface PollTemplateTransferUnit extends TransferUnitBase {
  readonly kind: "poll-template";
  readonly content: PollTemplateContent;
}

/** Explicit unit dispatch surface for present and future delivery adapters. */
export type TransferUnit =
  | TextTransferUnit
  | FileTransferUnit
  | MediaGroupTransferUnit
  | PollTemplateTransferUnit;

/** Creates one immutable text unit for the current native composer capability. */
export function createTextTransferUnit(
  source: readonly SourceMessageDescriptor[],
  content: TransferTextContent,
): TextTransferUnit {
  return Object.freeze({
    kind: "text",
    source: freezeSource(source),
    content,
    delivery: createDeliveryContract({
      prepareCapability: "text-composer",
      atomicity: "single",
      contentFingerprint: fingerprintText(content.text),
      outgoing: Object.freeze({ kind: "single-message", expectedCount: 1 }),
    }),
  });
}

/** Creates a result-free poll template and requires a complete answer for quiz semantics. */
export function createPollTemplateTransferUnit(input: {
  readonly source: readonly SourceMessageDescriptor[];
  readonly content: PollTemplateContent;
}): PollTemplateTransferUnit {
  const question = input.content.question.trim();
  const options = Object.freeze(input.content.options.map((option) => option.trim()));
  if (!question || options.length < 2 || options.some((option) => !option)) {
    throw new Error("Poll template requires a question and at least two non-empty options.");
  }
  if (input.content.mode === "quiz") {
    const correct = input.content.correctOptionIndex;
    if (!Number.isSafeInteger(correct) || correct! < 0 || correct! >= options.length) {
      throw new Error("Quiz template requires one valid correct option.");
    }
  }
  const content = Object.freeze({ ...input.content, question, options });
  return Object.freeze({
    kind: "poll-template",
    source: freezeSource(input.source),
    content,
    delivery: createDeliveryContract({
      prepareCapability: "poll-composer",
      atomicity: "single",
      contentFingerprint: fingerprintText(`${question}\u0000${options.join("\u0000")}`),
      outgoing: Object.freeze({ kind: "single-message", expectedCount: 1 }),
    }),
  });
}

/** Creates one immutable file unit while leaving role-specific preparation to its adapter. */
export function createFileTransferUnit(input: {
  readonly source: readonly SourceMessageDescriptor[];
  readonly role: FileTransferUnit["role"];
  readonly item: TransferMediaItem;
}): FileTransferUnit {
  const prepareCapability = input.role === "document" || input.role === "audio"
    ? "document-upload"
    : "media-upload";
  return Object.freeze({
    kind: "file",
    source: freezeSource(input.source),
    role: input.role,
    item: input.item,
    delivery: createDeliveryContract({
      prepareCapability,
      atomicity: "single",
      contentFingerprint: input.item.media.contentFingerprint,
      outgoing: Object.freeze({ kind: "single-message", expectedCount: 1 }),
    }),
  });
}

/** Creates an immutable atomic album and validates its expected outgoing grouping. */
export function createMediaGroupTransferUnit(input: {
  readonly source: readonly SourceMessageDescriptor[];
  readonly groupedId: string;
  readonly items: readonly TransferMediaItem[];
  readonly expectedGroups: readonly ExpectedMediaGroup[];
}): MediaGroupTransferUnit {
  if (!input.groupedId.trim() || input.items.length === 0 || input.expectedGroups.length === 0) {
    throw new Error("Media group requires an id, items, and expected outgoing groups.");
  }
  if (
    input.source.length !== input.items.length ||
    input.source.some((message) => message.groupedId !== input.groupedId)
  ) {
    throw new Error("Media group source messages must belong to the same complete groupedId.");
  }
  const items = Object.freeze([...input.items].sort((left, right) => left.order - right.order));
  const expectedGroups = freezeExpectedGroups(input.expectedGroups);
  validateExpectedGroups(items, expectedGroups);
  const fingerprint = items.map((item) => item.media.contentFingerprint).join("|");

  return Object.freeze({
    kind: "media-group",
    source: freezeSource(input.source),
    groupedId: input.groupedId,
    items,
    expectedGroups,
    delivery: createDeliveryContract({
      prepareCapability: "album-upload",
      atomicity: "album",
      contentFingerprint: fingerprint,
      outgoing: Object.freeze({
        kind: "media-groups",
        expectedCount: items.length,
        groups: expectedGroups,
      }),
    }),
  });
}

function createDeliveryContract(input: {
  readonly prepareCapability: PrepareCapability;
  readonly atomicity: TransferUnitDeliveryContract["atomicity"];
  readonly contentFingerprint: string;
  readonly outgoing: OutgoingExpectation;
}): TransferUnitDeliveryContract {
  return Object.freeze({
    ...input,
    sendClickCount: 1,
    limits: Object.freeze({
      maxBinaryBytes: DEFAULT_MAX_BINARY_BYTES,
      preparationTimeoutMs: DEFAULT_PREPARATION_TIMEOUT_MS,
    }),
  });
}

function freezeSource(
  source: readonly SourceMessageDescriptor[],
): readonly SourceMessageDescriptor[] {
  if (source.length === 0) {
    throw new Error("Transfer unit must reference at least one source message.");
  }
  return Object.freeze([...source]);
}

function freezeExpectedGroups(
  groups: readonly ExpectedMediaGroup[],
): readonly ExpectedMediaGroup[] {
  return Object.freeze(groups.map((group) => Object.freeze({
    groupIndex: group.groupIndex,
    itemOrders: Object.freeze([...group.itemOrders]),
  })));
}

function validateExpectedGroups(
  items: readonly TransferMediaItem[],
  groups: readonly ExpectedMediaGroup[],
): void {
  const expectedOrders = items.map((item) => item.order).sort((left, right) => left - right);
  const groupedOrders = groups
    .flatMap((group) => group.itemOrders)
    .sort((left, right) => left - right);
  if (
    expectedOrders.length !== groupedOrders.length ||
    expectedOrders.some((order, index) => order !== groupedOrders[index])
  ) {
    throw new Error("Expected media groups must partition every album item exactly once.");
  }
}
