import { describe, expect, it } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientSelection } from "../../src/recipient/RecipientSelection";

const recipientA: Recipient = { peerKey: "1", title: "Fixture recipient A", supported: true };
const recipientB: Recipient = { peerKey: "2", title: "Fixture recipient B", supported: true };

describe("RecipientSelection", () => {
  it("starts empty", () => {
    const selection = new RecipientSelection();
    expect(selection.count()).toBe(0);
    expect(selection.snapshot()).toEqual([]);
  });

  it("adds one recipient", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    expect(selection.peerKeys()).toEqual(["1"]);
  });

  it("adds multiple recipients in selection order", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    selection.toggle(recipientB);
    expect(selection.snapshot()).toEqual([recipientA, recipientB]);
  });

  it("removes an already selected recipient", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    selection.toggle(recipientA);
    expect(selection.count()).toBe(0);
  });

  it("does not create duplicate peerId entries", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    selection.toggle({ ...recipientA, title: "Duplicate fixture" });
    expect(selection.count()).toBe(0);
  });

  it("is independent of filtered presentation lists", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    const filteredRows = [recipientB];
    expect(filteredRows).not.toContain(recipientA);
    expect(selection.peerKeys()).toEqual(["1"]);
  });

  it("clears every selected recipient", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    selection.toggle(recipientB);
    selection.clear();
    expect(selection.snapshot()).toEqual([]);
  });

  it("returns an immutable snapshot", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    const snapshot = selection.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it("keeps internal state unchanged when the source or snapshot is mutated", () => {
    const source: Recipient = { peerKey: "3", title: "Fixture before", supported: true };
    const selection = new RecipientSelection();
    selection.toggle(source);
    (source as { title: string }).title = "Fixture after";
    expect(selection.snapshot()[0]?.title).toBe("Fixture before");
    expect(() => {
      (selection.snapshot()[0] as { title: string }).title = "Mutated fixture";
    }).toThrow();
    expect(selection.snapshot()[0]?.title).toBe("Fixture before");
  });

  it("supports selecting again after clear", () => {
    const selection = new RecipientSelection();
    selection.toggle(recipientA);
    selection.clear();
    selection.toggle(recipientB);
    expect(selection.peerKeys()).toEqual(["2"]);
  });

  it("ignores unsupported recipients", () => {
    const selection = new RecipientSelection();
    selection.toggle({ peerKey: "4_9", title: "Unsupported fixture", supported: false });
    expect(selection.count()).toBe(0);
  });
});
