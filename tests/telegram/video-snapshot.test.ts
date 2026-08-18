import { afterEach, describe, expect, it } from "vitest";

import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger } from "../helpers";

/**
 * jsdom never loads media, so `videoWidth`/`duration` are defined here the way a real browser
 * reports them once the first frames arrive. That readiness is exactly what capture depends on.
 */
function installBubble(inner: string): HTMLElement {
  document.body.innerHTML =
    `<div class="bubble" data-mid="70" data-peer-id="20">${inner}</div>`;
  return document.querySelector<HTMLElement>(".bubble")!;
}

function describeLoadedVideo(
  video: HTMLVideoElement,
  values: { width?: number; height?: number; duration?: number; src?: string } = {},
): void {
  Object.defineProperties(video, {
    videoWidth: { value: values.width ?? 1280, configurable: true },
    videoHeight: { value: values.height ?? 720, configurable: true },
    duration: { value: values.duration ?? 12.5, configurable: true },
    currentSrc: { value: values.src ?? "blob:https://web.telegram.org/video", configurable: true },
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("reading a bubble video", () => {
  const dom = new TelegramDomAdapter(createLogger());

  it("captures dimensions and duration from the loaded element", () => {
    const bubble = installBubble('<div class="attachment"><video class="media-video"></video></div>');
    describeLoadedVideo(bubble.querySelector("video")!);

    const snapshot = dom.readMessageSnapshot(bubble, "20");

    expect(snapshot?.videoCount).toBe(1);
    expect(snapshot?.video).toEqual({
      url: "blob:https://web.telegram.org/video",
      width: 1280,
      height: 720,
      durationSeconds: 12.5,
    });
    expect(snapshot?.hasUnsupportedAttachment).toBe(false);
  });

  it("keeps a caption alongside the video", () => {
    const bubble = installBubble(
      '<div class="attachment"><video class="media-video"></video></div><div class="message">fixture-caption</div>',
    );
    describeLoadedVideo(bubble.querySelector("video")!);

    expect(dom.readMessageSnapshot(bubble, "20")?.text).toBe("fixture-caption");
  });

  it("does not treat a round video note as a video", () => {
    const bubble = installBubble(
      '<div class="attachment"><div class="media-round"><video class="media-video"></video></div></div>',
    );
    describeLoadedVideo(bubble.querySelector("video")!);

    expect(dom.readMessageSnapshot(bubble, "20")?.video).toBeNull();
  });

  it("does not treat an animation as a video", () => {
    const bubble = installBubble(
      '<div class="attachment"><div class="media-gif-wrapper"><video class="media-video"></video></div></div>',
    );
    describeLoadedVideo(bubble.querySelector("video")!);

    expect(dom.readMessageSnapshot(bubble, "20")?.video).toBeNull();
  });

  it("stays fail-closed until the browser knows the video's real size", () => {
    const bubble = installBubble('<div class="attachment"><video class="media-video"></video></div>');
    describeLoadedVideo(bubble.querySelector("video")!, { width: 0, duration: NaN });

    const snapshot = dom.readMessageSnapshot(bubble, "20");
    expect(snapshot?.video).toBeNull();
    // The element is still counted, so preflight rejects instead of silently sending the caption.
    expect(snapshot?.videoCount).toBe(1);
  });

  it("reads the real Web K video bubble, whose poster is an img.media-photo", () => {
    // Captured from a live Telegram Web K chat: the poster and the video share one media
    // container, so counting the poster as a photo rejected every real video message.
    const bubble = installBubble(
      '<div class="attachment media-container no-background">' +
        '<span class="video-time">0:04</span>' +
        '<span class="tgico video-time-icon"></span>' +
        '<img class="media-photo">' +
        '<video class="media-video"></video>' +
      '</div>' +
      '<div class="bubble-hover-reaction-sticker media-sticker-wrapper"></div>',
    );
    bubble.className =
      "bubble hide-name video has-plain-media-tail is-message-empty has-floating-time is-out";
    describeLoadedVideo(bubble.querySelector("video")!, {
      width: 478,
      height: 850,
      duration: 4.825389,
      src: "https://web.telegram.org/k/stream/fixture",
    });

    const snapshot = dom.readMessageSnapshot(bubble, "20");

    expect(snapshot?.videoCount).toBe(1);
    expect(snapshot?.video).toMatchObject({ width: 478, height: 850, durationSeconds: 4.825389 });
    // The poster must not register as content, or preflight sees "a video next to a photo".
    expect(snapshot?.imageCount).toBe(0);
    expect(snapshot?.imageUrl).toBeNull();
    expect(snapshot?.hasUnsupportedAttachment).toBe(false);
  });

  it("still counts a real photo that is not a video poster", () => {
    const bubble = installBubble(
      '<div class="attachment media-container no-background"><img class="media-photo" src="blob:photo"></div>',
    );

    const snapshot = dom.readMessageSnapshot(bubble, "20");
    expect(snapshot?.imageCount).toBe(1);
    expect(snapshot?.videoCount).toBe(0);
  });
});
