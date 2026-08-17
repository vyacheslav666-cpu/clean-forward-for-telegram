import { describe, expect, it } from "vitest";

import { DeliveryBatch } from "../../src/delivery/DeliveryBatch";
import type { Recipient } from "../../src/recipient/Recipient";

function recipient(peerKey: string): Readonly<Recipient> {
  return Object.freeze({ peerKey, title: `fixture-${peerKey}`, supported: true });
}

function batchWith(units = 1): DeliveryBatch {
  const batch = new DeliveryBatch([recipient("8")], units);
  batch.beginRun();
  return batch;
}

function currentRecord(batch: DeliveryBatch) {
  return batch.snapshot().recipients[0]!;
}

describe("delivery attempt bookkeeping", () => {
  it("clears the previous failure once a new attempt starts navigating", () => {
    const batch = batchWith();
    batch.beginNavigation("8");
    batch.beginUnitPreparation("8", 0);
    batch.scheduleRetry("8", "Telegram не завершил обработку подписи.");

    expect(currentRecord(batch).detail).toBe("Telegram не завершил обработку подписи.");

    batch.beginNavigation("8");

    const record = currentRecord(batch);
    expect(record.status).toBe("navigating");
    expect(record.detail).toBeUndefined();
    expect(record.units[0]?.detail).toBeUndefined();
    // Attempt history is the point of `retryReason`; only the live error line is cleared.
    expect(record.retryReason).toBe("Telegram не завершил обработку подписи.");
  });

  it("never shows a stale error underneath a running preparation", () => {
    const batch = batchWith();
    batch.beginNavigation("8");
    batch.beginUnitPreparation("8", 0);
    batch.scheduleRetry("8", "preparation failed once");
    batch.beginNavigation("8");
    batch.beginUnitPreparation("8", 0);

    const record = currentRecord(batch);
    expect(record.status).toBe("preparing");
    expect(record.detail).toBeUndefined();
  });

  it("keeps a terminal failure visible after the retry budget is spent", () => {
    const batch = batchWith();
    batch.beginNavigation("8");
    batch.beginUnitPreparation("8", 0);
    batch.markFailed("8", "terminal pre-Send failure");

    const record = currentRecord(batch);
    expect(record.status).toBe("failed");
    expect(record.detail).toBe("terminal pre-Send failure");
  });

  it("does not clear a confirmed unit while a later unit is retried", () => {
    const batch = batchWith(2);
    batch.beginNavigation("8");
    batch.beginUnitPreparation("8", 0);
    batch.markUnitSendClicked("8", 0);
    batch.markUnitSent("8", 0, ["mid-1"]);
    batch.beginUnitPreparation("8", 1);
    batch.scheduleRetry("8", "second unit failed");
    batch.beginNavigation("8");

    const record = currentRecord(batch);
    expect(record.detail).toBeUndefined();
    expect(record.units[0]?.outgoingConfirmed).toBe(true);
    expect(record.units[0]?.messageIds).toEqual(["mid-1"]);
    expect(record.units[1]?.detail).toBeUndefined();
  });
});
