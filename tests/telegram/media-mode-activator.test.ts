import { describe, expect, it, vi } from "vitest";
import { MediaModeActivator } from "../../src/telegram/MediaModeActivator";
import { installComposer } from "../helpers";

/**
 * Builds the composer shape Web K renders around the attach control. The attach button is the
 * `attach-menu-button` custom element; the `attach-file` class it used to carry has been dropped.
 */
function installAttachComposer({ legacyClass = false } = {}) {
  const composer = installComposer("8");
  const container = composer.parentElement!;
  const wrapper = document.createElement("div");
  wrapper.className = "new-message-wrapper";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*, video/*";
  wrapper.append(fileInput);
  const attach = document.createElement("attach-menu-button");
  if (legacyClass) {
    attach.classList.add("attach-file");
  }
  wrapper.append(attach);
  container.append(wrapper);
  return { composer, container, fileInput, attach };
}

/** Mirrors Telegram: the menu is built only after an awaited request, then marked `menu-open`. */
function openMenuAfter(attach: HTMLElement, delayMs: number, label = "Photo or Video"): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "btn-menu";
  const item = document.createElement("div");
  item.className = "btn-menu-item";
  item.innerHTML = `<span class="btn-menu-item-text">${label}</span>`;
  menu.append(item);
  attach.addEventListener("click", () => {
    if (attach.classList.contains("menu-open")) {
      attach.classList.remove("menu-open");
      menu.classList.remove("active");
      return;
    }
    window.setTimeout(() => {
      document.body.append(menu);
      menu.classList.add("active");
      attach.classList.add("menu-open");
    }, delayMs);
  });
  return menu;
}

describe("MediaModeActivator", () => {
  it("finds the attach control without the dropped attach-file class", async () => {
    const fixture = installAttachComposer();
    const menu = openMenuAfter(fixture.attach, 0);
    fixture.fileInput.addEventListener("click", (event) => event.preventDefault());
    menu.querySelector(".btn-menu-item")!.addEventListener("click", () => {
      fixture.fileInput.click();
    });

    const armed = await new MediaModeActivator().arm("media");

    expect(armed.fileInput).toBe(fixture.fileInput);
    expect(armed.peerId).toBe("8");
  });

  it("still accepts the legacy attach-file markup", async () => {
    const fixture = installAttachComposer({ legacyClass: true });
    const menu = openMenuAfter(fixture.attach, 0);
    fixture.fileInput.addEventListener("click", (event) => event.preventDefault());
    menu.querySelector(".btn-menu-item")!.addEventListener("click", () => {
      fixture.fileInput.click();
    });

    await expect(new MediaModeActivator().arm("media")).resolves.toMatchObject({ peerId: "8" });
  });

  it("waits past two seconds, because Telegram fetches attach bots before building the menu", async () => {
    const fixture = installAttachComposer();
    const menu = openMenuAfter(fixture.attach, 3_000);
    fixture.fileInput.addEventListener("click", (event) => event.preventDefault());
    menu.querySelector(".btn-menu-item")!.addEventListener("click", () => {
      fixture.fileInput.click();
    });

    await expect(new MediaModeActivator().arm("media")).resolves.toMatchObject({ peerId: "8" });
  }, 15_000);

  it("leaves no menu open when the menu appears only after activation gave up", async () => {
    const fixture = installAttachComposer();
    // No item ever matches, so activation fails; Telegram still opens its menu afterwards.
    const menu = openMenuAfter(fixture.attach, 200, "Unrelated action");
    const toggleClicks = vi.spyOn(fixture.attach, "click");

    await expect(new MediaModeActivator().arm("media")).rejects.toMatchObject({
      code: "media-mode-unavailable",
    });

    // A menu left hanging over the chat is what made the failure look like a frozen Telegram.
    expect(menu.classList.contains("active")).toBe(false);
    expect(fixture.attach.classList.contains("menu-open")).toBe(false);
    expect(toggleClicks.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});
