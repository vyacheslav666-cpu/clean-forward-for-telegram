/** Atomically converts detached Telegram source snapshots into one immutable transfer bundle. */
import {
  createMessagePayload,
  createSourceCaptureFailure,
  createUnsupportedSource,
  type MessagePayload,
  type SourceCaptureResult,
  type UnsupportedSource,
} from "../domain/MessagePayload";
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
  type SourceChatDescriptor,
  type SourceMessageDescriptor,
} from "../domain/SourceMessageDescriptor";
import type { TransferUnit } from "../domain/TransferUnit";
import type { Logger } from "../utils/logger";
import type { TelegramDomAdapter } from "./TelegramDomAdapter";
import type {
  TelegramModelMessageSnapshot,
  TelegramSourceSnapshot,
  TelegramSourceTargetSnapshot,
} from "./TelegramSourceSnapshot";
import { BinaryMediaSourceCaptureAdapter } from "./capture/BinaryMediaSourceCaptureAdapter";
import { MediaGroupSourceCaptureAdapter } from "./capture/MediaGroupSourceCaptureAdapter";
import { PollSourceCaptureAdapter } from "./capture/PollSourceCaptureAdapter";
import {
  CaptureAdapterError,
  type SourceCaptureAdapter,
  throwIfCaptureAborted,
} from "./capture/SourceCaptureAdapter";
import { TextSourceCaptureAdapter } from "./capture/TextSourceCaptureAdapter";

/** Owns validation, strategy dispatch, ordering, and final immutable bundle construction. */
export class SourceCaptureService {
  private readonly adapters: readonly SourceCaptureAdapter[];
  private readonly mediaGroupAdapter: MediaGroupSourceCaptureAdapter;

  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly log: Logger,
  ) {
    const binaryAdapter = new BinaryMediaSourceCaptureAdapter();
    this.adapters = Object.freeze([
      new TextSourceCaptureAdapter(),
      binaryAdapter,
      new PollSourceCaptureAdapter(),
    ]);
    this.mediaGroupAdapter = new MediaGroupSourceCaptureAdapter(binaryAdapter);
  }

  /** Compatibility entrypoint for the existing one-message context-menu flow. */
  public async extract(message: HTMLElement): Promise<MessagePayload | null> {
    const sourceTarget = this.dom.readSourceTargetSnapshot(
      message.dataset.peerId?.trim() ?? "",
      message,
    );
    const snapshot = sourceTarget
      ? this.dom.readMessageSnapshot(message, sourceTarget.peerKey)
      : null;
    if (!snapshot || !sourceTarget) {
      return null;
    }
    const result = await this.captureSnapshots([snapshot], sourceTarget);
    return result.kind === "captured" ? result.payload : null;
  }

  /**
   * Captures every source or returns one failure; no partial bundle escapes this method.
   * Telegram defines chat order by ascending local `mid`, not click or current DOM order.
   */
  public captureSnapshots(
    input: readonly TelegramSourceSnapshot[],
    signal?: AbortSignal,
  ): Promise<SourceCaptureResult>;
  public captureSnapshots(
    input: readonly TelegramSourceSnapshot[],
    sourceTarget: TelegramSourceTargetSnapshot,
    signal?: AbortSignal,
  ): Promise<SourceCaptureResult>;
  public async captureSnapshots(
    input: readonly TelegramSourceSnapshot[],
    sourceTargetOrSignal?: TelegramSourceTargetSnapshot | AbortSignal,
    trailingSignal?: AbortSignal,
  ): Promise<SourceCaptureResult> {
    const sourceTarget = this.isAbortSignal(sourceTargetOrSignal)
      ? undefined
      : sourceTargetOrSignal;
    const signal = this.isAbortSignal(sourceTargetOrSignal)
      ? sourceTargetOrSignal
      : trailingSignal;
    throwIfCaptureAborted(signal);
    const normalized = this.normalizeSelection(input, sourceTarget);
    if (normalized.kind !== "valid") {
      return normalized.result;
    }

    const { snapshots, source, messages } = normalized;
    const preflightFailure = this.preflight(snapshots, source, messages);
    if (preflightFailure) {
      return preflightFailure;
    }

    try {
      const units = await this.captureUnits(snapshots, messages, signal);
      throwIfCaptureAborted(signal);
      const payload = createMessagePayload({
        operationId: crypto.randomUUID(),
        source,
        messages,
        units,
      });
      this.log.info("Atomic source bundle captured.", {
        messageCount: messages.length,
        unitCount: units.length,
      });
      return Object.freeze({ kind: "captured", payload });
    } catch (error) {
      if (this.isAbortError(error) || signal?.aborted) {
        throw error;
      }
      const failure = error instanceof CaptureAdapterError
        ? error
        : new CaptureAdapterError(
            "invalid-model",
            error instanceof Error ? error.message : "Source capture failed validation.",
          );
      this.log.error("Atomic source capture failed closed.", failure);
      return createUnsupportedSource({
        source,
        messages,
        reason: { code: failure.code, message: failure.message },
      });
    }
  }

  private normalizeSelection(
    input: readonly TelegramSourceSnapshot[],
    sourceTarget?: TelegramSourceTargetSnapshot,
  ):
    | {
        readonly kind: "valid";
        readonly snapshots: readonly TelegramSourceSnapshot[];
        readonly source: SourceChatDescriptor;
        readonly messages: readonly SourceMessageDescriptor[];
      }
    | { readonly kind: "invalid"; readonly result: SourceCaptureResult } {
    if (input.length === 0) {
      return {
        kind: "invalid",
        result: createSourceCaptureFailure({
          code: "empty-selection",
          message: "Source selection is empty.",
        }),
      };
    }
    const snapshots = Object.freeze([...input].sort((left, right) => left.mid - right.mid));
    const sourcePeerKey = snapshots[0]?.sourcePeerKey ?? "";
    if (snapshots.some((snapshot) => snapshot.sourcePeerKey !== sourcePeerKey)) {
      return {
        kind: "invalid",
        result: createSourceCaptureFailure({
          code: "mixed-peer",
          message: "Selected messages belong to different source peers.",
        }),
      };
    }
    if (sourceTarget && sourceTarget.peerKey !== sourcePeerKey) {
      return {
        kind: "invalid",
        result: createSourceCaptureFailure({
          code: "mixed-peer",
          message: "Captured source target does not own the selected messages.",
        }),
      };
    }
    const identities = new Set(snapshots.map(({ sourcePeerKey: peer, mid }) => `${peer}:${mid}`));
    if (identities.size !== snapshots.length) {
      return {
        kind: "invalid",
        result: createSourceCaptureFailure({
          code: "duplicate-identity",
          message: "Source selection contains duplicate Telegram identities.",
        }),
      };
    }

    try {
      const source = sourceTarget
        ? createSourceChatDescriptor(
            sourceTarget.peerKey,
            sourceTarget.title,
            sourceTarget.searchQuery,
          )
        : createSourceChatDescriptor(sourcePeerKey, null);
      const messages = Object.freeze(snapshots.map((snapshot, order) =>
        createSourceMessageDescriptor(snapshot.identityResolution === "telegram-model"
          ? {
              resolution: "telegram-model",
              sourcePeerKey: snapshot.sourcePeerKey,
              mid: snapshot.mid,
              date: snapshot.date,
              order,
              ...(snapshot.group.kind === "complete-model"
                ? { groupedId: snapshot.group.groupedId }
                : {}),
            }
          : {
              resolution: "dom-fallback",
              sourcePeerKey: snapshot.sourcePeerKey,
              mid: snapshot.mid,
              date: snapshot.date,
              order,
            }),
      ));
      return { kind: "valid", snapshots, source, messages };
    } catch (error) {
      return {
        kind: "invalid",
        result: createSourceCaptureFailure({
          code: "invalid-model",
          message: error instanceof Error ? error.message : "Source identity is malformed.",
        }),
      };
    }
  }

  private preflight(
    snapshots: readonly TelegramSourceSnapshot[],
    source: SourceChatDescriptor,
    messages: readonly SourceMessageDescriptor[],
  ): UnsupportedSource | null {
    for (const snapshot of snapshots) {
      if (snapshot.group.kind === "ambiguous-dom") {
        return createUnsupportedSource({
          source,
          messages,
          reason: {
            code: "model-unavailable",
            message: "Album needs verified grouped_id and complete model membership.",
          },
        });
      }
      if (snapshot.identityResolution === "dom-fallback") {
        const hasOneVideo = snapshot.video !== null;
        if (
          snapshot.hasUnsupportedAttachment ||
          snapshot.imageCount > 1 ||
          snapshot.videoCount > 1 ||
          (snapshot.videoCount === 1 && !hasOneVideo) ||
          (hasOneVideo && snapshot.imageCount > 0) ||
          (snapshot.imageCount === 1 && !snapshot.imageUrl) ||
          (snapshot.imageCount === 0 && !hasOneVideo && !snapshot.text?.trim())
        ) {
          return createUnsupportedSource({
            source,
            messages,
            reason: {
              code: "unsupported-type",
              message:
                "DOM fallback can capture only plain text, one ordinary photo, or one ordinary video.",
            },
          });
        }
        continue;
      }
      const restriction = this.classifyRestriction(snapshot);
      if (restriction) {
        return createUnsupportedSource({ source, messages, reason: restriction });
      }
      if (snapshot.content.kind === "unsupported") {
        return createUnsupportedSource({
          source,
          messages,
          reason: {
            code: "unsupported-type",
            message: `Telegram source type '${snapshot.content.type}' is explicitly unsupported.`,
          },
        });
      }
    }
    return null;
  }

  private classifyRestriction(
    snapshot: TelegramModelMessageSnapshot,
  ): UnsupportedSource["reason"] | null {
    if (snapshot.restrictions.noForwards) {
      return { code: "protected-content", message: "Protected content cannot be copied safely." };
    }
    if (snapshot.restrictions.ephemeral) {
      return { code: "ttl-media", message: "Ephemeral content cannot enter a reusable snapshot." };
    }
    if (snapshot.restrictions.paid) {
      return { code: "paid-media", message: "Paid content cannot be reproduced as a new upload." };
    }
    if (snapshot.content.kind === "binary" && !snapshot.restrictions.mediaAvailable) {
      return { code: "unavailable-media", message: "Full source media bytes are unavailable." };
    }
    return null;
  }

  private async captureUnits(
    snapshots: readonly TelegramSourceSnapshot[],
    messages: readonly SourceMessageDescriptor[],
    signal?: AbortSignal,
  ): Promise<readonly TransferUnit[]> {
    const units: TransferUnit[] = [];
    const emittedGroups = new Set<string>();
    for (let index = 0; index < snapshots.length; index += 1) {
      throwIfCaptureAborted(signal);
      const snapshot = snapshots[index]!;
      const descriptor = messages[index]!;
      if (snapshot.group.kind === "complete-model") {
        const groupedId = snapshot.group.groupedId;
        if (emittedGroups.has(groupedId)) {
          continue;
        }
        emittedGroups.add(groupedId);
        const groupIndexes = snapshots.flatMap((candidate, candidateIndex) =>
          candidate.identityResolution === "telegram-model" &&
          candidate.group.kind === "complete-model" &&
          candidate.group.groupedId === groupedId
            ? [candidateIndex]
            : [],
        );
        const groupSnapshots = groupIndexes.map((groupIndex) => snapshots[groupIndex]!)
          .filter((candidate): candidate is TelegramModelMessageSnapshot =>
            candidate.identityResolution === "telegram-model",
          );
        const groupMessages = groupIndexes.map((groupIndex) => messages[groupIndex]!);
        units.push(await this.mediaGroupAdapter.capture(groupSnapshots, groupMessages, signal));
        continue;
      }

      const adapter = this.adapters.find((candidate) => candidate.supports(snapshot));
      if (!adapter) {
        throw new CaptureAdapterError(
          "unsupported-type",
          "No verified capture strategy owns this Telegram source family.",
        );
      }
      units.push(await adapter.capture({ snapshot, descriptor, signal }));
    }
    return Object.freeze(units);
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  private isAbortSignal(
    value: TelegramSourceTargetSnapshot | AbortSignal | undefined,
  ): value is AbortSignal {
    return value !== undefined &&
      typeof (value as AbortSignal).aborted === "boolean" &&
      typeof (value as AbortSignal).addEventListener === "function";
  }
}
