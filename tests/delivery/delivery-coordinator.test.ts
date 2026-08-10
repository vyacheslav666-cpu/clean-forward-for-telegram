import { describe, expect, it, vi } from "vitest";
import { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import type { AppConfig } from "../../src/config";
import type { DeliveryBatchSnapshot } from "../../src/delivery/DeliveryBatch";
import type { MessagePayload } from "../../src/domain/MessagePayload";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { Recipient } from "../../src/recipient/Recipient";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { ChatNavigationResult, TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import type { TelegramSendAdapter, TelegramSendResult } from "../../src/telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";
import { createLogger } from "../helpers";

const first: Recipient = { peerKey: "101", title: "First", supported: true };
const second: Recipient = { peerKey: "202", title: "Second", supported: true };
const sourceChat: Recipient = { peerKey: "101", title: "Source", supported: true };

interface HarnessOptions {
  readonly showDeliveryResultDialog?: boolean;
  readonly payload?: MessagePayload;
  readonly navigate?: (recipient: Readonly<Recipient>, signal: AbortSignal) => Promise<ChatNavigationResult>;
  readonly insert?: (payload: MessagePayload, peerKey: string) => Promise<{ success: boolean; message: string }>;
  readonly send?: (
    payload: MessagePayload,
    peerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ) => Promise<TelegramSendResult>;
  readonly restoreDraft?: () => Promise<{ success: boolean; message: string }>;
}

function createHarness(options: HarnessOptions = {}) {
  const payload = options.payload ?? { kind: "text", text: "payload" };
  const pending = new PendingTransfer();
  pending.select(payload);
  const navigator = {
    navigate: vi.fn(options.navigate ?? (async () => ({ success: true, message: "opened" }))),
    notifyDomChanged: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TelegramChatNavigator;
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
    insert: vi.fn(options.insert ?? (async () => ({ success: true, message: "prepared" }))),
    cancelPreparedPayload: vi.fn(async () => true),
  } as unknown as ComposerAdapter;
  const sender = {
    sendPrepared: vi.fn(options.send ?? (async (_payload, peerKey, _signal, onSendClicked) => {
      onSendClicked();
      return { status: "sent", messageId: `mid-${peerKey}` };
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
  return { coordinator, payload, pending, navigator, composer, sender, progress, log };
}

async function startBatch(
  harness: ReturnType<typeof createHarness>,
  recipients: readonly Recipient[] = [first],
): Promise<DeliveryBatchSnapshot> {
  const run = harness.coordinator.start(recipients, sourceChat);
  if (!run) throw new Error("Batch did not start");
  return run;
}

describe("DeliveryCoordinator", () => {
  it("automatically sends one text recipient", async () => {
    const harness = createHarness();
    const result = await startBatch(harness);
    expect(harness.navigator.navigate).toHaveBeenCalledWith(first, expect.any(AbortSignal));
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
    const run = harness.coordinator.start([first], sourceChat)!;
    await vi.waitFor(() => expect(harness.composer.insert).toHaveBeenCalledOnce());
    harness.coordinator.requestCancel();
    releaseInsert!({ success: true, message: "prepared" });
    await run;
    expect(restoreDraft).toHaveBeenCalledOnce();
    expect(harness.sender.sendPrepared).not.toHaveBeenCalled();
  });

  it("cancels before the first navigation at the deterministic start boundary", async () => {
    const harness = createHarness();

    const run = harness.coordinator.start([second], sourceChat)!;
    harness.coordinator.requestCancel();
    const result = await run;

    expect(result.cancelRequested).toBe(true);
    expect(harness.navigator.navigate).not.toHaveBeenCalled();
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
    const run = harness.coordinator.start([first, second], sourceChat)!;
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
    expect(harness.pending.peek()).toBe(harness.payload);
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
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(sourceChat, expect.any(AbortSignal));
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
    const run = harness.coordinator.start([second, first], sourceChat)!;
    await vi.waitFor(() => expect(harness.sender.sendPrepared).toHaveBeenCalledOnce());
    harness.coordinator.requestCancel();
    confirmFirst!({ status: "sent", messageId: "mid-202" });
    const result = await run;
    expect(result.sentCount).toBe(1);
    expect(result.recipients[1]?.status).toBe("pending");
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(2);
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(sourceChat, expect.any(AbortSignal));
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
    expect(harness.navigator.navigate).toHaveBeenLastCalledWith(sourceChat, expect.any(AbortSignal));
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
    expect(harness.navigator.navigate).toHaveBeenCalledTimes(2);
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
        sourceChat,
        expect.any(AbortSignal),
      );
    },
  );

  it("does not start two batches from a double Next", async () => {
    let releaseNavigation: ((result: ChatNavigationResult) => void) | null = null;
    const harness = createHarness({
      navigate: () => new Promise((resolve) => { releaseNavigation = resolve; }),
    });
    const firstRun = harness.coordinator.start([first], sourceChat);
    const secondRun = harness.coordinator.start([first], sourceChat);
    expect(firstRun).not.toBeNull();
    expect(secondRun).toBeNull();
    await Promise.resolve();
    releaseNavigation!({ success: true, message: "opened" });
    await firstRun;
    expect(harness.navigator.navigate).toHaveBeenCalledOnce();
  });
});
