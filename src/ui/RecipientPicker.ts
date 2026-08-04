/** Renders the isolated single-recipient picker without knowing Telegram DOM selectors. */
import type { Recipient } from "../recipient/Recipient";
import { EscapeKeyLifecycle } from "../utils/EscapeKeyLifecycle";

const PICKER_HOST_ATTRIBUTE = "data-clean-forward-recipient-picker";
const PICKER_TITLE = "Отправить как новое";
const SEARCH_PLACEHOLDER = "Поиск чатов";
const NEXT_LABEL = "Далее";
const CANCEL_LABEL = "Отмена";
const EMPTY_MESSAGE = "Ничего не найдено";
const LOADING_MESSAGE = "Загружаем чаты…";
const SELECTED_LABEL = "Выбрано";

const PICKER_STYLES = `
  :host {
    --cf-bg: #ffffff;
    --cf-text: #202b33;
    --cf-muted: #707579;
    --cf-border: rgba(0, 0, 0, 0.12);
    --cf-hover: rgba(51, 144, 236, 0.09);
    --cf-selected: rgba(51, 144, 236, 0.16);
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
    --cf-hover: rgba(82, 165, 245, 0.13);
    --cf-selected: rgba(82, 165, 245, 0.22);
    --cf-overlay: rgba(0, 0, 0, 0.58);
  }
  * { box-sizing: border-box; }
  .overlay {
    display: grid;
    width: 100%;
    height: 100%;
    place-items: center;
    padding: 16px;
    background: var(--cf-overlay);
  }
  .dialog {
    display: grid;
    grid-template-rows: auto auto auto minmax(96px, 1fr) auto;
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: hidden;
    border: 1px solid var(--cf-border);
    border-radius: 14px;
    background: var(--cf-bg);
    box-shadow: 0 18px 55px rgba(0, 0, 0, 0.3);
  }
  .header, .footer { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
  .header { justify-content: space-between; }
  h2 { margin: 0; font-size: 18px; line-height: 1.35; }
  button, input { font: inherit; }
  .close {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--cf-muted);
    cursor: pointer;
    font-size: 25px;
    line-height: 1;
  }
  .close:hover { background: var(--cf-hover); color: var(--cf-text); }
  .search-wrap { padding: 0 16px 12px; }
  .search {
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--cf-border);
    border-radius: 10px;
    padding: 9px 12px;
    outline: none;
    background: color-mix(in srgb, var(--cf-bg), var(--cf-muted) 7%);
    color: var(--cf-text);
  }
  .search:focus { border-color: #3390ec; box-shadow: 0 0 0 2px rgba(51, 144, 236, 0.14); }
  .status { margin: 0; padding: 0 16px 10px; color: #d14b4b; font-size: 13px; line-height: 1.4; }
  .list { overflow: auto; overscroll-behavior: contain; padding: 2px 8px 8px; }
  .recipient {
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr) 22px;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-height: 62px;
    border: 0;
    border-radius: 10px;
    padding: 7px 9px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .recipient:hover { background: var(--cf-hover); }
  .recipient[hidden] { display: none; }
  .recipient[aria-pressed="true"] { background: var(--cf-selected); }
  .recipient:disabled { cursor: not-allowed; opacity: 0.55; }
  .avatar {
    display: grid;
    width: 46px;
    height: 46px;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    background: linear-gradient(145deg, #5aa9e6, #4078c0);
    color: white;
    font-size: 18px;
    font-weight: 650;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .copy { min-width: 0; }
  .title, .subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { font-size: 15px; font-weight: 600; }
  .subtitle { margin-top: 3px; color: var(--cf-muted); font-size: 13px; }
  .check {
    display: grid;
    width: 20px;
    height: 20px;
    place-items: center;
    border: 2px solid var(--cf-border);
    border-radius: 50%;
    color: transparent;
    font-size: 13px;
    font-weight: 700;
  }
  .recipient[aria-pressed="true"] .check {
    border-color: #3390ec;
    background: #3390ec;
    color: white;
  }
  .empty { margin: 0; padding: 26px 16px; color: var(--cf-muted); text-align: center; }
  .footer { justify-content: flex-end; border-top: 1px solid var(--cf-border); }
  .selection-count { margin-right: auto; color: var(--cf-muted); font-size: 13px; }
  .action {
    min-height: 38px;
    border: 0;
    border-radius: 9px;
    padding: 8px 15px;
    cursor: pointer;
    font-weight: 600;
  }
  .cancel { background: transparent; color: #3390ec; }
  .next { background: #3390ec; color: white; }
  .action:disabled { cursor: default; opacity: 0.48; }
  @media (max-height: 420px) {
    .overlay { padding: 8px; }
    .dialog { max-height: calc(100vh - 16px); }
    .header { padding-block: 8px; }
    .recipient { min-height: 54px; }
  }
`;

/** Callbacks emitted by the recipient picker. */
export interface RecipientPickerActions {
  readonly onToggle?: (recipient: Recipient) => void;
  readonly onNext: (recipient?: Recipient) => void;
  readonly onCancel: () => void;
}

/** Options used when showing a loaded recipient list. */
export interface RecipientPickerOptions {
  readonly selectedPeerKeys?: readonly string[];
  readonly errorMessage?: string;
}

interface RecipientRow {
  readonly recipient: Recipient;
  readonly button: HTMLButtonElement;
  readonly searchText: string;
}

/** Shadow DOM popup that renders externally owned multi-recipient selection state. */
export class RecipientPicker {
  private readonly host: HTMLDivElement;
  private readonly dialog: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private readonly selectionCount: HTMLSpanElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly escapeLifecycle = new EscapeKeyLifecycle();
  private actions: RecipientPickerActions | null = null;
  private rows: RecipientRow[] = [];
  private selectedCount = 0;
  private focusGuardController: AbortController | null = null;

  public constructor() {
    this.host = document.createElement("div");
    this.host.setAttribute(PICKER_HOST_ATTRIBUTE, "");
    this.host.hidden = true;
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PICKER_STYLES;

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    this.dialog = document.createElement("section");
    this.dialog.className = "dialog";
    this.dialog.tabIndex = -1;
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-labelledby", "clean-forward-recipient-title");

    const header = document.createElement("header");
    header.className = "header";
    const title = document.createElement("h2");
    title.id = "clean-forward-recipient-title";
    title.textContent = PICKER_TITLE;
    this.closeButton = this.createButton("×", "close", () => this.cancel());
    this.closeButton.setAttribute("aria-label", "Закрыть");
    header.append(title, this.closeButton);

    const searchWrap = document.createElement("div");
    searchWrap.className = "search-wrap";
    this.searchInput = document.createElement("input");
    this.searchInput.className = "search";
    this.searchInput.type = "search";
    this.searchInput.placeholder = SEARCH_PLACEHOLDER;
    this.searchInput.autocomplete = "off";
    this.searchInput.addEventListener("input", () => this.applyFilter());
    searchWrap.append(this.searchInput);

    this.status = document.createElement("p");
    this.status.className = "status";
    this.status.setAttribute("role", "alert");
    this.status.hidden = true;

    this.list = document.createElement("div");
    this.list.className = "list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-multiselectable", "true");
    this.empty = document.createElement("p");
    this.empty.className = "empty";
    this.empty.textContent = EMPTY_MESSAGE;
    this.empty.hidden = true;
    this.list.append(this.empty);

    const footer = document.createElement("footer");
    footer.className = "footer";
    this.selectionCount = document.createElement("span");
    this.selectionCount.className = "selection-count";
    this.cancelButton = this.createButton(CANCEL_LABEL, "action cancel", () => this.cancel());
    this.nextButton = this.createButton(NEXT_LABEL, "action next", () => this.confirm());
    this.nextButton.disabled = true;
    footer.append(this.selectionCount, this.cancelButton, this.nextButton);

    this.dialog.append(header, searchWrap, this.status, this.list, footer);
    overlay.append(this.dialog);
    shadow.append(style, overlay);
    document.body.append(this.host);
  }

  /** Opens a cancellable loading state before Telegram dialog rows are read. */
  public showLoading(actions: RecipientPickerActions): void {
    this.ensureMounted();
    this.actions = actions;
    this.rows = [];
    this.selectedCount = 0;
    this.updateSelectionCount();
    this.list.replaceChildren(this.empty);
    this.empty.textContent = LOADING_MESSAGE;
    this.empty.hidden = false;
    this.searchInput.value = "";
    this.searchInput.disabled = true;
    this.setError("");
    this.setBusy(false);
    this.applyTheme();
    this.host.hidden = false;
    this.activateEscapeLifecycle();
    this.dialog.focus();
  }

  /** Shows loaded dialogs and renders the selection snapshot owned by the controller. */
  public show(
    recipients: readonly Recipient[],
    actions: RecipientPickerActions,
    options: RecipientPickerOptions = {},
  ): void {
    this.ensureMounted();
    this.actions = actions;
    this.searchInput.value = "";
    this.searchInput.disabled = false;
    this.renderRows(recipients);
    this.updateSelection(options.selectedPeerKeys ?? []);
    this.setError(options.errorMessage ?? "");
    this.setBusy(false);
    this.applyTheme();
    this.host.hidden = false;
    this.activateEscapeLifecycle();
    this.activateFocusGuard();
    this.searchInput.focus();
  }

  /** Hides the popup and drops callbacks and selected recipient state. */
  public hide(): void {
    this.deactivateFocusGuard();
    this.escapeLifecycle.deactivate();
    this.host.hidden = true;
    this.actions = null;
    this.selectedCount = 0;
    this.rows = [];
    this.list.replaceChildren(this.empty);
    this.updateSelectionCount();
    this.host.remove();
  }

  /** Reports whether the project popup is currently visible. */
  public isVisible(): boolean {
    return !this.host.hidden;
  }

  /** Disables controls while the confirmed selection is being processed. */
  public setBusy(busy: boolean): void {
    this.searchInput.disabled = busy || this.rows.length === 0;
    this.cancelButton.disabled = busy;
    this.closeButton.disabled = busy;
    for (const row of this.rows) {
      row.button.disabled = busy || !row.recipient.supported;
    }
    this.nextButton.textContent = busy ? "Открываем чат…" : NEXT_LABEL;
    this.nextButton.disabled = busy || this.selectedCount === 0;
  }

  /** Applies externally owned selected peer keys without disturbing the current search query. */
  public updateSelection(selectedPeerKeys: readonly string[]): void {
    const selected = new Set(selectedPeerKeys);
    this.selectedCount = 0;
    for (const row of this.rows) {
      const rowSelected = row.recipient.supported && selected.has(row.recipient.peerKey);
      row.button.setAttribute("aria-pressed", String(rowSelected));
      row.button.setAttribute("aria-selected", String(rowSelected));
      if (rowSelected) {
        this.selectedCount += 1;
      }
    }
    this.updateSelectionCount();
    this.nextButton.disabled = this.selectedCount === 0;
  }

  /** Shows or clears a recoverable picker error. */
  public setError(message: string): void {
    this.status.textContent = message;
    this.status.hidden = message.length === 0;
  }

  private renderRows(recipients: readonly Recipient[]): void {
    this.rows = recipients.map((recipient) => this.createRecipientRow(recipient));
    this.list.replaceChildren(...this.rows.map((row) => row.button), this.empty);
    this.empty.textContent = EMPTY_MESSAGE;
    this.applyFilter();
  }

  private createRecipientRow(recipient: Recipient): RecipientRow {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recipient";
    button.setAttribute("role", "option");
    button.disabled = !recipient.supported;
    button.addEventListener("click", () => this.actions?.onToggle?.(recipient));

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = recipient.title.trim().charAt(0).toLocaleUpperCase() || "?";
    if (recipient.avatarUrl) {
      const image = document.createElement("img");
      image.src = recipient.avatarUrl;
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      avatar.append(image);
    }

    const copy = document.createElement("span");
    copy.className = "copy";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = recipient.title;
    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = recipient.supported
      ? recipient.subtitle ?? ""
      : recipient.unsupportedReason ?? "Недоступно";
    copy.append(title, subtitle);

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    button.append(avatar, copy, check);

    return {
      recipient,
      button,
      searchText: this.normalizeSearchText(`${recipient.title} ${recipient.subtitle ?? ""}`),
    };
  }

  private applyFilter(): void {
    const query = this.normalizeSearchText(this.searchInput.value);
    let visibleCount = 0;
    for (const row of this.rows) {
      const visible = query.length === 0 || row.searchText.includes(query);
      row.button.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    }
    this.empty.hidden = visibleCount > 0;
  }

  private confirm(): void {
    if (this.selectedCount === 0 || this.nextButton.disabled) {
      return;
    }
    this.actions?.onNext();
  }

  private cancel(): void {
    this.actions?.onCancel();
  }

  private activateEscapeLifecycle(): void {
    this.escapeLifecycle.activate({
      shouldHandle: () => this.host.isConnected && this.isVisible() && this.ownsCurrentFocus(),
      onEscape: () => this.cancel(),
    });
  }

  private activateFocusGuard(): void {
    this.deactivateFocusGuard();
    const controller = new AbortController();
    this.focusGuardController = controller;
    window.addEventListener(
      "focusin",
      (event) => {
        const target = event.target;
        const externalEditor =
          target instanceof Element && target.matches('input, textarea, [contenteditable="true"]');
        if (
          externalEditor &&
          this.host.isConnected &&
          this.isVisible() &&
          !this.searchInput.disabled &&
          !this.ownsCurrentFocus()
        ) {
          this.searchInput.focus();
        }
      },
      { capture: true, signal: controller.signal },
    );
    window.addEventListener(
      "focusout",
      (event) => {
        const nextTarget = event.relatedTarget;
        const lostToDocument =
          nextTarget === null ||
          nextTarget === document.body ||
          nextTarget === document.documentElement;
        if (!lostToDocument) {
          return;
        }

        // A Telegram rerender can remove its editor during the focus transition, leaving
        // document.body active. Recheck after the browser finishes that focus transaction.
        queueMicrotask(() => {
          if (
            this.host.isConnected &&
            this.isVisible() &&
            !this.searchInput.disabled &&
            !this.host.shadowRoot?.activeElement
          ) {
            this.searchInput.focus();
          }
        });
      },
      { capture: true, signal: controller.signal },
    );
  }

  private deactivateFocusGuard(): void {
    this.focusGuardController?.abort();
    this.focusGuardController = null;
  }

  private ownsCurrentFocus(): boolean {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }

    // Opening focuses our search. If Telegram places another modal above the picker, its
    // control becomes the deep active element and Escape must be left to that modal.
    return (
      active === null ||
      active === document.body ||
      active === document.documentElement ||
      this.host.shadowRoot?.contains(active) === true
    );
  }

  private updateSelectionCount(): void {
    this.selectionCount.textContent = `${SELECTED_LABEL}: ${this.selectedCount}`;
  }

  private ensureMounted(): void {
    if (!this.host.isConnected) {
      document.body.append(this.host);
    }
  }

  private normalizeSearchText(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase(["ru", "uk", "en"]);
  }

  private applyTheme(): void {
    const color = getComputedStyle(document.body).backgroundColor;
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance =
      channels.length === 3
        ? (channels[0] ?? 255) * 0.2126 +
          (channels[1] ?? 255) * 0.7152 +
          (channels[2] ?? 255) * 0.0722
        : 255;
    this.host.dataset.theme = luminance < 128 ? "dark" : "light";
  }

  private createButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }
}
