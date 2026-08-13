import { describe, expect, it, vi } from "vitest";
import { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import type { AppConfig } from "../../src/config";
import type { DeliveryBatchSnapshot } from "../../src/delivery/DeliveryBatch";
import {
  createMessagePayload,
  toTelegramDeliveryPayloadUnit,
  type MessagePayload,
} from "../../src/domain/MessagePayload";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { TelegramDeliveryPayload } from "../../src/domain/TelegramDeliveryPayload";
import { createSourceChatDescriptor, createSourceMessageDescriptor } from "../../src/domain/SourceMessageDescriptor";
import { createBinaryMediaContent, createPlainTextContent, createTransferMediaItem } from "../../src/domain/TransferableContent";
import { createMediaGroupTransferUnit, createTextTransferUnit, type TransferUnit } from "../../src/domain/TransferUnit";
import type { Recipient } from "../../src/recipient/Recipient";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type {
  ChatNavigationIntent,
  ChatNavigationResult,
  TelegramChatNavigator,
} from "../../src/telegram/TelegramChatNavigator";
import type { TelegramSendAdapter, TelegramSendResult } from "../../src/telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";
import { createLogger, createMessagePayloadFixture, createTextBundlePayload } from "../helpers";

const first: Recipient = { peerKey: "101", title: "First", supported: true };
const second: Recipient = { peerKey: "202", title: "Second", supported: true };
const sourceChat: Recipient = { peerKey: "101", title: "Source", supported: true };

interface HarnessOptions {
  readonly showDeliveryResultDialog?: boolean;
  readonly payload?: TelegramDeliveryPayload;
  readonly sourcePayload?: MessagePayload;
  readonly navigate?: (
    recipient: Readonly<Recipient>,
    signal: AbortSignal,
    intent?: ChatNavigationIntent,
  ) => Promise<ChatNavigationResult>;
  readonly insert?: (payload: TelegramDeliveryPayload, peerKey: string) => Promise<{ success: boolean; message: string }>;
  readonly prepareUnit?: (unit: TransferUnit, peerKey: string) => Promise<{ success: boolean; message: string }>;
  readonly send?: (
    payload: TelegramDeliveryPayload,
    peerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ) => Promise<TelegramSendResult>;
  readonly sendUnit?: (
    unit: TransferUnit,
    peerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ) => Promise<TelegramSendResult>;
  readonly restoreDraft?: () => Promise<{ success: boolean; message: string }>;
  readonly cancelPreparedUnit?: (unit: TransferUnit, peerKey: string) => Promise<boolean>;
}

function createHarness(options: HarnessOptions = {}) {
  const payload = options.payload ?? { kind: "text", text: "payload" };
  const sourcePayload = options.sourcePayload ?? createMessagePayloadFixture(payload, sourceChat.peerKey);
  const sourceRecipient: Recipient = {
    peerKey: sourcePayload.source.peerKey,
    title: sourcePayload.source.title ?? sourcePayload.source.peerKey,
    supported: true,
  };
  const pending = new PendingTransfer();
  pending.select(sourcePayload);
  const navigator = {
    navigate: vi.fn(options.navigate ?? (async () => ({ success: true, message: "opened" }))),
    notifyDomChanged: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TelegramChatNavigator;
  const defaultInsert: NonNullable<HarnessOptions["insert"]> = async () => ({
    success: true,
    message: "prepared",
  });
  const insert = vi.fn(options.insert ?? defaultInsert);
  const cancelPreparedPayload = vi.fn(async (
    _payload: TelegramDeliveryPayload,
    _peerKey: string,
  ) => true);
  const composer = {
    beginDraftTransaction: vi.fn(() => ({
      success: true as const,
      message: "snapshotted",
      transaction: {
        peerKey: "101",
        hadDraft: true,
        restore: vi.fn(options.restoreDraft ?? (async () => ({ success: true, message: "restored" }))),
      },
    })),
    insert,
    prepareUnit: vi.fn(options.prepareUnit ?? (async (unit, peerKey) => {
      const deliveryPayload = toTelegramDeliveryPayloadUnit(unit);
      return deliveryPayload
        ? insert(deliveryPayload, peerKey)
        : { success: false, message: "unsupported test unit" };
    })),
    cancelPreparedPayload,
    cancelPreparedUnit: vi.fn(options.cancelPreparedUnit ?? (async (unit, peerKey) => {
      const deliveryPayload = toTelegramDeliveryPayloadUnit(unit);
      return deliveryPayload ? cancelPreparedPayload(deliveryPayload, peerKey) : true;
    })),
  } as unknown as ComposerAdapter;
  const sendPrepared = vi.fn(options.send ?? (async (_payload, peerKey, _signal, onSendClicked) => {
    onSendClicked();
    return { status: "sent", messageId: `mid-${peerKey}` } as const;
  }));
  const sender = {
    sendPrepared,
    sendPreparedUnit: vi.fn(options.sendUnit ?? (async (unit, peerKey, signal, onSendClicked) => {
      const deliveryPayload = toTelegramDeliveryPayloadUnit(unit);
      return deliveryPayload
        ? sendPrepared(deliveryPayload, peerKey, signal, onSendClicked)
        : { status: "failed", message: "unsupported test unit" } as const;
    })),
    notifyDomChanged: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TelegramSendAdapter;
  const progress = {
    show: vi.fn(),
    update: vi.fn(),
    hide: vi.fn(),
  } as unknown as DeliveryProgressPanel;
  const log = createLogger();
  const config: AppConfig = {
    debug: { showDeliveryResultDialog: options.showDeliveryResultDialog ?? false },
  };
  const coordinator = new DeliveryCoordinator(
    navigator,
    composer,
    sender,
    pending,
    progress,
    log,
    config,
  );
  return {
    coordinator,
    payload,
    sourcePayload,
    sourceRecipient,
    pending,
    navigator,
    composer,
    sender,
    progress,
    log,
  };
}

async function startBatch(
  harness: ReturnType<typeof createHarness>,
  recipients: readonly Recipient[] = [first],
): Promise<DeliveryBatchSnapshot> {
  const run = harness.coordinator.start(recipients, harness.sourceRecipient);
  if (!run) throw new Error("Batch did not start");
  return run;
}

function createAlbumPayload(): MessagePayload {
  const source = createSourceChatDescriptor("fixture-source", "Fixture source");
  const messages = [0, 1].map((order) => createSourceMessageDescriptor({
    resolution: "telegram-model",
    sourcePeerKey: source.peerKey,
    mid: order + 10,
    groupedId: "album-1",
    date: order + 1,
    order,
  }));
  const items = messages.map((_, order) => createTransferMediaItem({
    order,
    media: createBinaryMediaContent({
      blob: new Blob([`photo-${order}`], { type: "image/jpeg" }),
      fileName: `photo-${order}.jpg`,
      contentFingerprint: `photo-${order}`,
      metadata: { kind: "photo", width: 1, height: 1 },
    }),
  }));
  return createMessagePayload({
    operationId: "fixture-album",
    source,
    messages,
    units: [createMediaGroupTransferUnit({
      source: messages,
      groupedId: "album-1",
      items,
      expectedGroups: [{ groupIndex: 0, itemOrders: [0, 1] }],
    })],
  });
}

function createMixedPayload(): MessagePayload {
  const album = createAlbumPayload();
  const source = album.source;
  const textMessage = createSourceMessageDescriptor({
    resolution: "telegram-model",
    sourcePeerKey: source.peerKey,
    mid: 1,
    date: 0,
    order: 0,
  });
  const albumMessages = album.messages.map((message, index) =>
    createSourceMessageDescriptor({ ...message, order: index + 1 }));
  const albumUnit = album.units[0];
  if (!albumUnit || albumUnit.kind !== "media-group") throw new Error("Album fixture is invalid.");
  return createMessagePayload({
    operationId: "fixture-mixed",
    source,
    messages: [textMessage, ...albumMessages],
    units: [
      createTextTransferUnit([textMessage], createPlainTextContent("before album")),
      createMediaGroupTransferUnit({
        source: albumMessages,
        groupedId: albumUnit.groupedId,
        items: albumUnit.items.map((item, index) => createTransferMediaItem({ ...item, order: index + 1 })),
        expectedGroups: [{ groupIndex: 0, itemOrders: [1, 2] }],
      }),
    ],
  });
}

describe("DeliveryCoordinator", () => {
  it("rejects a source target that differs from the immutable captured bundle", () => {
    const harness = createHarness();
    const started = harness.coordinator.start([second], {
      peerKey: "wrong-source",
      title: "Wrong source",
      supported: true,
    });

    expect(started).toBeNull();
    expect(harness.pending.isInsertionInProgress()).toBe(false);
    expect(harness.navigator.navigate).not.toHaveBeenCalled();
  });

  it("automatically sends one text recipient", async () => {
    const harness = createHarness();
    const result = await startBatch(harness);
    expect(harness.navigator.navigate).toHaveBeenCalledWith(
      first,
      expect.any(AbortSignal),
      "destination",
    );
    expect(harness.composer.insert).toHaveBeenCalledWith(harness.payload, "101");
    expect(harness.sender.sendPrepared).toHaveBeenCalledOnce();
    expect(result.sentCount).toBe(1);
    expect(harness.pending.peek()).toBeNull();
    expect(harness.progress.hide).toHaveBeenCalledOnce();
    expect(harness.coordinator.hasOpenBatch()).toBe(false);
  });

  it("keeps the detailed final result open when the debug modal flag is enabled", async () => {
    const harness = createHarness({ showDeliveryResultDialog: true });

    const result = await startBatch(harness);

    expect(result.sentCount).toBe(1);
    expect(harness.progress.hide).not.toHaveBeenCalled();
    expect(harness.coordinator.hasOpenBatch()).toBe(true);
  });

  it("restores the draft after a successful send", async () => {
    const order: string[] = [];
    const harness = createHarness({
      send: async (_payload, peerKey, _signal, onSendClicked) => {
        order.push("send");
        onSendClicked();
        return { status: "sent", messageId: `mid-${peerKey}` };
      },
      restoreDraft: async () => {
        order.push("restore");
        return { success: true, message: "restored" };
      },
    });
    await startBatch(harness);
    expect(order).toEqual(["send", "restore"]);
  });

  it("restores the draft after every safe failed send attempt", async () => {
    const restoreDraft = vi.fn(async () => ({ success: true, message: "restored" }));
    const harness = createHarness({
      send: async () => ({ status: "failed", message: "send unavailable" }),
      restoreDraft,
    });
    await startBatch(harness);
    expect(restoreDraft).toHaveBeenCalledTimes(3);
  });

  it("restores the draft after cancellation during preparation", async () => {
    let releaseInsert: ((result: { success: boolean; message: string }) => void) | null = null;
    const restoreDraft = vi.fn(async () => ({ success: true, message: "restored" }));
    const harness = createHarness({
      insert: () => new Promise((resolve) => { releaseInsert = resolve; }),
      restoreDraft,
    });
    const run = harness.coordinator.start([first], harness.sourceRecipient)!;
    await vi.waitFor(() => expect(harness.composer.insert).toHaveBeenCalledOnce());
    harness.coordinator.requestCancel();
    releaseInsert!({ success: true, message: "prepared" });
    await run;
    expect(restoreDraft).toHaveBeenCalledOnce();
    expect(harness.sender.sendPrepared).not.toHaveBeenCalled();
  });

  it("cancels before the first navigation at the deterministic start boundary", async () => {
    const harness = createHarness();

    const run = harness.coordinator.start([second], harness.sourceRecipient)!;
    harness.coordinator.requestCancel();
    const result = await run;

    expect(result.cancelRequested).toBe(true);
    expect(harness.navigator.navigate).toHaveBeenCalledOnce();
    expect(harness.navigator.navigate).toHaveBeenCalledWith(
      harness.sourceRecipient,
      expect.any(AbortSignal),
      "source-restore",
    );
    expect(harness.composer.insert).not.toHaveBeenCalled();
    expect(harness.sender.sendPrepared).not.toHaveBeenCalled();
  });

  it("restores the draft after an exception", async () => {
    const restoreDraft = vi.fn(async () => ({ success: true, message: "restored" }));
    const harness = createHarness({
      insert: async () => { throw new Error("fixture exception"); },
      restoreDraft,
    });
    await startBatch(harness);
    expect(restoreDraft).toHaveBeenCalledOnce();
    expect(harness.composer.cancelPreparedPayload).toHaveBeenCalledOnce();
  });

  it("sends two text recipients sequentially", async () => {
    const order: string[] = [];
    const harness = createHarness({
      navigate: async (recipient) => {
        order.push(`navigate:${recipient.peerKey}`);
        return { success: true, message: "opened" };
      },
      insert: async (_payload, peerKey) => {
        order.push(`prepare:${peerKey}`);
        return { success: true, message: "prepared" };
      },
      send: async (_payload, peerKey, _signal, onSendClicked) => {
        order.push(`send:${peerKey}`);
        onSendClicked();
        return { status: "sent", messageId: `mid-${peerKey}` };
      },
    });
    const result = await startBatch(harness, [first, second]);
    expect(order).toEqual([
      "navigate:101", "prepare:101", "send:101",
      "navigate:202", "prepare:202", "send:202",
      "navigate:101",
    ]);
    expect(result.sentCount).toBe(2);
  });

  it.each([
    ["photo", { kind: "image", image: new Blob(["photo"]), fileName: "photo.jpg" }],
    ["photo with caption", {
      kind: "image",
      image: new Blob(["photo"]),
      fileName: "photo.jpg",
      caption: "caption",
    }],
  ] as const)("sends two recipients with %s through the existing image pipeline", async (_label, payload) => {
    const harness = createHarness({ payload });
    const result = await startBatch(harness, [first, second]);
    expect(harness.composer.insert).toHaveBeenNthCalledWith(1, payload, "101");
    expect(harness.composer.insert).toHaveBeenNthCalledWith(2, payload, "202");
    expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(2);
    expect(result.sentCount).toBe(2);
  });

  it("preserves the user's recipient order", async () => {
    const harness = createHarness();
    await startBatch(harness, [second, first]);
    expect(vi.mocked(harness.navigator.navigate).mock.calls.map(([recipient]) => recipient.peerKey))
      .toEqual(["202", "101", "101"]);
  });

  it("invokes one Send attempt per recipient", async () => {
    const harness = createHarness();
    await startBatch(harness, [first, second]);
    expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(2);
  });

  it("waits for outgoing confirmation before advancing", async () => {
    let confirmFirst: ((result: TelegramSendResult) => void) | null = null;
    const harness = createHarness({
      send: (_payload, peerKey, _signal, onSendClicked) => {
        onSendClicked();
        if (peerKey === "101") {
          return new Promise((resolve) => { confirmFirst = resolve; });
        }
        return Promise.resolve({ status: "sent", messageId: "mid-202" });
      },
    });
    const run = harness.coordinator.start([first, second], harness.sourceRecipient)!;
    await vi.waitFor(() => expect(harness.sender.sendPrepared).toHaveBeenCalledOnce());
    expect(harness.navigator.navigate).toHaveBeenCalledOnce();
    confirmFirst!({ status: "sent", messageId: "mid-101" });
    await run;
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(3);
  });

  it("retries a true pre-Send failure and continues after terminal exhaustion", async () => {
    const harness = createHarness({
      insert: async () => ({ success: false, message: "preview timeout" }),
    });
    const result = await startBatch(harness, [first, second]);
    expect(harness.sender.sendPrepared).not.toHaveBeenCalled();
    expect(result.failedCount).toBe(2);
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(7);
    expect(harness.composer.insert).toHaveBeenCalledTimes(6);
    expect(harness.pending.peek()).toBe(harness.sourcePayload);
  });

  it("marks an ambiguous post-Send result unknown and stops", async () => {
    const harness = createHarness({
      send: async (_payload, _peerKey, _signal, onSendClicked) => {
        onSendClicked();
        return { status: "unknown", message: "no outgoing bubble" };
      },
    });
    const result = await startBatch(harness, [second, first]);
    expect(result.unknownCount).toBe(1);
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(2);
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(
      harness.sourceRecipient,
      expect.any(AbortSignal),
      "source-restore",
    );
    expect(harness.sender.sendPrepared).toHaveBeenCalledOnce();
    expect(harness.pending.peek()).toBeNull();
  });

  it("honors cancellation after a clicked Send and before the next recipient", async () => {
    let confirmFirst: ((result: TelegramSendResult) => void) | null = null;
    const harness = createHarness({
      send: (_payload, _peerKey, _signal, onSendClicked) => {
        onSendClicked();
        return new Promise((resolve) => { confirmFirst = resolve; });
      },
    });
    const run = harness.coordinator.start([second, first], harness.sourceRecipient)!;
    await vi.waitFor(() => expect(harness.sender.sendPrepared).toHaveBeenCalledOnce());
    harness.coordinator.requestCancel();
    confirmFirst!({ status: "sent", messageId: "mid-202" });
    const result = await run;
    expect(result.sentCount).toBe(1);
    expect(result.recipients[1]?.status).toBe("pending");
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(2);
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(
      harness.sourceRecipient,
      expect.any(AbortSignal),
      "source-restore",
    );
  });

  it("restores the source chat after a partial terminal failure", async () => {
    const harness = createHarness({
      insert: async (_payload, peerKey) => peerKey === "202"
        ? { success: false, message: "terminal preparation failure" }
        : { success: true, message: "prepared" },
    });

    const result = await startBatch(harness, [first, second]);

    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(harness.sender.sendPrepared).toHaveBeenCalledOnce();
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(
      harness.sourceRecipient,
      expect.any(AbortSignal),
      "source-restore",
    );
  });

  it("retries navigation mismatch safely without reaching Send", async () => {
    const harness = createHarness({
      navigate: async () => ({ success: false, message: "peer mismatch" }),
    });
    const result = await startBatch(harness, [first, second]);
    expect(result.failedCount).toBe(2);
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(7);
    expect(harness.composer.insert).not.toHaveBeenCalled();
    expect(harness.sender.sendPrepared).not.toHaveBeenCalled();
    expect(result.recipients.every((record) => record.units[0]?.failedBeforeSend)).toBe(true);
    expect(result.recipients.every((record) => record.units[0]?.safeToRetry)).toBe(true);
  });

  it("automatically retries a first pre-Send failure and never duplicates a sent recipient", async () => {
    let secondAttempt = 0;
    const harness = createHarness({
      insert: async (_payload, peerKey) => {
        if (peerKey === "202") {
          secondAttempt += 1;
          return secondAttempt === 1
            ? { success: false, message: "pre-Send failure" }
            : { success: true, message: "prepared" };
        }
        return { success: true, message: "prepared" };
      },
    });
    const result = await startBatch(harness, [first, second]);
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(vi.mocked(harness.sender.sendPrepared).mock.calls.filter(([, peerKey]) => peerKey === "101"))
      .toHaveLength(1);
    expect(vi.mocked(harness.sender.sendPrepared).mock.calls.filter(([, peerKey]) => peerKey === "202"))
      .toHaveLength(1);
    expect(vi.mocked(harness.composer.insert).mock.calls.filter(([, peerKey]) => peerKey === "202"))
      .toHaveLength(2);
    expect(result.recipients[1]).toMatchObject({ attemptCount: 2, retryReason: "pre-Send failure" });
    expect(harness.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("автоматически повторит"),
      expect.objectContaining({ attempt: 1, nextAttempt: 2, reason: "preparation" }),
    );
  });

  it("retries a transient navigation failure and succeeds", async () => {
    let attempts = 0;
    const harness = createHarness({
      navigate: async () => {
        attempts += 1;
        return attempts === 1
          ? { success: false, message: "peer not ready" }
          : { success: true, message: "opened" };
      },
    });

    const result = await startBatch(harness);

    expect(result.sentCount).toBe(1);
    expect(vi.mocked(harness.navigator.navigate).mock.calls.filter(([, , intent]) =>
      intent === "destination")).toHaveLength(2);
    expect(vi.mocked(harness.navigator.navigate).mock.calls.filter(([, , intent]) =>
      intent === "source-restore")).toHaveLength(1);
    expect(harness.sender.sendPrepared).toHaveBeenCalledOnce();
    expect(result.recipients[0]).toMatchObject({ attemptCount: 2, retryReason: "peer not ready" });
  });

  it("retries an unavailable Send control only when no click occurred", async () => {
    let attempts = 0;
    const harness = createHarness({
      send: async (_payload, peerKey, _signal, onSendClicked) => {
        attempts += 1;
        if (attempts === 1) {
          return { status: "failed", message: "send button unavailable" };
        }
        onSendClicked();
        return { status: "sent", messageId: `mid-${peerKey}` };
      },
    });

    const result = await startBatch(harness);

    expect(result.sentCount).toBe(1);
    expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(2);
    expect(result.recipients[0]).toMatchObject({
      attemptCount: 2,
      retryReason: "send button unavailable",
      sendClicked: true,
    });
  });

  it.each([1, 2, 10, 50, 100])(
    "delivers %i sequential recipients under delayed DOM without duplicates or wrong peers",
    async (count) => {
      const recipients = Array.from({ length: count }, (_, index): Recipient => ({
        peerKey: `${10_000 + index}`,
        title: `Recipient ${index}`,
        supported: true,
      }));
      const sentPeers: string[] = [];
      const harness = createHarness({
        navigate: async () => {
          await Promise.resolve();
          return { success: true, message: "opened" };
        },
        insert: async () => {
          await Promise.resolve();
          return { success: true, message: "prepared" };
        },
        send: async (_payload, peerKey, _signal, onSendClicked) => {
          await Promise.resolve();
          onSendClicked();
          sentPeers.push(peerKey);
          return { status: "sent", messageId: `mid-${peerKey}` };
        },
      });

      const result = await startBatch(harness, recipients);

      expect(result.sentCount).toBe(count);
      expect(result.failedCount).toBe(0);
      expect(result.unknownCount).toBe(0);
      expect(sentPeers).toEqual(recipients.map((recipient) => recipient.peerKey));
      expect(new Set(sentPeers).size).toBe(count);
      expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(count);
      expect(harness.navigator.navigate).toHaveBeenLastCalledWith(
        harness.sourceRecipient,
        expect.any(AbortSignal),
        "source-restore",
      );
    },
  );

  it.each([
    { sourceCount: 1, recipientCount: 1 },
    { sourceCount: 1, recipientCount: 3 },
    { sourceCount: 3, recipientCount: 1 },
    { sourceCount: 3, recipientCount: 3 },
  ])(
    "delivers $sourceCount source units × $recipientCount recipients in recipient-major order",
    async ({ sourceCount, recipientCount }) => {
      const sourcePayload = createTextBundlePayload(
        Array.from({ length: sourceCount }, (_, index) => `source-${index}`),
      );
      const recipients = Array.from({ length: recipientCount }, (_, index): Recipient => ({
        peerKey: `${700 + index}`,
        title: `Recipient ${index}`,
        supported: true,
      }));
      const pairs: string[] = [];
      const harness = createHarness({
        sourcePayload,
        send: async (payload, peerKey, _signal, onSendClicked) => {
          const text = payload.kind === "text" ? payload.text : "media";
          pairs.push(`${peerKey}:${text}`);
          onSendClicked();
          return { status: "sent", messageId: `mid-${peerKey}-${text}` };
        },
      });

      const result = await startBatch(harness, recipients);

      expect(pairs).toEqual(recipients.flatMap((recipient) =>
        Array.from({ length: sourceCount }, (_, index) => `${recipient.peerKey}:source-${index}`)));
      expect(result.sentCount).toBe(recipientCount);
      expect(result.recipients.every((record) =>
        record.units.every((unit) => unit.outgoingConfirmed && !unit.safeToRetry))).toBe(true);
    },
  );

  it("safely includes the source chat in the immutable destination order", async () => {
    const order: string[] = [];
    const harness = createHarness({
      navigate: async (recipient) => {
        order.push(`navigate:${recipient.peerKey}`);
        return { success: true, message: "opened" };
      },
      send: async (_payload, peerKey, _signal, onSendClicked) => {
        order.push(`send:${peerKey}`);
        onSendClicked();
        return { status: "sent", messageId: `mid-${peerKey}` };
      },
    });

    const result = await startBatch(harness, [sourceChat, second]);

    expect(order).toEqual([
      "navigate:101", "send:101",
      "navigate:202", "send:202",
      "navigate:101",
    ]);
    expect(result.sentCount).toBe(2);
  });

  it("keeps delivery statuses terminal when source-chat restoration fails", async () => {
    const harness = createHarness({
      navigate: async (recipient) => recipient.peerKey === sourceChat.peerKey
        ? { success: false, message: "source row unavailable" }
        : { success: true, message: "opened" },
    });

    const result = await startBatch(harness, [second]);

    expect(result.sentCount).toBe(1);
    expect(result.recipients[0]?.units[0]).toMatchObject({
      status: "sent",
      outgoingConfirmed: true,
      safeToRetry: false,
    });
    expect(harness.log.error).toHaveBeenCalledWith(
      "Failed to restore the source chat after delivery batch.",
      "source row unavailable",
    );
    expect(result.safetyFailure).toContain("Source chat restoration could not be confirmed");
    expect(harness.progress.hide).not.toHaveBeenCalled();
    expect(harness.coordinator.hasOpenBatch()).toBe(true);
  });

  it("finishes the batch and surfaces safety failure when source restoration throws", async () => {
    const harness = createHarness({
      navigate: async (recipient) => {
        if (recipient.peerKey === sourceChat.peerKey) {
          throw new Error("source navigator crashed");
        }
        return { success: true, message: "opened" };
      },
    });

    const result = await startBatch(harness, [second]);

    expect(result.running).toBe(false);
    expect(result.sentCount).toBe(1);
    expect(result.recipients[0]?.units[0]).toMatchObject({
      status: "sent",
      outgoingConfirmed: true,
      safeToRetry: false,
    });
    expect(result.safetyFailure).toContain("source navigator crashed");
    expect(harness.progress.hide).not.toHaveBeenCalled();
    expect(harness.coordinator.hasOpenBatch()).toBe(true);
  });

  it("uses an immutable source-recipient snapshot for the mandatory restore", async () => {
    let releaseDestination: ((result: ChatNavigationResult) => void) | null = null;
    const harness = createHarness({
      navigate: (_recipient, _signal, intent) => intent === "source-restore"
        ? Promise.resolve({ success: true, message: "source restored" })
        : new Promise((resolve) => { releaseDestination = resolve; }),
    });
    const originalTitle = harness.sourceRecipient.title;
    const run = harness.coordinator.start([second], harness.sourceRecipient)!;
    await vi.waitFor(() => expect(releaseDestination).not.toBeNull());

    Object.assign(harness.sourceRecipient, {
      title: "Mutated after start",
      searchQuery: "@mutated_after_start",
    });
    releaseDestination!({ success: true, message: "opened" });
    await run;

    const restoreCall = vi.mocked(harness.navigator.navigate).mock.calls.find(([, , intent]) =>
      intent === "source-restore");
    expect(restoreCall?.[0]).toEqual({
      peerKey: sourceChat.peerKey,
      title: originalTitle,
      supported: true,
    });
    expect(Object.isFrozen(restoreCall?.[0])).toBe(true);
  });

  it("does not skip source restoration when a stale source composer contradicts the active topbar", async () => {
    const column = document.createElement("section");
    column.id = "column-center";
    const chats = document.createElement("div");
    chats.className = "chats-container";
    const chat = document.createElement("div");
    chat.className = "chat tabs-tab active";
    const topbar = document.createElement("div");
    topbar.className = "topbar";
    const avatar = document.createElement("div");
    avatar.className = "person-avatar";
    avatar.dataset.peerId = second.peerKey;
    topbar.append(avatar);
    const owner = document.createElement("div");
    owner.className = "chat-input chat-input-main";
    const composer = document.createElement("div");
    composer.className = "input-message-input";
    composer.contentEditable = "true";
    composer.dataset.peerId = sourceChat.peerKey;
    owner.append(composer);
    chat.append(topbar, owner);
    chats.append(chat);
    column.append(chats);
    document.body.append(column);
    const harness = createHarness();

    const result = await startBatch(harness, [second]);

    expect(result.safetyFailure).toBeUndefined();
    expect(vi.mocked(harness.navigator.navigate).mock.calls.filter(([, , intent]) =>
      intent === "source-restore")).toHaveLength(1);
  });

  it("stops all remaining work when prepared-content cleanup cannot be confirmed", async () => {
    const harness = createHarness({
      insert: async () => ({ success: false, message: "preview failed" }),
      cancelPreparedUnit: async () => false,
    });

    const result = await startBatch(harness, [second, first]);

    expect(result.running).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.retryableCount).toBe(0);
    expect(result.safetyFailure).toContain("Prepared content cleanup could not be confirmed");
    expect(harness.composer.prepareUnit).toHaveBeenCalledOnce();
    expect(harness.composer.cancelPreparedUnit).toHaveBeenCalledOnce();
    expect(harness.sender.sendPreparedUnit).not.toHaveBeenCalled();
    expect(result.recipients[1]?.status).toBe("pending");
    expect(harness.coordinator.retryFailed()).toBeNull();
  });

  it("stops later recipients when draft restoration fails without changing sent status", async () => {
    const harness = createHarness({
      restoreDraft: async () => ({ success: false, message: "draft DOM was replaced" }),
    });

    const result = await startBatch(harness, [second, first]);

    expect(result.sentCount).toBe(1);
    expect(result.recipients[0]?.units[0]).toMatchObject({
      status: "sent",
      outgoingConfirmed: true,
      safeToRetry: false,
    });
    expect(result.recipients[1]?.status).toBe("pending");
    expect(result.retryableCount).toBe(0);
    expect(result.safetyFailure).toContain("draft DOM was replaced");
    expect(harness.sender.sendPreparedUnit).toHaveBeenCalledOnce();
    expect(harness.progress.hide).not.toHaveBeenCalled();
    expect(harness.coordinator.retryFailed()).toBeNull();
  });

  it("delivers every bundle unit in source order under one draft transaction", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two", "three"]);
    const harness = createHarness({ sourcePayload });

    const result = await startBatch(harness);

    expect(vi.mocked(harness.composer.insert).mock.calls.map(([item]) =>
      item.kind === "text" ? item.text : item.kind)).toEqual(["one", "two", "three"]);
    expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(3);
    expect(harness.composer.beginDraftTransaction).toHaveBeenCalledOnce();
    expect(result.recipients[0]?.units?.map((unit) => unit.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("does not replay a confirmed unit when a later unit fails before Send", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two"]);
    let secondAttempts = 0;
    const harness = createHarness({
      sourcePayload,
      insert: async (item) => {
        if (item.kind === "text" && item.text === "two") {
          secondAttempts += 1;
          if (secondAttempts === 1) return { success: false, message: "preview not ready" };
        }
        return { success: true, message: "prepared" };
      },
    });

    const result = await startBatch(harness);

    const sentTexts = vi.mocked(harness.sender.sendPrepared).mock.calls.map(([item]) =>
      item.kind === "text" ? item.text : item.kind);
    expect(sentTexts).toEqual(["one", "two"]);
    expect(result.recipients[0]?.units?.[0]).toMatchObject({ status: "sent", attemptCount: 1, safeToRetry: false });
    expect(result.recipients[0]?.units?.[1]).toMatchObject({ status: "sent", attemptCount: 2, safeToRetry: false });
  });

  it("applies the automatic pre-Send retry budget independently to each bundle unit", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two"]);
    const attempts = new Map<string, number>();
    const harness = createHarness({
      sourcePayload,
      insert: async (item) => {
        const text = item.kind === "text" ? item.text : item.kind;
        const attempt = (attempts.get(text) ?? 0) + 1;
        attempts.set(text, attempt);
        return attempt < 3
          ? { success: false, message: `${text} not ready` }
          : { success: true, message: "prepared" };
      },
    });

    const result = await startBatch(harness);

    expect(attempts).toEqual(new Map([["one", 3], ["two", 3]]));
    expect(harness.sender.sendPreparedUnit).toHaveBeenCalledTimes(2);
    expect(result.sentCount).toBe(1);
    expect(result.recipients[0]?.units.map((item) => item.attemptCount)).toEqual([3, 3]);
  });

  it("manual retry resumes only a definitely failed unit and never duplicates earlier confirmation", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two"]);
    const harness = createHarness({
      sourcePayload,
      insert: async (item) => item.kind === "text" && item.text === "two"
        ? { success: false, message: "terminal pre-Send failure" }
        : { success: true, message: "prepared" },
    });
    const firstRun = await startBatch(harness);
    expect(firstRun.failedCount).toBe(1);

    vi.mocked(harness.composer.insert).mockResolvedValue({ success: true, message: "prepared" });
    const retry = harness.coordinator.retryFailed();
    if (!retry) throw new Error("Retry did not start");
    const result = await retry;

    const sentTexts = vi.mocked(harness.sender.sendPrepared).mock.calls.map(([item]) =>
      item.kind === "text" ? item.text : item.kind);
    expect(sentTexts).toEqual(["one", "two"]);
    expect(result.sentCount).toBe(1);
  });

  it("stops the bundle after an ambiguous post-Send result without replay or later effects", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two", "three"]);
    const harness = createHarness({
      sourcePayload,
      send: async (item, peerKey, _signal, onSendClicked) => {
        onSendClicked();
        return item.kind === "text" && item.text === "two"
          ? { status: "unknown", message: "confirmation timeout" }
          : { status: "sent", messageId: `mid-${peerKey}-${item.kind === "text" ? item.text : "media"}` };
      },
    });

    const result = await startBatch(harness);

    expect(harness.sender.sendPrepared).toHaveBeenCalledTimes(2);
    expect(result.unknownCount).toBe(1);
    expect(result.recipients[0]?.units?.map((unit) => unit.status)).toEqual([
      "sent", "unknown-after-send", "pending",
    ]);
    expect(result.recipients[0]?.units?.[1]?.safeToRetry).toBe(false);
  });

  it("confirms an album only with its complete outgoing identity set", async () => {
    const sourcePayload = createAlbumPayload();
    const harness = createHarness({
      sourcePayload,
      prepareUnit: async () => ({ success: true, message: "album ready" }),
      sendUnit: async (_unit, _peerKey, _signal, onSendClicked) => {
        onSendClicked();
        return { status: "sent", messageId: "album-mid-1", messageIds: ["album-mid-1", "album-mid-2"] };
      },
    });

    const result = await startBatch(harness);

    expect(harness.sender.sendPreparedUnit).toHaveBeenCalledOnce();
    expect(result.recipients[0]?.units?.[0]).toMatchObject({
      status: "sent",
      messageIds: ["album-mid-1", "album-mid-2"],
      safeToRetry: false,
    });
  });

  it("marks an incomplete post-Send album receipt unknown and forbids retry", async () => {
    const sourcePayload = createAlbumPayload();
    const harness = createHarness({
      sourcePayload,
      prepareUnit: async () => ({ success: true, message: "album ready" }),
      sendUnit: async (_unit, _peerKey, _signal, onSendClicked) => {
        onSendClicked();
        return { status: "sent", messageId: "only-one-mid", messageIds: ["only-one-mid"] };
      },
    });

    const result = await startBatch(harness);

    expect(result.unknownCount).toBe(1);
    expect(result.retryableCount).toBe(0);
    expect(result.recipients[0]?.units[0]).toMatchObject({
      status: "unknown-after-send",
      sendClicked: true,
      outgoingConfirmed: false,
      unknownAfterSend: true,
      safeToRetry: false,
    });
    expect(harness.coordinator.retryFailed()).toBeNull();
  });

  it("delivers a mixed text and album bundle without crossing unit boundaries", async () => {
    const order: string[] = [];
    const sourcePayload = createMixedPayload();
    const harness = createHarness({
      sourcePayload,
      prepareUnit: async (unit) => {
        order.push(`prepare:${unit.kind}`);
        return { success: true, message: "ready" };
      },
      sendUnit: async (unit, _peerKey, _signal, onSendClicked) => {
        order.push(`send:${unit.kind}`);
        onSendClicked();
        return unit.kind === "media-group"
          ? { status: "sent", messageId: "album-1", messageIds: ["album-1", "album-2"] }
          : { status: "sent", messageId: "text-1" };
      },
    });

    const result = await startBatch(harness);

    expect(order).toEqual(["prepare:text", "send:text", "prepare:media-group", "send:media-group"]);
    expect(result.sentCount).toBe(1);
  });

  it("honors cancellation after reconciliation and before the next bundle item", async () => {
    const sourcePayload = createTextBundlePayload(["one", "two"]);
    const harness = createHarness({ sourcePayload });
    vi.mocked(harness.sender.sendPreparedUnit).mockImplementation(async (unit, peerKey, _signal, onSendClicked) => {
      onSendClicked();
      harness.coordinator.requestCancel();
      return { status: "sent", messageId: `mid-${peerKey}-${unit.source[0]?.mid}` };
    });

    const result = await startBatch(harness);

    expect(harness.sender.sendPreparedUnit).toHaveBeenCalledOnce();
    expect(result.recipients[0]?.units?.map((unit) => unit.status)).toEqual(["sent", "pending"]);
    expect(result.cancelRequested).toBe(true);
  });

  it("does not start two batches from a double Next", async () => {
    let releaseNavigation: ((result: ChatNavigationResult) => void) | null = null;
    const harness = createHarness({
      navigate: (_recipient, _signal, intent) => intent === "source-restore"
        ? Promise.resolve({ success: true, message: "source restored" })
        : new Promise((resolve) => { releaseNavigation = resolve; }),
    });
    const firstRun = harness.coordinator.start([first], harness.sourceRecipient);
    const secondRun = harness.coordinator.start([first], harness.sourceRecipient);
    expect(firstRun).not.toBeNull();
    expect(secondRun).toBeNull();
    await Promise.resolve();
    releaseNavigation!({ success: true, message: "opened" });
    await firstRun;
    expect(vi.mocked(harness.navigator.navigate).mock.calls.filter(([, , intent]) =>
      intent === "destination")).toHaveLength(1);
    expect(vi.mocked(harness.navigator.navigate).mock.calls.filter(([, , intent]) =>
      intent === "source-restore")).toHaveLength(1);
  });
});
