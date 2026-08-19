/**
 * Single source of truth for every Telegram Web K DOM shape this project reads or writes into.
 *
 * Nothing here is ours: each selector names structure owned by upstream `morethanwords/tweb`, so
 * every one of them is an assumption upstream can invalidate without warning. Keeping them in one
 * module is what makes that assumption checkable — `contracts/tweb-dom-contract.json` lists the
 * atomic tokens these selectors are built from, `tests/telegram/dom-contract.test.ts` proves the
 * two stay in sync, and `scripts/check-tweb-contract.mjs` proves the tokens still exist upstream.
 *
 * Project-owned markers (`data-clean-forward-*`, `clean-forward-*`) deliberately stay in their own
 * modules: they are not part of this contract and must never be checked against upstream.
 *
 * Research baseline: `docs/tweb-navigation-contract.md`.
 */

/** Upstream revision the contract was last verified against by hand. */
export const TWEB_PINNED_COMMIT = "e3730e10073c3fc02e1360e3513b70b176d6afec";

/* ------------------------------------------------------------------ *
 * Left column: dialog list, native search, recipient identity
 * ------------------------------------------------------------------ */

export const LEFT_COLUMN_SELECTOR = "#column-left";
export const ACTIVE_DIALOG_LIST_SELECTOR =
  ".tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist";
export const DIALOG_ROW_SELECTOR = ":scope > a.row.chatlist-chat[data-peer-id]";
export const ACTIVE_DIALOG_ROW_SELECTOR =
  ".tabs-tab.chatlist-parts.active a.row.chatlist-chat.active[data-peer-id]";
export const ACTIVE_CHATLIST_ROW_SELECTOR = "a.row.chatlist-chat.active[data-peer-id]";
export const SEARCH_DIALOG_ROW_SELECTOR =
  "#column-left #search-container .search-super-content-chats a.row.chatlist-chat[data-peer-id]";
export const NATIVE_SEARCH_ROW_SELECTOR = "a.row.chatlist-chat[data-peer-id]";
export const NATIVE_SEARCH_INPUT_SELECTOR =
  '#column-left .sidebar-header input.input-search-input[type="text"]';
export const NATIVE_SEARCH_MAIN_SELECTOR = "#column-left .sidebar-slider-item.item-main";
export const NATIVE_SEARCH_RESULTS_SELECTOR =
  "#column-left #search-container .search-super-content-chats";
export const NATIVE_SEARCH_BACK_SELECTOR = "#column-left .sidebar-header .sidebar-back-button";
/** Class Telegram's own sidebar toggles while its native search owns the left column. */
export const SEARCH_ACTIVE_CLASS = "is-search-active";
/** Result groups that are not plain peer rows and must never become recipients. */
export const NON_DIALOG_SEARCH_GROUP_SELECTOR = ".search-group-recent, .search-group-messages";
export const SEARCH_MESSAGES_GROUP_SELECTOR = ".search-group-messages";

export const PEER_TITLE_SELECTOR = ".peer-title";
export const ROW_SUBTITLE_SELECTOR = ".row-subtitle";
export const AVATAR_IMAGE_SELECTOR = ".avatar img";
export const FORUM_MARKER_SELECTOR = ".is-forum";
/** Native search exposes broadcast type only through this localized Telegram status. */
export const BROADCAST_STATUS_SELECTOR = ".row-subtitle .i18n";
export const DISABLED_ROW_SELECTOR = '[aria-disabled="true"], .disabled, .is-disabled';
/** Decorations inside a subtitle that carry no recipient meaning. */
export const SUBTITLE_IGNORED_SELECTORS = [
  ".badge",
  ".dialog-subtitle-badge",
  ".sending-status",
  ".message-time",
] as const;

/* ------------------------------------------------------------------ *
 * Center column: active chat, composer ownership, visibility
 * ------------------------------------------------------------------ */

export const MAIN_CHATS_SELECTOR = "#column-center > .chats-container";
export const ACTIVE_MAIN_CHAT_SELECTOR = ":scope > .chat.tabs-tab.active";
export const OWNED_COMPOSER_CONTAINER_SELECTOR = ":scope > .chat-input.chat-input-main";
export const COMPOSER_CONTAINER_SELECTOR = ".chat-input-main";
export const CHAT_SELECTOR = ".chat";
export const ACTIVE_COMPOSER_SELECTOR =
  '.input-message-input[contenteditable="true"][data-peer-id]';
export const COMPOSER_SELECTOR = ".input-message-input[data-peer-id]";
export const TOPBAR_PEER_IDENTITY_SELECTOR = ".topbar .person-avatar[data-peer-id]";
export const ACTIVE_CHAT_TITLE_SELECTOR = ".topbar .peer-title, .topbar .user-title";
export const HIDDEN_ANCESTOR_SELECTOR = '[hidden], [aria-hidden="true"]';
export const HIDDEN_CHAT_ANCESTOR_SELECTOR =
  '[hidden], [aria-hidden="true"], .chat.hide, .chat.is-hidden';
export const HIDDEN_COMPOSER_ANCESTOR_SELECTOR =
  '[hidden], [aria-hidden="true"], .is-chat-input-hidden';
/** Classes Telegram sets on a pane it keeps mounted but no longer shows. */
export const HIDDEN_CLASSES = ["hide", "is-hidden"] as const;
/** Telegram's own marker for the open state of menus, popups and chat panes. */
export const ACTIVE_CLASS = "active";

/* ------------------------------------------------------------------ *
 * Message bubbles
 * ------------------------------------------------------------------ */

export const MESSAGE_ROOT_SELECTOR = ".bubble[data-mid][data-peer-id]";
export const GROUPED_ITEM_SELECTOR = ".grouped-item[data-mid][data-peer-id]";
export const MESSAGE_IDENTITY_SELECTOR = `${GROUPED_ITEM_SELECTOR}, ${MESSAGE_ROOT_SELECTOR}`;
export const MESSAGE_TEXT_SELECTOR = ".message";
export const MESSAGE_TIME_SELECTOR = ".time";
export const MESSAGE_LAYOUT_FIX_SELECTOR = ".clearfix";
export const MESSAGE_PHOTO_SELECTOR = "img.media-photo";
/**
 * Web K tags every playable bubble video with this class, then wraps round notes in `.media-round`
 * and GIF/animation in `.media-gif-wrapper`. Only the bare case is an ordinary re-uploadable video.
 */
export const MESSAGE_VIDEO_SELECTOR = "video.media-video";
export const ROUND_VIDEO_SELECTOR = ".media-round";
export const ANIMATION_SELECTOR = ".media-gif-wrapper";
export const MEDIA_CONTAINER_SELECTOR = ".attachment, .media-container";
export const MESSAGE_ATTACHMENT_SELECTOR = ".attachment";
export const GROUPED_CLASS = "is-grouped";
export const OUTGOING_BUBBLE_SELECTOR = ".bubble.is-out";
/**
 * Telegram Web K renders acknowledged messages from the current account as is-out bubbles.
 * Requiring data-mid avoids treating preview closure or a transient upload placeholder as success.
 */
export const CONFIRMED_OUTGOING_SELECTOR =
  ".bubble.is-out[data-mid][data-peer-id], .bubble.is-out .grouped-item[data-mid]";
/**
 * `is-outgoing` plus the `is-sending` status class mark a message still in flight. `sending` is
 * kept only for older builds; current Web K never sets it. See `outgoingMessageState.ts` for why
 * both the class and the temporary `data-mid` are checked.
 */
export const IN_FLIGHT_SELECTOR = ".is-outgoing, .is-sending, .sending";
export const FAILED_SELECTOR = ".is-error";
/** Legacy in-flight marker, retained for builds older than the `is-sending` rename. */
export const SENDING_SELECTOR = ".sending";

/* ------------------------------------------------------------------ *
 * Native selection mode
 * ------------------------------------------------------------------ */

export const SELECTION_WRAPPER_SELECTOR = ".chat-input-wrapper.selection-wrapper";
export const SELECTION_TOOLBAR_SELECTOR = ".chat-input-plate.selection-container";
export const SELECTION_FORWARD_SELECTOR = ".selection-container-forward";
export const SELECTION_FORWARD_CLASS = "selection-container-forward";
export const SELECTION_COUNT_SELECTOR = ".selection-container-count";
export const SELECTING_HISTORY_SELECTOR = ".bubbles.is-selecting";
export const SELECTED_MESSAGE_SELECTOR =
  ".bubble.is-selected[data-mid][data-peer-id], .grouped-item.is-selected[data-mid][data-peer-id]";
export const CHECKED_SELECTION_SELECTOR =
  '.bubble-select-checkbox input.checkbox-field-input[type="checkbox"]:checked';
export const GROUPED_MESSAGE_SELECTOR = ".grouped-item, .bubble.is-grouped";
/** Telegram's own side-slot class, reused so an added action inherits the plate's button sizing. */
export const PLATE_SIDE_CLASS = "chat-input-plate-side";

/* ------------------------------------------------------------------ *
 * Menus
 * ------------------------------------------------------------------ */

export const ACTIVE_MENU_SELECTOR = ".btn-menu.active";
export const ACTIVE_MESSAGE_MENU_SELECTOR = ".btn-menu.contextmenu.active";
/**
 * Web K appends menu items straight into `.btn-menu`. It only moves them into this wrapper (and
 * adds `has-items-wrapper`) when a reactions bar is attached, which happens on desktop and never
 * in selection mode. Requiring the wrapper therefore matched a single desktop case and silently
 * disabled the action on mobile and for every multi-selection menu.
 */
export const MENU_ITEMS_WRAPPER_SELECTOR = ".btn-menu-items";
export const MENU_ITEM_SELECTOR = ".btn-menu-item";
export const OWNED_MENU_ITEM_SELECTOR = ":scope > .btn-menu-item";
export const MENU_ITEM_TEXT_SELECTOR = ".btn-menu-item-text";
/** Removed from current Web K, which closes menus through a document-level overlay handler. */
export const MENU_OVERLAY_SELECTOR = ".btn-menu-overlay";
/** Class Telegram's own toggle handler uses to decide whether a further click opens or closes. */
export const MENU_OPEN_CLASS = "menu-open";
/** Classes an added item copies so it is sized and highlighted like a native one. */
export const MENU_ITEM_CLASSES = ["btn-menu-item", "rp-overflow"] as const;
export const MENU_ITEM_ICON_CLASSES = ["tgico", "btn-menu-item-icon"] as const;
export const MENU_ITEM_TEXT_CLASS = "btn-menu-item-text";

/* ------------------------------------------------------------------ *
 * Attachment, upload preview and send controls
 * ------------------------------------------------------------------ */

export const FILE_INPUT_SELECTOR = '.new-message-wrapper input[type="file"]';
/**
 * The attach control is Web K's `attach-menu-button` custom element. The `attach-file` class it
 * used to carry has been dropped, so matching the element itself keeps both builds working.
 */
export const ATTACHMENT_BUTTON_SELECTOR = "attach-menu-button";
export const TEXT_SEND_BUTTON_SELECTOR = ".btn-send";
export const ACTIVE_MEDIA_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
export const NATIVE_FORWARD_POPUP_SELECTOR = ".popup.popup-forward.active";
export const PREVIEW_IMAGE_SELECTOR = ".popup-item.popup-item-media img";
export const PREVIEW_MEDIA_ITEM_SELECTOR = ".popup-item.popup-item-media";
export const PREVIEW_DOCUMENT_ITEM_SELECTOR = ".popup-item.popup-item-document";
export const PREVIEW_ALBUM_SELECTOR = ".popup-item-album";
export const CAPTION_EDITOR_SELECTOR =
  '.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)';
export const CAPTION_CONFIRM_SELECTOR = ".simple-message-input-confirm";
export const PREVIEW_CLOSE_SELECTOR = ".popup-close";
export const UNSTABLE_EDITOR_SELECTOR = ".animating, .is-changing-height";
export const UNREADY_MEDIA_SELECTOR = ".preloader, .render-progress";
export const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
