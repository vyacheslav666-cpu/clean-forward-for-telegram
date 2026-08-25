/** Captures one complete model-backed photo/video album as an explicit atomic unit. */
import { createMediaGroupTransferUnit } from "../../domain/TransferUnit";
import type { SourceMessageDescriptor } from "../../domain/SourceMessageDescriptor";
import type { TelegramSourceSnapshot } from "../TelegramSourceSnapshot";
import { BinaryMediaSourceCaptureAdapter } from "./BinaryMediaSourceCaptureAdapter";
import { CaptureAdapterError } from "./SourceCaptureAdapter";

const MAX_NATIVE_ALBUM_ITEMS = 10;

/**
 * Reports why one member cannot travel in this album, or null when it can.
 *
 * DOM-backed members are restricted to plain photos on purpose. An album holding a video or a GIF
 * is not merely harder to read: upstream's own `PopupNewMedia.iterate` may split it across several
 * sends, so the expected outgoing grouping stops being one group and the success criterion this
 * project confirms against would no longer describe the result. Naming that limit separately keeps
 * it readable as a deliberate boundary rather than as the album machinery failing.
 */
function describeIncompatibleMember(snapshot: TelegramSourceSnapshot): string | null {
  if (snapshot.identityResolution === "telegram-model") {
    return snapshot.content.kind === "binary" &&
      (snapshot.content.role === "photo" || snapshot.content.role === "video")
      ? null
      : "Album contains a family that cannot travel as one native media group.";
  }
  if (snapshot.videoCount > 0 || snapshot.video) {
    return "Album with video is not supported yet: Telegram may split it into several sends.";
  }
  if (snapshot.hasUnsupportedAttachment) {
    return "Album contains an attachment that is not an ordinary photo.";
  }
  return snapshot.imageCount === 1 && snapshot.imageUrl
    ? null
    : "Album members must each be exactly one ordinary photo.";
}

/** Uses the same binary validation as independent media while preserving group boundaries. */
export class MediaGroupSourceCaptureAdapter {
  public constructor(private readonly binary: BinaryMediaSourceCaptureAdapter) {}

  /** Captures exactly one native-compatible group or rejects it before recipient selection. */
  public async capture(
    snapshots: readonly TelegramSourceSnapshot[],
    descriptors: readonly SourceMessageDescriptor[],
    signal?: AbortSignal,
  ) {
    const group = snapshots[0]?.group;
    if (
      group?.kind !== "complete-model" ||
      snapshots.length !== group.expectedItemCount ||
      snapshots.length < 2 ||
      snapshots.length > MAX_NATIVE_ALBUM_ITEMS ||
      descriptors.length !== snapshots.length
    ) {
      throw new CaptureAdapterError(
        "incomplete-selection",
        "Album snapshot must contain one complete native group of 2–10 items.",
      );
    }
    const firstOrder = descriptors[0]?.order ?? -1;
    if (descriptors.some((descriptor, index) => descriptor.order !== firstOrder + index)) {
      throw new CaptureAdapterError(
        "incomplete-selection",
        "Album members must form one contiguous source sequence.",
      );
    }
    const groupedId = group.groupedId;
    if (snapshots.some((snapshot) =>
      snapshot.group.kind !== "complete-model" ||
      snapshot.group.groupedId !== groupedId ||
      snapshot.group.expectedItemCount !== group.expectedItemCount
    )) {
      throw new CaptureAdapterError(
        "unsupported-type",
        "Album members disagree about which group they belong to.",
      );
    }
    const incompatible = snapshots.map(describeIncompatibleMember).find(Boolean);
    if (incompatible) {
      throw new CaptureAdapterError("unsupported-type", incompatible);
    }

    const items = await Promise.all(snapshots.map((snapshot, index) =>
      this.binary.captureItem({ snapshot, descriptor: descriptors[index]!, signal }),
    ));
    return createMediaGroupTransferUnit({
      source: descriptors,
      groupedId,
      items,
      expectedGroups: [{
        groupIndex: 0,
        itemOrders: items.map((item) => item.order),
      }],
    });
  }
}
