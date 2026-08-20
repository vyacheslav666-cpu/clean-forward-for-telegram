import { isSimplePeerKey } from "../recipient/Recipient";
import { readTelegramText } from "./readTelegramText";
import {
  ACTIVE_CHATLIST_ROW_SELECTOR as ACTIVE_ROW_SELECTOR,
  BROADCAST_STATUS_SELECTOR,
  COMPOSER_SELECTOR,
  DISABLED_ROW_SELECTOR,
  FORUM_MARKER_SELECTOR,
  HIDDEN_COMPOSER_ANCESTOR_SELECTOR,
} from "./domContract";

const BROADCAST_STATUS_PATTERN =
  /\bsubscribers?\b|подписчик(?:а|ов|и)?|підписник(?:а|и|ів)?/iu;

export type RecipientSourceKind = "recent" | "search";

/** Applies the same conservative Telegram writability evidence to recent and search rows. */
export class TelegramPeerEligibility {
  private readonly writablePeers = new Set<string>();
  private readonly readOnlyPeers = new Set<string>();

  public canSendToPeer(row: HTMLElement, source: RecipientSourceKind): boolean {
    const peerKey = row.dataset.peerId?.trim() ?? "";
    if (
      !isSimplePeerKey(peerKey) ||
      row.dataset.sponsored === "true" ||
      row.querySelector(FORUM_MARKER_SELECTOR) ||
      row.matches(DISABLED_ROW_SELECTOR)
    ) {
      return false;
    }

    const activeEvidence = this.readActiveComposerEvidence(peerKey);
    if (activeEvidence !== null) {
      const accepted = activeEvidence ? this.writablePeers : this.readOnlyPeers;
      const rejected = activeEvidence ? this.readOnlyPeers : this.writablePeers;
      accepted.add(peerKey);
      rejected.delete(peerKey);
      return activeEvidence;
    }

    if (this.writablePeers.has(peerKey)) {
      return true;
    }
    if (this.readOnlyPeers.has(peerKey)) {
      return false;
    }

    // Native search exposes broadcast type only through this localized Telegram status.
    // Without positive composer evidence, omitting it is safer than offering a read-only peer.
    if (source === "search" && this.hasBroadcastStatus(row)) {
      return false;
    }

    // Partial metadata is not proof that a user/group/self peer is unwritable.
    return true;
  }

  private readActiveComposerEvidence(peerKey: string): boolean | null {
    const activeRow = Array.from(
      document.querySelectorAll<HTMLElement>(ACTIVE_ROW_SELECTOR),
    ).find((row) => row.dataset.peerId === peerKey);
    if (!activeRow) {
      return null;
    }

    const composers = Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)).filter(
      (composer) => composer.dataset.peerId === peerKey,
    );
    if (composers.length !== 1) {
      return null;
    }

    const composer = composers[0]!;
    if (
      composer.getAttribute("contenteditable") !== "true" ||
      composer.getAttribute("aria-disabled") === "true" ||
      composer.closest(HIDDEN_COMPOSER_ANCESTOR_SELECTOR)
    ) {
      return false;
    }

    const style = getComputedStyle(composer);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  private hasBroadcastStatus(row: HTMLElement): boolean {
    const status = row.querySelector<HTMLElement>(BROADCAST_STATUS_SELECTOR);
    return status ? BROADCAST_STATUS_PATTERN.test(readTelegramText(status).trim()) : false;
  }
}
