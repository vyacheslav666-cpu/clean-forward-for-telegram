import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMessageGroup } from "../../src/telegram/TelegramModelBridge";

const PEER = "20";
const MID = 70;

/** One album member as Telegram's own storage shapes it. */
function message(mid: number, groupedId: unknown = "9001", peerId: unknown = 20) {
  return { mid, peerId, grouped_id: groupedId };
}

/** Installs a proxy exposing only what the bridge is allowed to touch. */
function installProxy(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal("apiManagerProxy", {
    getMessageByPeer: () => message(MID),
    getMessagesByGroupedId: () => [message(MID), message(71), message(72)],
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Telegram model bridge", () => {
  it("resolves the album a message belongs to", () => {
    installProxy();
    expect(resolveMessageGroup(PEER, MID)).toEqual({ groupedId: "9001", expectedItemCount: 3 });
  });

  it("keeps grouped_id as a string so two 64-bit albums cannot collide", () => {
    const groupedId = "13835058055282163712";
    installProxy({
      getMessageByPeer: () => message(MID, groupedId),
      getMessagesByGroupedId: () => [message(MID, groupedId), message(71, groupedId)],
    });
    expect(resolveMessageGroup(PEER, MID)?.groupedId).toBe(groupedId);
  });

  it("returns null when Telegram exposes no proxy at all", () => {
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it("returns null when a method the bridge needs is gone", () => {
    installProxy({ getMessagesByGroupedId: undefined });
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it("returns null instead of propagating a throw from Telegram", () => {
    installProxy({
      getMessagesByGroupedId: () => {
        throw new Error("upstream changed underneath the tab");
      },
    });
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it.each([
    ["an empty group", () => []],
    ["a single-member group", () => [message(MID)]],
    ["a group with a hole in storage", () => [message(MID), undefined]],
    ["a member of another album", () => [message(MID), message(71, "other")]],
    ["a group the message is not in", () => [message(80), message(81)]],
  ])("returns null for %s", (_name, getMessagesByGroupedId) => {
    installProxy({ getMessagesByGroupedId });
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it.each([
    ["the message is not grouped", { grouped_id: undefined }],
    ["grouped_id is zero", { grouped_id: "0" }],
    ["the message answers for another peer", { peerId: 999 }],
    ["the message answers for another mid", { mid: 999 }],
  ])("returns null when %s", (_name, overrides) => {
    installProxy({ getMessageByPeer: () => ({ ...message(MID), ...overrides }) });
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it("re-checks the proxy on every call instead of trusting an earlier answer", () => {
    installProxy();
    expect(resolveMessageGroup(PEER, MID)).not.toBeNull();
    // Telegram can be replaced underneath an open tab; a capability proven once proves nothing now.
    vi.unstubAllGlobals();
    expect(resolveMessageGroup(PEER, MID)).toBeNull();
  });

  it("never reaches Telegram with an identity it cannot use", () => {
    const getMessageByPeer = vi.fn(() => message(MID));
    installProxy({ getMessageByPeer });
    expect(resolveMessageGroup("", MID)).toBeNull();
    expect(resolveMessageGroup(PEER, Number.NaN)).toBeNull();
    expect(getMessageByPeer).not.toHaveBeenCalled();
  });
});
