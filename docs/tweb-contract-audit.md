# Аудит DOM-контракта против исходников Telegram Web K

Сверка каждого селектора, класса и data-атрибута, по которым проект находит элементы
Telegram, с реальными исходниками `morethanwords/tweb`.

| | |
| --- | --- |
| Источник истины | `https://github.com/morethanwords/tweb`, ветка `master` |
| Ревизия upstream | `b21491cfdec248127cfb6a1e6617e26826021ff4` (2026-08-18) |
| Ревизия в контракте | `e3730e10073c3fc02e1360e3513b70b176d6afec` — на 46 коммитов позади master |
| Дата сверки | 2026-08-20 |
| Метод | tarball master распакован локально, поиск по `src/**` и `index.html`; проверялись только исходники |

Все ссылки на tweb — на файл и строку в указанной ревизии master. Строки со статусом
`OK` и `ПЕРЕИМЕНОВАН` без такой ссылки в таблице отсутствуют по условию задачи.

**Важно про статус.** Столбец «статус» отвечает ровно на один вопрос: существует ли этот
токен в upstream сегодня. Он **не** отвечает на вопрос, находит ли наш селектор то, что мы
им ищем. Токен может существовать, но висеть на другом узле — тогда селектор мёртв при
формально зелёном статусе. Такие случаи помечены **⚠** в столбце «чем заменить» и разобраны
в разделе [Что сломано прямо сейчас](#что-сломано-прямо-сейчас).

---

## 1. Левая колонка: список диалогов и нативный поиск

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `#column-left` | [domContract.ts:23](src/telegram/domContract.ts:23) → [TelegramRecipientSourceAdapter.ts:105](src/telegram/TelegramRecipientSourceAdapter.ts:105) | OK | `index.html:89`, `src/components/sidebarLeft/index.ts:143` | — |
| `.tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist` | [domContract.ts:24](src/telegram/domContract.ts:24) → [TelegramChatNavigator.ts:507](src/telegram/TelegramChatNavigator.ts:507) | OK | `tabs-tab`+`chatlist-parts`: `src/lib/appDialogsManager.ts:1474`; `chatlist`+`virtual-chatlist`: `src/components/sortedDialogList.ts:134`; `active`: `src/components/transition.ts:280` | — |
| `:scope > a.row.chatlist-chat[data-peer-id]` | [domContract.ts:26](src/telegram/domContract.ts:26) → [TelegramChatNavigator.ts:509](src/telegram/TelegramChatNavigator.ts:509) | OK | тег `a` + класс `row`: `src/components/row.ts:99-101` (через `asLink: true`, `src/lib/appDialogsManager.ts:315`); `chatlist-chat`: `src/lib/appDialogsManager.ts:414`; `data-peer-id`: `src/lib/appDialogsManager.ts:430` | — |
| `.tabs-tab.chatlist-parts.active a.row.chatlist-chat.active[data-peer-id]` | [domContract.ts:27](src/telegram/domContract.ts:27) → [TelegramComposerDom.ts:5](src/telegram/TelegramComposerDom.ts:5) | OK | `active` на строке: `src/lib/appDialogsManager.ts:1189` | — |
| `a.row.chatlist-chat.active[data-peer-id]` | [domContract.ts:29](src/telegram/domContract.ts:29) → [TelegramPeerEligibility.ts:4](src/telegram/TelegramPeerEligibility.ts:4) | OK | `src/lib/appDialogsManager.ts:414`, `:1189` | — |
| `#column-left #search-container .search-super-content-chats a.row.chatlist-chat[data-peer-id]` | [domContract.ts:30](src/telegram/domContract.ts:30) → [TelegramChatNavigator.ts:310](src/telegram/TelegramChatNavigator.ts:310) | OK | `#search-container`: `index.html:102`, `src/components/sidebarLeft/index.ts:1110`; `search-super-content-` + тип: `src/components/appSearchSuper.ts:608`; тип `'chats'`: `src/components/appSearchSuper.ts:598` | — |
| `a.row.chatlist-chat[data-peer-id]` | [domContract.ts:32](src/telegram/domContract.ts:32) → [TelegramRecipientSourceAdapter.ts:235](src/telegram/TelegramRecipientSourceAdapter.ts:235) | OK | `src/lib/appDialogsManager.ts:414`, `:430` | — |
| `#column-left .sidebar-header input.input-search-input[type="text"]` | [domContract.ts:33](src/telegram/domContract.ts:33) → [TelegramDomAdapter.ts:432](src/telegram/TelegramDomAdapter.ts:432) | OK | `sidebar-header`: `index.html:92`; `input-search-input`: `src/components/inputSearch.ts:83` | — |
| `#column-left .sidebar-slider-item.item-main` | [domContract.ts:35](src/telegram/domContract.ts:35) → [TelegramRecipientSourceAdapter.ts:106](src/telegram/TelegramRecipientSourceAdapter.ts:106) | OK | `index.html:91`; `sidebar-slider-item`: `src/components/sliderTab.ts:51`; `item-main`: `src/components/sidebarLeft/index.ts:1682` | — |
| `#column-left #search-container .search-super-content-chats` | [domContract.ts:36](src/telegram/domContract.ts:36) → [TelegramRecipientSourceAdapter.ts:229](src/telegram/TelegramRecipientSourceAdapter.ts:229) | OK | `src/components/appSearchSuper.ts:608` | — |
| `#column-left .sidebar-header .sidebar-back-button` | [domContract.ts:38](src/telegram/domContract.ts:38) → [TelegramRecipientSourceAdapter.ts:184](src/telegram/TelegramRecipientSourceAdapter.ts:184) | OK | `index.html:95`; `src/components/sidebarLeft/index.ts:157` | — |
| `is-search-active` | [domContract.ts:40](src/telegram/domContract.ts:40) → [TelegramRecipientSourceAdapter.ts:114](src/telegram/TelegramRecipientSourceAdapter.ts:114) | OK | `src/components/sidebarLeft/index.ts:1493` | — |
| `.search-group-recent, .search-group-messages` | [domContract.ts:42](src/telegram/domContract.ts:42) → [TelegramRecipientSourceAdapter.ts:236](src/telegram/TelegramRecipientSourceAdapter.ts:236) | OK | `search-group-recent`: `src/components/sidebarLeft/index.ts:1125`; `search-group-` + тип: `src/components/searchGroup.tsx:89`, тип `'messages'`: `src/components/sidebarLeft/index.ts:1123` | — |
| `.search-group-messages` | [domContract.ts:43](src/telegram/domContract.ts:43) → [TelegramDomAdapter.ts:445](src/telegram/TelegramDomAdapter.ts:445) | OK | `src/components/searchGroup.tsx:89` + `src/components/sidebarLeft/index.ts:1123` | — |
| `.peer-title` | [domContract.ts:45](src/telegram/domContract.ts:45) → [TelegramDomAdapter.ts:420](src/telegram/TelegramDomAdapter.ts:420) | OK | `src/components/peerTitle.ts:69` | — |
| `.row-subtitle` | [domContract.ts:46](src/telegram/domContract.ts:46) → [TelegramRecipientSourceAdapter.ts:21](src/telegram/TelegramRecipientSourceAdapter.ts:21) | OK | `src/components/row.ts:323` | — |
| `.avatar img` | [domContract.ts:47](src/telegram/domContract.ts:47) → [TelegramRecipientSourceAdapter.ts:276](src/telegram/TelegramRecipientSourceAdapter.ts:276) | OK | `.avatar`: `src/components/avatarNew.tsx:1073`; `<img>` внутри: `src/components/avatarNew.tsx:550` | ⚠ `<img>` появляется только когда у пира есть фото; градиент с инициалами img не содержит |
| `.is-forum` | [domContract.ts:48](src/telegram/domContract.ts:48) → [TelegramChatNavigator.ts:496](src/telegram/TelegramChatNavigator.ts:496) | OK | `src/components/avatarNew.tsx:997` | — |
| `.row-subtitle .i18n` | [domContract.ts:50](src/telegram/domContract.ts:50) → [TelegramPeerEligibility.ts:88](src/telegram/TelegramPeerEligibility.ts:88) | OK | `.i18n`: `src/lib/langPack.ts:522`; `.row-subtitle`: `src/components/row.ts:323` | — |
| `[aria-disabled="true"], .disabled, .is-disabled` | [domContract.ts:51](src/telegram/domContract.ts:51) → [TelegramPeerEligibility.ts:28](src/telegram/TelegramPeerEligibility.ts:28) | OK | `aria-disabled`: `src/components/rowTsx.tsx:103`, `src/components/sidebarLeft/tabs/chatAutomation.tsx:417`; `disabled`: `src/components/chat/inputState/useDirectMessages.ts:18`; `is-disabled`: `src/components/row.ts:359`, `src/components/popups/paymentCard.ts:459` | — |
| `.badge` | [domContract.ts:54](src/telegram/domContract.ts:54) → [TelegramRecipientSourceAdapter.ts:273](src/telegram/TelegramRecipientSourceAdapter.ts:273) | OK | `src/lib/appDialogsManager.ts:522` | — |
| `.dialog-subtitle-badge` | [domContract.ts:55](src/telegram/domContract.ts:55) → то же | OK | `src/lib/appDialogsManager.ts:522` | — |
| `.sending-status` | [domContract.ts:56](src/telegram/domContract.ts:56) → то же | OK | `src/lib/appDialogsManager.ts:437` | — |
| `.message-time` | [domContract.ts:57](src/telegram/domContract.ts:57) → то же | OK | `src/lib/appDialogsManager.ts:440` | — |

## 2. Центральная колонка: активный чат и композер

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `#column-center > .chats-container` | [domContract.ts:64](src/telegram/domContract.ts:64) → [TelegramComposerDom.ts:43](src/telegram/TelegramComposerDom.ts:43) | OK | `#column-center`: `index.html:107`, `src/lib/appImManager.ts:221`; `.chats-container`: `src/lib/appImManager.ts:324`; вложенность: `src/lib/appImManager.ts:329` | — |
| `:scope > .chat.tabs-tab.active` | [domContract.ts:65](src/telegram/domContract.ts:65) → [TelegramComposerDom.ts:45](src/telegram/TelegramComposerDom.ts:45) | OK | `chat`+`tabs-tab`: `src/components/chat/chat.ts:250`; вложенность: `src/lib/appImManager.ts:2955`; `active`: `src/components/transition.ts:280` | — |
| `:scope > .chat-input.chat-input-main` | [domContract.ts:66](src/telegram/domContract.ts:66) → [TelegramComposerDom.ts:51](src/telegram/TelegramComposerDom.ts:51) | OK | `src/components/chat/input.ts:477` (`CLASS_NAME` = `chat-input`, `src/components/chat/input.ts:202`; `chat-input-main` передан в `src/components/chat/chat.ts:613`); прямой ребёнок `.chat`: `src/components/chat/chat.ts:643` | — |
| `.chat-input-main` | [domContract.ts:67](src/telegram/domContract.ts:67) → [TelegramComposerDom.ts:84](src/telegram/TelegramComposerDom.ts:84) | OK | `src/components/chat/input.ts:477` | — |
| `.chat` | [domContract.ts:68](src/telegram/domContract.ts:68) → [TelegramChatNavigator.ts:477](src/telegram/TelegramChatNavigator.ts:477) | OK | `src/components/chat/chat.ts:250` | — |
| `.input-message-input[contenteditable="true"][data-peer-id]` | [domContract.ts:69](src/telegram/domContract.ts:69) → [TelegramComposerDom.ts:59](src/telegram/TelegramComposerDom.ts:59) | OK | `input-message-input`: `src/components/chat/input.ts:2988`; `contenteditable`: `src/components/inputField.ts:537`; `data-peer-id`: `src/components/chat/input.ts:2648` | — |
| `.input-message-input[data-peer-id]` | [domContract.ts:71](src/telegram/domContract.ts:71) → [TelegramPeerEligibility.ts:67](src/telegram/TelegramPeerEligibility.ts:67) | OK | `src/components/chat/input.ts:2988`, `:2648` | — |
| `.topbar .person-avatar[data-peer-id]` | [domContract.ts:72](src/telegram/domContract.ts:72) → [TelegramComposerDom.ts:124](src/telegram/TelegramComposerDom.ts:124) | OK | `topbar`: `src/components/chat/topbar.ts:134`; `person-avatar`: `src/components/chat/topbar.ts:1348`; `data-peer-id` на аватаре: `src/components/avatarNew.tsx:1076` | — |
| `.topbar .peer-title, .topbar .user-title` | [domContract.ts:73](src/telegram/domContract.ts:73) → [TelegramDomAdapter.ts:409](src/telegram/TelegramDomAdapter.ts:409) | OK | `user-title`: `src/components/chat/topbar.ts:165`; `.peer-title` внутри него: `src/components/chat/topbar.ts:1553` + `src/components/peerTitle.ts:69` | — |
| `[hidden], [aria-hidden="true"]` | [domContract.ts:74](src/telegram/domContract.ts:74) → [TelegramChatNavigator.ts:439](src/telegram/TelegramChatNavigator.ts:439) | OK | `aria-hidden`: `src/components/communities/communityAvatar.tsx:27` | — |
| `.chat.hide, .chat.is-hidden` | [domContract.ts:75](src/telegram/domContract.ts:75) → [TelegramComposerDom.ts:140](src/telegram/TelegramComposerDom.ts:140) | OK | `hide`: `src/components/appSearchSuper.ts:3112`; `is-hidden`: `src/components/appSearchSuper.ts:1392` | ⚠ Оба класса существуют, но **ни один из них не вешается на `.chat`** — `src/components/chat/chat.ts` трогает на контейнере только `chat`/`tabs-tab` (`:250`), `is-search-active` (`:808`) и `can-click-date` (`:1224`). Скрытие вкладок делается снятием `active` (`src/components/transition.ts:272`). Обе половины селектора мертвы; выбрасывать не обязательно — `ACTIVE_MAIN_CHAT_SELECTOR` уже требует `.active` |
| `.is-chat-input-hidden` | [domContract.ts:77](src/telegram/domContract.ts:77) → [TelegramPeerEligibility.ts:78](src/telegram/TelegramPeerEligibility.ts:78) | OK | `src/components/chat/bubbles.ts:6046` | ⚠ **Мёртвая ветка.** Класс ставится на `ChatBubbles.container`, то есть на `.bubbles` (`src/components/chat/bubbles.ts:1477-1478`), а `.bubbles` — **сосед** `.chat-input`, а не предок композера (`src/components/chat/chat.ts:643`). `composer.closest('.is-chat-input-hidden')` не сматчится никогда. Замена: смотреть `hide` на `.chat-input` (`src/components/chat/input.ts:477`, `:2269`) или проверять `.bubbles.is-chat-input-hidden` внутри того же `.chat` |
| `hide`, `is-hidden` | [domContract.ts:80](src/telegram/domContract.ts:80) → [TelegramComposerDom.ts:139](src/telegram/TelegramComposerDom.ts:139) | OK | `hide`: `src/components/chat/input.ts:477`, `src/components/appSearchSuper.ts:3112`; `is-hidden`: `src/components/appSearchSuper.ts:1392` | — (проверяется через `classList.contains` на самом `.chat-input` — это живой путь) |
| `active` | [domContract.ts:82](src/telegram/domContract.ts:82) → [MediaModeActivator.ts:217](src/telegram/MediaModeActivator.ts:217) | OK | меню: `src/helpers/contextMenuController.ts:140`; вкладки: `src/components/transition.ts:280`; попапы: `src/components/popups/index.ts:359` | — |

## 3. Пузыри сообщений

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `.bubble[data-mid][data-peer-id]` | [domContract.ts:88](src/telegram/domContract.ts:88) → [TelegramDomAdapter.ts:512](src/telegram/TelegramDomAdapter.ts:512) | OK | `bubble`: `src/components/chat/bubbles.ts:6816`; `data-mid`: `src/components/chat/bubbles.ts:6474`; `data-peer-id`: `src/components/chat/bubbles.ts:6475` | — |
| `.grouped-item[data-mid][data-peer-id]` | [domContract.ts:89](src/telegram/domContract.ts:89) → [TelegramDomAdapter.ts:252](src/telegram/TelegramDomAdapter.ts:252) | OK | `grouped-item`: `src/components/prepareAlbum.ts:36`, `src/components/wrappers/groupedDocuments.ts:138`; атрибуты для альбома: `src/components/wrappers/album.ts:75-76`; для документов: `src/components/wrappers/groupedDocuments.ts:86-87` | — |
| `.message` | [domContract.ts:91](src/telegram/domContract.ts:91) → [TelegramDomAdapter.ts:231](src/telegram/TelegramDomAdapter.ts:231) | OK | `src/components/chat/bubbles.ts:6898` | — |
| `.time` | [domContract.ts:92](src/telegram/domContract.ts:92) → [TelegramDomAdapter.ts:264](src/telegram/TelegramDomAdapter.ts:264) | OK | `src/components/chat/messageRender.ts:356` | — |
| `.clearfix` | [domContract.ts:93](src/telegram/domContract.ts:93) → [TelegramDomAdapter.ts:264](src/telegram/TelegramDomAdapter.ts:264) | OK | `src/helpers/dom/clearfix.ts:3` | — |
| `img.media-photo` | [domContract.ts:94](src/telegram/domContract.ts:94) → [TelegramDomAdapter.ts:241](src/telegram/TelegramDomAdapter.ts:241) | OK | `src/components/wrappers/photo.ts:221` (`<img>` создаётся на `:220`) | ⚠ При `size._ === 'videoSize'` тот же класс вешается на `<video>` (`src/components/wrappers/photo.ts:212-218`) — такие превью наш селектор намеренно пропускает |
| `video.media-video` | [domContract.ts:99](src/telegram/domContract.ts:99) → [TelegramDomAdapter.ts:232](src/telegram/TelegramDomAdapter.ts:232) | OK | `src/components/wrappers/video.ts:202` | — |
| `.media-round` | [domContract.ts:100](src/telegram/domContract.ts:100) → [TelegramDomAdapter.ts:283](src/telegram/TelegramDomAdapter.ts:283) | OK | `src/components/wrappers/video.ts:206` | — |
| `.media-gif-wrapper` | [domContract.ts:101](src/telegram/domContract.ts:101) → [TelegramDomAdapter.ts:283](src/telegram/TelegramDomAdapter.ts:283) | OK | `src/components/wrappers/video.ts:105` | — |
| `.attachment, .media-container` | [domContract.ts:102](src/telegram/domContract.ts:102) → [TelegramDomAdapter.ts:238](src/telegram/TelegramDomAdapter.ts:238) | OK | `attachment`: `src/components/chat/bubbles.ts:8201`; `media-container`: `src/components/wrappers/photo.ts:102` | — |
| `.attachment` | [domContract.ts:103](src/telegram/domContract.ts:103) → [TelegramDomAdapter.ts:244](src/telegram/TelegramDomAdapter.ts:244) | OK | `src/components/chat/bubbles.ts:8201` | — |
| `is-grouped` | [domContract.ts:104](src/telegram/domContract.ts:104) → [TelegramDomAdapter.ts:253](src/telegram/TelegramDomAdapter.ts:253) | OK | `src/components/chat/bubbles.ts:8218` | — |
| `.bubble.is-out` | [domContract.ts:105](src/telegram/domContract.ts:105) → [outgoingMessageState.ts:77](src/telegram/outgoingMessageState.ts:77) | OK | `is-out`: `src/components/chat/bubbles.ts:6816`, `src/components/chat/bubbles/bubbleLayout.tsx:50` | — |
| `.bubble.is-out[data-mid][data-peer-id], .bubble.is-out .grouped-item[data-mid]` | [domContract.ts:110](src/telegram/domContract.ts:110) → [TelegramSendAdapter.ts:455](src/telegram/TelegramSendAdapter.ts:455) | OK | `src/components/chat/bubbles.ts:6816`, `:6474-6475`; `.grouped-item`: `src/components/wrappers/album.ts:75` | — |
| `.is-outgoing` | [domContract.ts:117](src/telegram/domContract.ts:117) → [outgoingMessageState.ts:37](src/telegram/outgoingMessageState.ts:37) | OK | `src/components/chat/bubbles.ts:8085` (снимается на `:950` при подтверждении, на `:1157` при ошибке) | — |
| `.is-sending` | [domContract.ts:117](src/telegram/domContract.ts:117) → [outgoingMessageState.ts:37](src/telegram/outgoingMessageState.ts:37) | OK | `src/components/chat/bubbles.ts:6659` (`'is-' + status`, status = `'sending'` из `src/components/chat/bubbles.ts:10060`); литеральные проверки: `src/components/chat/bubbles.ts:1598`, `:1846`, `:6658` | — |
| `.sending` | [domContract.ts:117](src/telegram/domContract.ts:117) → [outgoingMessageState.ts:37](src/telegram/outgoingMessageState.ts:37), [outgoingMessageState.ts:28](src/telegram/outgoingMessageState.ts:28) | **ПЕРЕИМЕНОВАН** → `.is-sending` | нового имени: `src/components/chat/bubbles.ts:6659`. Голого класса `sending` на пузыре нет нигде: `classList.*('sending')` в `src/**` не встречается; строка `'sending'` в `src/components/sendingStatus.ts:37` — это **имя иконки**, которое `src/components/icon.ts:34` превращает в `class="tgico sending-status-icon sending-status-icon-sending"` | `.is-sending` (уже присутствует в селекторе) — третью часть можно удалить |
| `.is-error` | [domContract.ts:118](src/telegram/domContract.ts:118) → [outgoingMessageState.ts:47](src/telegram/outgoingMessageState.ts:47) | OK | `src/components/chat/bubbles.ts:6659` (status = `'error'`, `src/components/chat/bubbles.ts:1158`); литерально `:6658`, `:4438` | — |
| `[data-mid*="."]` (временный mid) | [outgoingMessageState.ts:28](src/telegram/outgoingMessageState.ts:28) | OK | `src/lib/appManagers/appMessagesIdsManager.ts:11-13` (`+(id + 0.0001).toFixed(4)`); запись в DOM: `src/components/chat/bubbles.ts:6474` | — |
| `data-timestamp` | [TelegramDomAdapter.ts:512](src/telegram/TelegramDomAdapter.ts:512) | OK | `src/components/chat/bubbles.ts:6476` | ⚠ Не заведён в `contracts/tweb-dom-contract.json` — скриптом не охраняется |

## 4. Нативный режим выделения

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `.chat-input-wrapper.selection-wrapper` | [domContract.ts:124](src/telegram/domContract.ts:124) → [TelegramSelectionDomAdapter.ts:70](src/telegram/TelegramSelectionDomAdapter.ts:70) | OK | `src/components/chat/selection.ts:1128` | — |
| `.chat-input-plate.selection-container` | [domContract.ts:125](src/telegram/domContract.ts:125) → [TelegramSelectionDomAdapter.ts:77](src/telegram/TelegramSelectionDomAdapter.ts:77) | OK | `chat-input-plate`: `src/components/chat/controlPlate.tsx:9`, применён на `:36`; `selection-container` передан туда из `src/components/chat/selection.ts:1206` | — |
| `.selection-container-forward` | [domContract.ts:126](src/telegram/domContract.ts:126) → [TelegramSelectionDomAdapter.ts:78](src/telegram/TelegramSelectionDomAdapter.ts:78) | OK | `src/components/chat/selection.ts:1192` | — |
| `selection-container-forward` (класс) | [domContract.ts:127](src/telegram/domContract.ts:127) → [TelegramSelectionIntegration.ts:7](src/telegram/TelegramSelectionIntegration.ts:7) | OK | `src/components/chat/selection.ts:1192` | — |
| `.selection-container-count` | [domContract.ts:128](src/telegram/domContract.ts:128) → [TelegramSelectionDomAdapter.ts:79](src/telegram/TelegramSelectionDomAdapter.ts:79) | OK | `src/components/chat/selection.ts:1134` | — |
| `.bubbles.is-selecting` | [domContract.ts:129](src/telegram/domContract.ts:129) → [TelegramSelectionDomAdapter.ts:66](src/telegram/TelegramSelectionDomAdapter.ts:66) | OK | `bubbles`: `src/components/chat/bubbles.ts:1478`; `is-selecting` на нём: `src/components/chat/selection.ts:1105` (`listenElement`), который приходит из `src/components/chat/bubbles.ts:1516` | — |
| `.bubble.is-selected[…], .grouped-item.is-selected[…]` | [domContract.ts:130](src/telegram/domContract.ts:130) → [TelegramSelectionDomAdapter.ts:197](src/telegram/TelegramSelectionDomAdapter.ts:197) | OK | `is-selected`: `src/components/chat/selection.ts:382` | — |
| `.bubble-select-checkbox input.checkbox-field-input[type="checkbox"]:checked` | [domContract.ts:132](src/telegram/domContract.ts:132) → [TelegramSelectionDomAdapter.ts:199](src/telegram/TelegramSelectionDomAdapter.ts:199) | OK | `bubble-select-checkbox`: `src/components/chat/selection.ts:635`; `checkbox-field-input` + `type="checkbox"`: `src/components/checkboxField.ts:58-59` | — |
| `.grouped-item, .bubble.is-grouped` | [domContract.ts:134](src/telegram/domContract.ts:134) → [TelegramSelectionDomAdapter.ts:141](src/telegram/TelegramSelectionDomAdapter.ts:141) | OK | `src/components/prepareAlbum.ts:36`; `src/components/chat/bubbles.ts:8218` | — |
| `chat-input-plate-side` | [domContract.ts:136](src/telegram/domContract.ts:136) → [TelegramSelectionIntegration.ts:128](src/telegram/TelegramSelectionIntegration.ts:128) | OK | `src/components/chat/controlPlate.tsx:37`, `:39` | — |
| `[disabled]` на кнопке форварда | [TelegramSelectionDomAdapter.ts:126](src/telegram/TelegramSelectionDomAdapter.ts:126) | OK | `src/components/chat/selection.ts:1238` (`this.selectionForwardBtn?.toggleAttribute('disabled', cantForward)` в `onUpdateContainer`, `:1222`) | — |

## 5. Меню

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `.btn-menu.active` | [domContract.ts:142](src/telegram/domContract.ts:142) → [MediaModeActivator.ts:160](src/telegram/MediaModeActivator.ts:160) | OK | `btn-menu`: `src/components/buttonMenu.ts:255`; `active`: `src/helpers/contextMenuController.ts:140` | — |
| `.btn-menu.contextmenu.active` | [domContract.ts:143](src/telegram/domContract.ts:143) → [TelegramContextMenuIntegration.ts:182](src/telegram/TelegramContextMenuIntegration.ts:182) | OK | `contextmenu`: `src/helpers/dom/createContextMenu.ts:141`, `src/components/chat/contextMenu.ts:1590` | — |
| `.btn-menu-items` | [domContract.ts:150](src/telegram/domContract.ts:150) → [TelegramDomAdapter.ts:533](src/telegram/TelegramDomAdapter.ts:533) | OK | `src/components/chat/contextMenu.ts:2353` (только при `!IS_MOBILE` и наличии панели реакций; там же ставится `has-items-wrapper` на `:2354`) | — |
| `.btn-menu-item` | [domContract.ts:151](src/telegram/domContract.ts:151) → [MediaModeActivator.ts:161](src/telegram/MediaModeActivator.ts:161) | OK | `src/components/buttonMenu.ts:106` | — |
| `:scope > .btn-menu-item` | [domContract.ts:152](src/telegram/domContract.ts:152) → [TelegramContextMenuIntegration.ts:11](src/telegram/TelegramContextMenuIntegration.ts:11) | OK | `src/components/buttonMenu.ts:106` | — |
| `.btn-menu-item-text` | [domContract.ts:153](src/telegram/domContract.ts:153) → [MediaModeActivator.ts:162](src/telegram/MediaModeActivator.ts:162) | OK | `src/components/buttonMenu.ts:166` | — |
| `.btn-menu-overlay` | [domContract.ts:158](src/telegram/domContract.ts:158) → [MediaModeActivator.ts:212](src/telegram/MediaModeActivator.ts:212) | OK | `src/helpers/overlayClickHandler.ts:89` | — |
| `menu-open` | [domContract.ts:160](src/telegram/domContract.ts:160) → [MediaModeActivator.ts:199](src/telegram/MediaModeActivator.ts:199) | OK | ставится на trigger-элемент: `src/helpers/contextMenuController.ts:142`; читается там же в toggle: `src/components/buttonMenuToggle.ts:33` | — |
| `btn-menu-item`, `rp-overflow` | [domContract.ts:162](src/telegram/domContract.ts:162) → [TelegramContextMenuIntegration.ts:88](src/telegram/TelegramContextMenuIntegration.ts:88) | OK | `src/components/buttonMenu.ts:106` (оба класса в одной строке) | — |
| `tgico`, `btn-menu-item-icon` | [domContract.ts:163](src/telegram/domContract.ts:163) → [TelegramContextMenuIntegration.ts:92](src/telegram/TelegramContextMenuIntegration.ts:92) | OK | `tgico`: `src/helpers/tgico.ts:1`; `btn-menu-item-icon`: `src/components/buttonMenu.ts:116` | — |
| `btn-menu-item-text` | [domContract.ts:164](src/telegram/domContract.ts:164) → [TelegramContextMenuIntegration.ts:96](src/telegram/TelegramContextMenuIntegration.ts:96) | OK | `src/components/buttonMenu.ts:166` | — |

## 6. Вложения, upload preview и кнопки отправки

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `.new-message-wrapper input[type="file"]` | [domContract.ts:170](src/telegram/domContract.ts:170) → [MediaModeActivator.ts:73](src/telegram/MediaModeActivator.ts:73) | OK | `new-message-wrapper`: `src/components/chat/input.ts:1028`; input: `src/components/chat/input.ts:1307-1309`; вложенность: `src/components/chat/input.ts:1313-1323` | — |
| `attach-menu-button` | [domContract.ts:175](src/telegram/domContract.ts:175) → [MediaModeActivator.ts:81](src/telegram/MediaModeActivator.ts:81) | OK | `src/components/chat/attachMenuButton.tsx:21-22` (`defineSolidElement({name: 'attach-menu-button'})`); экземпляр: `src/components/chat/input.ts:1234` | ⚠ Комментарий в [domContract.ts:172-174](src/telegram/domContract.ts:172) утверждает, что класс `attach-file` «был убран». Это неверно: он **по-прежнему ставится** — `src/components/chat/input.ts:1295`. Сам селектор рабочий, ошибочна только мотивировка |
| `.btn-send` | [domContract.ts:176](src/telegram/domContract.ts:176) → [TelegramSendAdapter.ts:188](src/telegram/TelegramSendAdapter.ts:188) | OK | `src/components/chat/input.ts:1344` | — |
| `.popup-send-photo.popup-new-media.active` | [domContract.ts:177](src/telegram/domContract.ts:177) → [MediaModeActivator.ts:66](src/telegram/MediaModeActivator.ts:66) | OK | `src/components/popups/newMedia.ts:163`; `popup` + `active`: `src/components/popups/index.ts:121`, `:359` | — |
| `.popup.popup-forward.active` | [domContract.ts:178](src/telegram/domContract.ts:178) → [TelegramChatNavigator.ts:448](src/telegram/TelegramChatNavigator.ts:448) | OK | `popup-forward`: `src/components/popups/pickUser.tsx:581`; композиция с `popup`/`active`: `src/components/popups/indexTsx.tsx:333-337` | — |
| `.popup-item.popup-item-media img` | [domContract.ts:179](src/telegram/domContract.ts:179) → [TelegramSendAdapter.ts:204](src/telegram/TelegramSendAdapter.ts:204) | OK | `popup-item`: `src/components/popups/newMedia.ts:1779`; `popup-item-media`: `src/components/popups/newMedia.ts:1274`; `<img>` внутри + blob-URL: `src/components/popups/newMedia.ts:1460-1463` | — |
| `.popup-item.popup-item-media` | [domContract.ts:180](src/telegram/domContract.ts:180) → [TelegramSendAdapter.ts:242](src/telegram/TelegramSendAdapter.ts:242) | OK | `src/components/popups/newMedia.ts:1779`, `:1274` | — |
| `.popup-item.popup-item-document` | [domContract.ts:181](src/telegram/domContract.ts:181) → [TelegramSendAdapter.ts:243](src/telegram/TelegramSendAdapter.ts:243) | OK | `src/components/popups/newMedia.ts:1779`, `:1666` | — |
| `.popup-item-album` | [domContract.ts:182](src/telegram/domContract.ts:182) → [TelegramSendAdapter.ts:250](src/telegram/TelegramSendAdapter.ts:250) | OK | `src/components/popups/newMedia.ts:2052` | — |
| `.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)` | [domContract.ts:183](src/telegram/domContract.ts:183) → [TelegramSendAdapter.ts:215](src/telegram/TelegramSendAdapter.ts:215) | OK | `simple-message-input` + `-input`: `src/components/inputFieldMessage.tsx:54`, `:138`; использование в превью: `src/components/popups/newMedia.ts:385`; `input-field-input-fake`: `src/components/inputFieldAnimated.ts:42` | — |
| `.simple-message-input-confirm` | [domContract.ts:185](src/telegram/domContract.ts:185) → [TelegramSendAdapter.ts:16](src/telegram/TelegramSendAdapter.ts:16) | OK | `src/components/inputFieldMessage.tsx:58`, `:80`; это `<button>`: `src/components/popups/index.ts:196`, передан в `src/components/popups/newMedia.ts:399` | — (`confirm.disabled` осмыслен: элемент действительно `HTMLButtonElement`) |
| `.popup-close` | [domContract.ts:186](src/telegram/domContract.ts:186) → [UploadPreviewAdapter.ts:15](src/telegram/UploadPreviewAdapter.ts:15) | OK | `src/components/popups/index.ts:157` | — |
| `.animating, .is-changing-height` | [domContract.ts:187](src/telegram/domContract.ts:187) → [UploadPreviewAdapter.ts:201](src/telegram/UploadPreviewAdapter.ts:201) | OK | `animating`: `src/components/singleTransition.ts:73`, `src/components/transition.ts:305`; `is-changing-height`: `src/components/inputFieldAnimated.ts:88` | — |
| `.preloader` | [domContract.ts:192](src/telegram/domContract.ts:192) → [UploadPreviewAdapter.ts:357](src/telegram/UploadPreviewAdapter.ts:357) | **ПЕРЕИМЕНОВАН** → `.preloader-container` | нового имени: `src/components/preloader.ts:59` (`ProgressivePreloader.constructContainer`); upstream сам ищет его как `.preloader-container.manual` в `src/components/wrappers/document.ts:43`. Голый `.preloader` ещё существует (`src/components/putPreloader.ts:13`), но `putPreloader` в превью не вызывается: в `src/components/popups/newMedia.ts` слово `preloader` не встречается ни разу, а `wrapVideo` зовётся с `withoutPreloader: true` (`src/components/popups/newMedia.ts:1834`) | `.preloader-container` |
| `.render-progress` | [domContract.ts:192](src/telegram/domContract.ts:192) → [UploadPreviewAdapter.ts:357](src/telegram/UploadPreviewAdapter.ts:357) | **НЕ НАЙДЕН** | класса нет: `RenderProgressCircle` рендерит `<div>` только с inline-стилями (`src/components/mediaEditor/renderProgressCircle.tsx:8-25`). Единственное вхождение строки `render-progress` в `src/**` — комментарий в `src/components/avatarEdit.ts:394` | Прогресс конвертации ловить по самому `RenderProgressCircle` нечем — у него нет ни класса, ни атрибута. Ближайшая наблюдаемая замена — `.preloader-container` для загрузки медиа |
| `.reply-wrapper` | [domContract.ts:193](src/telegram/domContract.ts:193) → [TelegramChatNavigator.ts:429](src/telegram/TelegramChatNavigator.ts:429) | OK | `src/components/chat/input.ts:637` | — |

## 7. Селекторы и атрибуты вне `domContract.ts`

Найдены при сплошном обходе `src/`. Все они — тоже часть контракта с Telegram, но
`contracts/tweb-dom-contract.json` их не содержит, поэтому `scripts/check-tweb-contract.mjs`
за ними не следит.

| селектор | где у нас | статус | где в tweb | чем заменить |
| --- | --- | --- | --- | --- |
| `data-sponsored="true"` | [TelegramChatNavigator.ts:495](src/telegram/TelegramChatNavigator.ts:495), [TelegramPeerEligibility.ts:26](src/telegram/TelegramPeerEligibility.ts:26) | OK | `src/components/appSearchSuper.ts:1668` | ⚠ Добавить токен в `contracts/tweb-dom-contract.json` |
| `data-thread-id` | [TelegramChatNavigator.ts:498](src/telegram/TelegramChatNavigator.ts:498), [:516](src/telegram/TelegramChatNavigator.ts:516) | OK | `src/lib/appDialogsManager.ts:432` | ⚠ Не в контракте |
| `data-monoforum-parent-peer-id` | [TelegramChatNavigator.ts:499](src/telegram/TelegramChatNavigator.ts:499), [:517](src/telegram/TelegramChatNavigator.ts:517) | OK | `src/lib/appDialogsManager.ts:433` | ⚠ Не в контракте |
| `data-mid` на строке диалога (признак «не простой получатель») | [TelegramChatNavigator.ts:497](src/telegram/TelegramChatNavigator.ts:497), [TelegramDomAdapter.ts:417](src/telegram/TelegramDomAdapter.ts:417) | OK | результаты поиска по сообщениям получают `data-mid`: `src/components/appSearchSuper.ts:1499` (рядом с `data-timestamp` на `:1501`) | — |
| `night` на `<html>` | [CaptureNotice.ts:87](src/ui/CaptureNotice.ts:87) | OK | `src/helpers/themeController.ts:328` | ⚠ Не в контракте |
| `img[alt]` при чтении текста | [readTelegramText.ts:80-81](src/telegram/readTelegramText.ts:80) | OK | upstream читает то же самое: `src/helpers/dom/getRichElementValue.ts:360`, `:376-378` | — |
| `custom-emoji-element` / `data-sticker-emoji` | **отсутствует** — [readTelegramText.ts:80](src/telegram/readTelegramText.ts:80) знает только тег `IMG` | **НЕ НАЙДЕН** (у нас) | тег: `src/lib/customEmoji/element.ts:188`; атрибут: `src/lib/richTextProcessor/wrapRichText.ts:417`; upstream читает его **раньше** `alt`: `src/helpers/dom/getRichElementValue.ts:360` | Читать `element.dataset.stickerEmoji` до проверки на `IMG` — иначе кастомные эмодзи молча теряются из текста |

---

## Что сломано прямо сейчас

Отсортировано по критичности.

### 1. Проверка готовности медиа в upload preview мертва целиком — **высокая**

`UNREADY_MEDIA_SELECTOR = ".preloader, .render-progress"`
([domContract.ts:192](src/telegram/domContract.ts:192)) используется в
[UploadPreviewAdapter.ts:357](src/telegram/UploadPreviewAdapter.ts:357) как единственный
признак «медиа ещё грузится». Обе половины не находят ничего:

* `.render-progress` не существует нигде в upstream (`renderProgressCircle.tsx:8-25` — div
  без классов);
* `.preloader` существует (`putPreloader.ts:13`), но `putPreloader` из превью не вызывается
  — в `popups/newMedia.ts` строки `preloader` нет вообще, а спиннер загрузки медиа это
  `ProgressivePreloader` с классом `preloader-container` (`preloader.ts:59`).

Следствие: `inspectGeneralizedPreview` считает превью готовым, как только появились
подпись и активная кнопка подтверждения, не дожидаясь, пока медиа реально отрендерится.
Замена: `.preloader-container`. Прогресс конвертации (`RenderProgressCircle`) наблюдать
нечем — у элемента нет ни класса, ни атрибута.

### 2. `.is-chat-input-hidden` проверяется не по той оси — **средняя**

[TelegramPeerEligibility.ts:78](src/telegram/TelegramPeerEligibility.ts:78) вызывает
`composer.closest(HIDDEN_COMPOSER_ANCESTOR_SELECTOR)`. Класс существует
(`bubbles.ts:6046`), но висит на `.bubbles` (`bubbles.ts:1477-1478`), а тот — **сосед**
`.chat-input`, а не предок композера (`chat.ts:643`). `closest()` его не увидит никогда.

Смягчающее обстоятельство: сразу следом идёт `getComputedStyle`-проверка на
`display`/`visibility` ([TelegramPeerEligibility.ts:83-84](src/telegram/TelegramPeerEligibility.ts:83)),
которая практический случай закрывает. Поэтому это дефект, а не отказ.
Замена: `hide` на `.chat-input` (`input.ts:477`, `:2269`) либо
`.bubbles.is-chat-input-hidden` внутри того же `.chat`.

### 3. Кастомные эмодзи теряются при чтении текста — **средняя**

[readTelegramText.ts:80](src/telegram/readTelegramText.ts:80) достаёт `alt` только у тега
`IMG`. Кастомные эмодзи в Web K — это `<custom-emoji-element>`
(`lib/customEmoji/element.ts:188`) c `data-sticker-emoji`
(`richTextProcessor/wrapRichText.ts:417`), и upstream читает именно его, **до** `alt`
(`getRichElementValue.ts:360`). Наш обходчик проваливается в `childNodes` и не добавляет
ничего.

Бьёт по каждой сверке текста — проверке вставленной подписи и подтверждению отправленного
сообщения ([TelegramSendAdapter.ts:429](src/telegram/TelegramSendAdapter.ts:429)): исходник
и результат сравниваются по строке, из которой у обоих выпал эмодзи. Пока это симметрично —
ложных срабатываний нет, но текст мы читаем неверно.

### 4. `.sending` — мёртвый остаток, безвредный — **низкая**

`IN_FLIGHT_SELECTOR` ([domContract.ts:117](src/telegram/domContract.ts:117)) и
`IN_FLIGHT_MARKER_SELECTOR` ([outgoingMessageState.ts:28](src/telegram/outgoingMessageState.ts:28))
содержат `.sending`. В upstream такого класса на пузыре нет: `classList.*('sending')` в
`src/**` не встречается, а `'sending'` в `sendingStatus.ts:37` — имя иконки, которое
`icon.ts:34` превращает в `tgico sending-status-icon sending-status-icon-sending`.

**Подозрение из задания на проверки «сообщение ещё отправляется» подтвердилось только
частично.** Сами проверки живы:

* в навигаторе ([TelegramChatNavigator.ts:479-484](src/telegram/TelegramChatNavigator.ts:479))
  `OutgoingInFlightBaseline` работает на `.is-outgoing` (`bubbles.ts:8085`), `.is-sending`
  (`bubbles.ts:6659`) и дробном `data-mid` (`appMessagesIdsManager.ts:11-13`) — все три
  сигнала реальны;
* в upload preview ([UploadPreviewAdapter.ts:231](src/telegram/UploadPreviewAdapter.ts:231),
  [:270](src/telegram/UploadPreviewAdapter.ts:270)) тот же baseline берётся в области
  `composer.chat`, где пузыри действительно живут, — тоже работает.

Мёртв только `.sending` как третий член в `OR`. Убрать можно, риска нет.
Мёртвой в превью оказалась **другая** проверка — готовности медиа, см. пункт 1.

### 5. Комментарий про `attach-file` неверен — **низкая, только документация**

[domContract.ts:172-174](src/telegram/domContract.ts:172) утверждает, что класс
`attach-file` «был убран», и этим обосновывает переход на `attach-menu-button`. Класс на
месте: `src/components/chat/input.ts:1295`. Селектор рабочий, врёт только мотивировка.

### 6. Пять токенов вне охраны чекера — **низкая, процессная**

`data-sponsored`, `data-thread-id`, `data-monoforum-parent-peer-id`, `data-timestamp` и
`night` используются в `src/`, существуют в upstream, но не заведены в
`contracts/tweb-dom-contract.json` — их пропажу `scripts/check-tweb-contract.mjs` не
заметит.

---

## Замечание о существующем чекере

`node scripts/check-tweb-contract.mjs --ref master` на ревизии `b21491c` даёт
`verified: 96, missing: 0`. Это не противоречит находкам выше: чекер проверяет **наличие
токена в тексте исходников**, а не то, на каком узле он висит, — ровно как написано в его
собственной документации (`scripts/check-tweb-contract.mjs:6-8`). Все три структурные
поломки (пункты 1, 2, 3) для него невидимы по построению: `.preloader` и
`.is-chat-input-hidden` в upstream существуют — просто не там, где мы их ищем, а
`data-sticker-emoji` мы вообще не читаем.

`.sending` и `.render-progress` чекер уже помечает как `legacy` и из проверки исключает,
поэтому и они в `missing` не попадают.
