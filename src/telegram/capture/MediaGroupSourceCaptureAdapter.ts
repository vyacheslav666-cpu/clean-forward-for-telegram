/** Captures one complete model-backed photo/video album as an explicit atomic unit. */
import { createMediaGroupTransferUnit } from "../../domain/TransferUnit";
import type { SourceMessageDescriptor } from "../../domain/SourceMessageDescriptor";
import type { TelegramModelMessageSnapshot } from "../TelegramSourceSnapshot";
import { BinaryMediaSourceCaptureAdapter } from "./BinaryMediaSourceCaptureAdapter";
import { CaptureAdapterError } from "./SourceCaptureAdapter";

const MAX_NATIVE_ALBUM_ITEMS = 10;

/** Uses the same binary validation as independent media while preserving group boundaries. */
export class MediaGroupSourceCaptureAdapter {
  public constructor(private readonly binary: BinaryMediaSourceCaptureAdapter) {}

  /** Captures exactly one native-compatible group or rejects it before recipient selection. */
  public async capture(
    snapshots: readonly TelegramModelMessageSnapshot[],
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
      snapshot.group.expectedItemCount !== group.expectedItemCount ||
      snapshot.content.kind !== "binary" ||
      (snapshot.content.role !== "photo" && snapshot.content.role !== "video")
    )) {
      throw new CaptureAdapterError(
        "unsupported-type",
        "Album contains an incompatible family or inconsistent grouped_id.",
      );
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
