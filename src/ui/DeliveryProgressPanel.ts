/** Renders isolated automatic-delivery progress without depending on Telegram selectors. */
import { appConfig, type AppConfig } from "../config";
import type { DeliveryBatchSnapshot, RecipientDeliveryStatus } from "../delivery/DeliveryBatch";
import { EscapeKeyLifecycle } from "../utils/EscapeKeyLifecycle";

const HOST_ATTRIBUTE = "data-clean-forward-delivery-progress";
const PROJECT_OVERLAY_SELECTOR =
  "[data-clean-forward-recipient-picker], [data-clean-forward-delivery-progress]";
const escapeLifecycle = new EscapeKeyLifecycle();
const STATUS_LABELS: Readonly<Record<RecipientDeliveryStatus, string>> = Object.freeze({
  pending: "Ожидает",
  navigating: "Открываем чат",
  preparing: "Подготавливаем",
  sending: "Отправляем",
  sent: "Отправлено",
  failed: "Ошибка",
  unknown: "Результат неизвестен",
});

const PANEL_STYLES = `
  :host {
    --cf-bg: #ffffff;
    --cf-text: #202b33;
    --cf-muted: #707579;
    --cf-border: rgba(0, 0, 0, 0.12);
    --cf-overlay: rgba(0, 0, 0, 0.42);
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    color: var(--cf-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :host([data-theme="dark"]) {
    --cf-bg: #212121;
    --cf-text: #f5f5f5;
    --cf-muted: #aaaaaa;
    --cf-border: rgba(255, 255, 255, 0.12);
    --cf-overlay: rgba(0, 0, 0, 0.58);
  }
  * { box-sizing: border-box; }
  .overlay { display: grid; width: 100%; height: 100%; place-items: center; padding: 16px; background: var(--cf-overlay); }
  .panel { width: min(430px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; border: 1px solid var(--cf-border); border-radius: 14px; padding: 18px; background: var(--cf-bg); box-shadow: 0 18px 55px rgba(0,0,0,.3); }
  h2 { margin: 0 0 8px; font-size: 18px; }
  .headline, .current, .counts { margin: 0; }
  .headline { font-weight: 650; }
  .current { margin-top: 5px; color: var(--cf-muted); }
  .counts { display: flex; gap: 14px; margin-top: 14px; font-size: 13px; }
  .list { display: grid; gap: 7px; margin: 16px 0; padding: 0; list-style: none; }
  .item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 9px 10px; border-radius: 9px; background: color-mix(in srgb, var(--cf-bg), var(--cf-muted) 8%); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { color: var(--cf-muted); font-size: 13px; }
  .item[data-state="failed"] .state, .item[data-state="unknown"] .state { color: #d14b4b; }
  .item[data-state="sent"] .state { color: #2a9d62; }
  .detail { grid-column: 1 / -1; margin: 0; color: #d14b4b; font-size: 12px; line-height: 1.35; }
  .diagnostic { grid-column: 1 / -1; margin: 0; color: var(--cf-muted); font-size: 11px; line-height: 1.35; }
  footer { display: flex; justify-content: flex-end; gap: 9px; padding-top: 12px; border-top: 1px solid var(--cf-border); }
  button { min-height: 38px; border: 0; border-radius: 9px; padding: 8px 14px; cursor: pointer; font: inherit; font-weight: 600; }
  button:disabled { cursor: default; opacity: .48; }
  .cancel, .close { background: transparent; color: #3390ec; }
  .retry { background: #3390ec; color: white; }
`;

/** Actions owned by the delivery coordinator rather than the progress UI. */
export interface DeliveryProgressActions {
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/** Shadow DOM progress and final-summary panel for one delivery batch. */
export class DeliveryProgressPanel {
  private readonly host: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly headline: HTMLParagraphElement;
  private readonly current: HTMLParagraphElement;
  private readonly counts: HTMLParagraphElement;
  private readonly list: HTMLUListElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly escapeLifecycle = escapeLifecycle;
  private actions: DeliveryProgressActions | null = null;
  private snapshot: DeliveryBatchSnapshot | null = null;

  public constructor(private readonly config: AppConfig = appConfig) {
    this.host = document.createElement("div");
    this.host.setAttribute(HOST_ATTRIBUTE, "");
    this.host.hidden = true;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_STYLES;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "clean-forward-delivery-title");
    this.title = document.createElement("h2");
    this.title.id = "clean-forward-delivery-title";
    this.headline = document.createElement("p");
    this.headline.className = "headline";
    this.current = document.createElement("p");
    this.current.className = "current";
    this.counts = document.createElement("p");
    this.counts.className = "counts";
    this.counts.setAttribute("aria-live", "polite");
    this.list = document.createElement("ul");
    this.list.className = "list";
    const footer = document.createElement("footer");
    this.cancelButton = this.createButton("Отмена", "cancel", () => this.actions?.onCancel());
    this.retryButton = this.createButton("Повторить оставшиеся", "retry", () => this.actions?.onRetry());
    this.closeButton = this.createButton("Закрыть", "close", () => this.actions?.onClose());
    footer.append(this.cancelButton, this.retryButton, this.closeButton);
    panel.append(this.title, this.headline, this.current, this.counts, this.list, footer);
    overlay.append(panel);
    shadow.append(style, overlay);
  }

  /** Opens the panel and renders the first coordinator-owned snapshot. */
  public show(snapshot: DeliveryBatchSnapshot, actions: DeliveryProgressActions): void {
    this.actions = actions;
    this.ensureMounted();
    this.applyTheme();
    this.host.hidden = false;
    this.update(snapshot);
    this.activateEscapeLifecycle();
  }

  /** Re-renders progress from immutable delivery state. */
  public update(snapshot: DeliveryBatchSnapshot): void {
    this.snapshot = snapshot;
    const total = snapshot.recipients.length;
    const displayIndex = snapshot.currentIndex === null ? null : snapshot.currentIndex + 1;
    this.title.textContent = snapshot.running ? "Отправка сообщений" : "Результат отправки";
    this.headline.textContent = snapshot.running && displayIndex !== null
      ? `Отправка ${displayIndex} / ${total}`
      : `Обработано: ${snapshot.sentCount + snapshot.failedCount + snapshot.unknownCount} / ${total}`;
    this.current.textContent = snapshot.currentRecipient
      ? `Получатель: ${snapshot.currentRecipient.title}`
      : snapshot.cancelRequested
        ? "Операция остановлена перед следующим Send."
        : "Операция завершена.";
    this.counts.textContent = `Отправлено: ${snapshot.sentCount} · Ошибки: ${snapshot.failedCount} · Неизвестно: ${snapshot.unknownCount}`;
    this.list.replaceChildren(...snapshot.recipients.map((record) => this.renderRecord(record)));
    this.cancelButton.hidden = !snapshot.running;
    this.cancelButton.textContent = snapshot.currentRecipient && recordIsSending(snapshot)
      ? "Остановить после текущего"
      : "Отмена";
    this.retryButton.hidden = snapshot.running || snapshot.retryableCount === 0 || snapshot.unknownCount > 0;
    this.closeButton.hidden = snapshot.running;
  }

  /** Hides the panel and releases coordinator callbacks. */
  public hide(): void {
    this.escapeLifecycle.deactivate();
    this.host.hidden = true;
    this.actions = null;
    this.snapshot = null;
    this.list.replaceChildren();
    this.host.remove();
  }

  private renderRecord(record: DeliveryBatchSnapshot["recipients"][number]): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "item";
    item.dataset.state = record.status;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = record.recipient.title;
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = STATUS_LABELS[record.status];
    item.append(name, state);
    if (record.detail) {
      const detail = document.createElement("p");
      detail.className = "detail";
      detail.textContent = record.detail;
      item.append(detail);
    }
    if (this.config.debug.showDeliveryResultDialog) {
      const diagnostic = document.createElement("p");
      diagnostic.className = "diagnostic";
      diagnostic.textContent = [
        `attempts=${record.attemptCount}`,
        record.retryReason ? `retry=${record.retryReason}` : null,
        record.messageId ? `data-mid=${record.messageId}` : null,
      ].filter((value): value is string => value !== null).join(" · ");
      item.append(diagnostic);
    }
    return item;
  }

  private activateEscapeLifecycle(): void {
    this.escapeLifecycle.activate({
      shouldHandle: () =>
        this.host.isConnected && !this.host.hidden && this.isTopLevelProjectOverlay(),
      onEscape: () => {
        if (this.snapshot?.running) {
          this.actions?.onCancel();
        } else {
          this.actions?.onClose();
        }
      },
    });
  }

  private isTopLevelProjectOverlay(): boolean {
    const visible = Array.from(document.querySelectorAll<HTMLElement>(PROJECT_OVERLAY_SELECTOR))
      .filter((overlay) => overlay.isConnected && !overlay.hidden);
    return visible[visible.length - 1] === this.host;
  }

  private ensureMounted(): void {
    if (!this.host.isConnected) {
      document.body.append(this.host);
    }
  }

  private applyTheme(): void {
    const channels = getComputedStyle(document.body).backgroundColor
      .match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance = channels.length === 3
      ? (channels[0] ?? 255) * 0.2126 + (channels[1] ?? 255) * 0.7152 + (channels[2] ?? 255) * 0.0722
      : 255;
    this.host.dataset.theme = luminance < 128 ? "dark" : "light";
  }

  private createButton(label: string, className: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }
}

function recordIsSending(snapshot: DeliveryBatchSnapshot): boolean {
  return snapshot.currentIndex !== null && snapshot.recipients[snapshot.currentIndex]?.status === "sending";
}
