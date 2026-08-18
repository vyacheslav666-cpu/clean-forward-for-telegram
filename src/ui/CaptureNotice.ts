/** Tells the user why a capture stopped, instead of leaving the click with no visible result. */

const HOST_ATTRIBUTE = "data-clean-forward-capture-notice";
const VISIBLE_MS = 9_000;

const NOTICE_STYLES = `
  :host {
    --cf-bg: #ffffff;
    --cf-text: #202b33;
    --cf-muted: #707579;
    --cf-border: rgba(0, 0, 0, 0.12);
    position: fixed;
    left: 50%;
    bottom: 88px;
    transform: translateX(-50%);
    z-index: 2147483646;
    color: var(--cf-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :host([data-theme="dark"]) {
    --cf-bg: #212121;
    --cf-text: #f5f5f5;
    --cf-muted: #aaaaaa;
    --cf-border: rgba(255, 255, 255, 0.14);
  }
  .card {
    max-width: min(420px, calc(100vw - 32px));
    box-sizing: border-box;
    padding: 12px 16px;
    border: 1px solid var(--cf-border);
    border-radius: 12px;
    background: var(--cf-bg);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
    font-size: 14px;
    line-height: 1.4;
  }
  .title { font-weight: 600; margin: 0 0 4px; }
  .reason { margin: 0; color: var(--cf-muted); overflow-wrap: anywhere; }
`;

/** One transient, non-blocking notice owned entirely by this userscript. */
export class CaptureNotice {
  private readonly host: HTMLElement;
  private readonly title: HTMLParagraphElement;
  private readonly reason: HTMLParagraphElement;
  private hideTimer = 0;

  public constructor() {
    this.host = document.createElement("div");
    this.host.setAttribute(HOST_ATTRIBUTE, "");
    this.host.hidden = true;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = NOTICE_STYLES;
    const card = document.createElement("div");
    card.className = "card";
    this.title = document.createElement("p");
    this.title.className = "title";
    this.reason = document.createElement("p");
    this.reason.className = "reason";
    card.append(this.title, this.reason);
    shadow.append(style, card);
  }

  /** Shows one reason and replaces any notice still on screen. */
  public show(title: string, reason: string): void {
    this.title.textContent = title;
    this.reason.textContent = reason;
    this.attach();
    this.host.hidden = false;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), VISIBLE_MS);
  }

  /** Removes the notice and its timer without touching any Telegram state. */
  public hide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
    this.host.hidden = true;
    this.host.remove();
  }

  private attach(): void {
    if (!this.host.isConnected) {
      document.body.append(this.host);
    }
    this.host.dataset.theme = document.documentElement.classList.contains("night")
      ? "dark"
      : "light";
  }
}
