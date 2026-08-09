import { describe, expect, it, vi } from "vitest";
import { observeDom } from "../../src/utils/observeDom";

describe("observeDom", () => {
  it.each(["class", "data-peer-id", "data-mid"])(
    "reports an attribute-only %s transition on a reused Telegram node",
    async (attribute) => {
      const node = document.createElement("div");
      document.body.append(node);
      const callback = vi.fn();
      const observation = observeDom(document.documentElement, callback);

      try {
        node.setAttribute(attribute, "changed");
        await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
      } finally {
        observation.disconnect();
      }
    },
  );

  it("still collapses an attribute mutation burst into one callback", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    const callback = vi.fn();
    const observation = observeDom(document.documentElement, callback);

    try {
      node.className = "sending";
      node.dataset.mid = "fixture-mid";
      node.dataset.peerId = "fixture-peer";
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    } finally {
      observation.disconnect();
    }
  });
});
