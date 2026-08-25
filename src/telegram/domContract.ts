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
/**
 * The same composer node in a chat the user is not allowed to write in.
 *
 * Web K builds the message input for every chat (`ChatInput.constructPeerHelpers` always calls
 * `attachMessageInputField`) and keeps binding it to the open peer. At the end of
 * `ChatInput.finishPeerChange` it sets `contentEditable = 'false'` when the peer cannot be posted
 * to, and only then writes `messageInput.dataset.peerId` (`components/chat/input.ts`). A broadcast
 * channel therefore still publishes which peer is open — it just publishes it on a node the strict
 * `[contenteditable="true"]` form can never match, which is why an open channel could not be
 * proven at all.
 *
 * Being read-only is not what this selector proves; the identity is. The negated attribute keeps
 * this lookup from silently standing in for the writable one.
 */
export const READ_ONLY_COMPOSER_SELECTOR =
  '.input-message-input[data-peer-id]:not([contenteditable="true"])';
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
/**
 * Web K's reactions panel, matched by class rather than by its `reactions-element` tag name.
 *
 * Both name the same node, but only one of them is checkable: the tag is composed at runtime
 * (`const CLASS_NAME = 'reactions'; const TAG_NAME = CLASS_NAME + '-element'` in
 * `components/chat/reactions.ts`), so no literal to compare against upstream exists, while the
 * class is that plain constant. The class is also the safer read: the element adds it in its
 * constructor, so it is present from the moment the node exists, and it is the same token upstream
 * itself skips when it looks for message text.
 */
export const MESSAGE_REACTIONS_SELECTOR = ".reactions";
/** Quoted message shown above a reply, and the story reply Web K puts inside `.message`. */
export const MESSAGE_REPLY_SELECTOR = ".reply";
/** Language label and copy button Web K renders above a code block. */
export const MESSAGE_CODE_HEADER_SELECTOR = ".code-header";
/** Link preview box. Its title and description are generated from the URL, never typed by anyone. */
export const MESSAGE_WEBPAGE_SELECTOR = ".webpage";
/** Telegram's own fact-check annotation, attached to a message rather than written in it. */
export const MESSAGE_FACT_CHECK_SELECTOR = ".bubble-fact-check";
/**
 * Everything inside `.message` that is not the message text.
 *
 * Web K keeps its own answer to exactly this question, and this list is taken from there rather
 * than invented: `BUBBLE_TEXT_HIGHLIGHT_SKIP` in `components/chat/bubbles.ts` is
 * `'.time, .reactions, .reply, .code-header, .webpage'`, introduced by the comment "parts of
 * `.message` that are not the message text (link preview / fact-check boxes included)".
 *
 * Two entries are ours. `.clearfix` is the empty layout filler appended next to the timestamp
 * (`messageDiv.append(timeSpan, clearfix())`) — upstream never lists it because it holds no text
 * to highlight. `.bubble-fact-check` is the box upstream's comment names but its selector omits.
 *
 * The set is shared on purpose. Capture reads the source text with it and delivery confirmation
 * re-reads the sent bubble with it; had the two lists drifted apart, a message would have been
 * captured under one definition of "the text" and then verified against another.
 */
export const MESSAGE_TEXT_IGNORED_SELECTORS = [
  MESSAGE_TIME_SELECTOR,
  MESSAGE_LAYOUT_FIX_SELECTOR,
  MESSAGE_REACTIONS_SELECTOR,
  MESSAGE_REPLY_SELECTOR,
  MESSAGE_CODE_HEADER_SELECTOR,
  MESSAGE_WEBPAGE_SELECTOR,
  MESSAGE_FACT_CHECK_SELECTOR,
] as const;
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
 * One album photo inside its bubble.
 *
 * An album bubble carries a `data-mid` of its own — the group's main message — so the bubble and
 * one of its items publish the same identity. This is the node that identity really belongs to:
 * Web K rewrites each grouped item's mid separately when the server acknowledges that photo.
 */
export const OUTGOING_GROUPED_ITEM_SELECTOR = ".grouped-item[data-mid]";
/**
 * `is-outgoing` plus the `is-sending` status class mark a message still in flight.
 *
 * A third member, `.sending`, was dropped: no `classList` call in upstream ever sets it, so it
 * could only ever widen the selector with a name nothing carries. The `sending` that does exist
 * upstream is an icon name (`sendingStatus.ts`), not a bubble class. See
 * `outgoingMessageState.ts` for why both the class and the temporary `data-mid` are checked.
 */
export const IN_FLIGHT_SELECTOR = ".is-outgoing, .is-sending";
export const FAILED_SELECTOR = ".is-error";

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
/**
 * Web K still creates this overlay, but from the document-level handler in
 * `helpers/overlayClickHandler.ts` rather than inside the menu element.
 */
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
 * The attach control is Web K's `attach-menu-button` custom element
 * (`attachMenuButton.tsx`), and the element name is what this matches.
 *
 * An earlier comment here claimed the `attach-file` class had been dropped upstream and used that
 * to justify the change. It had not: `input.ts` still adds it. The selector is right for a
 * different reason — a registered custom-element name is the control's own identity, while
 * `attach-file` is a class applied to the menu it opens.
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
/**
 * The spinner Web K shows while preview media is still rendering.
 *
 * Both previous halves were dead. `.render-progress` never existed: `RenderProgressCircle`
 * renders an inline-styled div carrying neither class nor attribute, so conversion progress cannot
 * be observed at all. `.preloader` exists (`putPreloader.ts:13`) but the preview never calls
 * `putPreloader` — its spinner is a `ProgressivePreloader`, which tags its container
 * `preloader-container` (`preloader.ts:59`). With neither half matching, a preview counted as
 * ready the moment a caption and an enabled confirm button appeared, before the media had
 * rendered.
 */
export const UNREADY_MEDIA_SELECTOR = ".preloader-container";
export const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
