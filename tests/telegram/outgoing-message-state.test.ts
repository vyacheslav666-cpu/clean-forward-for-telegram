import { describe, expect, it } from "vitest";
import {
  findOutgoingInFlight,
  isOutgoingAcknowledged,
  isOutgoingInFlight,
  isOutgoingRejected,
  isTemporaryMessageId,
  OutgoingInFlightBaseline,
} from "../../src/telegram/outgoingMessageState";

function appendBubble(classes: string, messageId?: string, peerKey = "99"): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `bubble is-out ${classes}`.trim();
  bubble.dataset.peerId = peerKey;
  if (messageId !== undefined) {
    bubble.dataset.mid = messageId;
  }
  document.body.append(bubble);
  return bubble;
}

describe("outgoingMessageState", () => {
  it("reads the sending state Web K actually renders", () => {
    const bubble = appendBubble("is-outgoing is-sending", "1001.0001");
    expect(isOutgoingInFlight(bubble)).toBe(true);
    expect(isOutgoingAcknowledged(bubble)).toBe(false);
    expect(isOutgoingRejected(bubble)).toBe(false);
  });

  it("treats a temporary fractional data-mid as unconfirmed even without a sending class", () => {
    // Web K assigns serverId + fraction before the server answers, so an id alone proves nothing.
    const bubble = appendBubble("", "1001.0001");
    expect(isOutgoingInFlight(bubble)).toBe(true);
    expect(isOutgoingAcknowledged(bubble)).toBe(false);
  });

  it("acknowledges a message only once it carries a server id and no pending markers", () => {
    const bubble = appendBubble("", "1002");
    expect(isOutgoingInFlight(bubble)).toBe(false);
    expect(isOutgoingAcknowledged(bubble)).toBe(true);
  });

  it("never acknowledges a message Telegram rejected", () => {
    const bubble = appendBubble("is-outgoing is-sending is-error", "1003");
    expect(isOutgoingRejected(bubble)).toBe(true);
    expect(isOutgoingAcknowledged(bubble)).toBe(false);
  });

  it("still recognizes the legacy sending class of older Web K builds", () => {
    const bubble = appendBubble("sending", "1004");
    expect(isOutgoingInFlight(bubble)).toBe(true);
    expect(isOutgoingAcknowledged(bubble)).toBe(false);
  });

  it("resolves grouped album items through the bubble that owns their state", () => {
    const bubble = appendBubble("is-outgoing is-sending");
    const item = document.createElement("div");
    item.className = "grouped-item";
    item.dataset.mid = "1005";
    bubble.append(item);

    expect(isOutgoingInFlight(item)).toBe(true);
    expect(isOutgoingAcknowledged(item)).toBe(false);

    bubble.classList.remove("is-outgoing", "is-sending");
    expect(isOutgoingAcknowledged(item)).toBe(true);
  });

  it("reports one entry per in-flight message regardless of how many markers it carries", () => {
    const sending = appendBubble("is-outgoing is-sending", "1006.0001");
    const item = document.createElement("div");
    item.className = "grouped-item";
    item.dataset.mid = "1006.0001";
    sending.append(item);
    appendBubble("", "1007");

    expect(findOutgoingInFlight(document)).toEqual([sending]);
  });

  it("leaves out a send Telegram already rejected, because it will never finish", () => {
    appendBubble("is-outgoing is-sending is-error", "1008.0001");
    expect(findOutgoingInFlight(document)).toEqual([]);
  });

  it("excludes messages that were already in flight when the snapshot was taken", () => {
    const stuck = appendBubble("is-outgoing is-sending", "1009.0001");
    const baseline = new OutgoingInFlightBaseline(document);
    expect(baseline.findNew(document)).toEqual([]);

    const fresh = appendBubble("is-outgoing is-sending", "1010.0001");
    expect(baseline.findNew(document)).toEqual([fresh]);
    expect(stuck.isConnected).toBe(true);
  });

  it("keeps excluding a stuck message after Web K rebuilds its bubble", () => {
    // A chat switch rerenders bubbles, so node identity alone would make the same stuck message
    // look new the moment the chat is reopened. The temporary id survives that rebuild.
    const stuck = appendBubble("is-outgoing is-sending", "1011.0001");
    const baseline = new OutgoingInFlightBaseline(document);
    stuck.remove();
    appendBubble("is-outgoing is-sending", "1011.0001");

    expect(baseline.findNew(document)).toEqual([]);
  });

  it("classifies message ids", () => {
    expect(isTemporaryMessageId("1001.0001")).toBe(true);
    expect(isTemporaryMessageId("1001")).toBe(false);
    expect(isTemporaryMessageId("late-mid")).toBe(false);
    expect(isTemporaryMessageId(null)).toBe(false);
  });
});
