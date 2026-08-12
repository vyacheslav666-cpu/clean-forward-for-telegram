# Source message and native selection research

Дата исследования: 2026-08-10. Целевая среда: Chrome Desktop, обычная вкладка Telegram Web K и установленное Chrome/PWA-приложение Telegram Web K. Production-код не изменялся.

Исследование основано на:

- текущем `main` проекта Clean Forward;
- безопасной DOM-проверке в авторизованном Telegram Web K без отправки сообщений;
- `morethanwords/tweb` `master` на commit [`e3730e10073c3fc02e1360e3513b70b176d6afec`](https://github.com/morethanwords/tweb/tree/e3730e10073c3fc02e1360e3513b70b176d6afec).

Статусы в документе:

- **GREEN** — можно воспроизвести как новое сообщение через устойчивый нативный UI-путь с приемлемой проверкой результата.
- **YELLOW** — возможно при явных ограничениях семантики, доступности bytes/model или составной проверке результата.
- **RED** — штатный UI Web K не даёт безопасного детерминированного пути воспроизведения исходной семантики.

Под «сохранением семантики» понимается тип сообщения на стороне получателя, а не буквальное сохранение server-side identity, автора, результатов голосования, replies или forward metadata. Любая clean-копия получает новые `message id`, дату и автора.

## 1. Current architecture

Текущий pipeline уже правильно разделён на несколько границ:

1. `TelegramContextMenuIntegration` передаёт выбранный DOM-элемент сообщения.
2. `MessageExtractor` получает `TelegramMessageSnapshot` из `TelegramDomAdapter`.
3. `MessagePayload` допускает только `text` либо один `image` с необязательной подписью.
4. `PendingTransfer` хранит один неизменяемый payload до начала доставки.
5. Собственный `RecipientPickerController` выбирает одного или нескольких получателей.
6. `DeliveryCoordinator` последовательно обходит получателей, навигируется, проверяет peer/composer, сохраняет draft, подготавливает payload, нажимает нативный Send и ждёт новый outgoing `data-mid`.
7. Повтор допускается только до Send. Неоднозначность после Send останавливает batch и не выставляет payload как retryable.
8. Draft восстанавливается в `finally`; после batch восстанавливается исходный чат; полностью успешный summary автоматически закрывается.

Это foundation сохраняется. Обобщать нужно **source/capture и единицу доставки**, а не заново проектировать recipient picker или внешний orchestration.

Текущие границы:

- `MessageExtractor` намеренно отвергает `hasUnsupportedAttachment` и `imageCount > 1`;
- plain/formatted text сейчас извлекается из DOM как строка, поэтому entities теряются;
- изображение читается из browser-owned URL через `fetch` как `Blob`;
- `DeliveryCoordinator` предполагает один `MessagePayload` на одного получателя;
- `TelegramSendAdapter` подтверждает ровно одно новое outgoing-сообщение. Для альбома или нескольких source messages это недостаточно: один Send может породить несколько `mid`, а несколько units — несколько последовательных Send.

Неизменяемые non-regression invariants:

- внешний цикл по recipients остаётся последовательным;
- draft принадлежит конкретному peer и всегда восстанавливается;
- source chat восстанавливается в общем `finally`;
- bounded retry разрешён только до необратимого Send click;
- после Send нет автоматического повторного клика;
- подтверждение требует нового outgoing identity, а не только исчезновения preview;
- ambiguous result остаётся terminal/fail-closed;
- cancel прекращает работу на ближайшей безопасной pre-Send границе.

## 2. Telegram selection model

### 2.1 Подтверждённый DOM

В live Web K вход выполнялся через контекстное меню сообщения → `Select`. Ничего не отправлялось. Подтверждены следующие признаки:

| Назначение | Подтверждённый DOM |
|---|---|
| Selection mode | `.bubbles.is-selecting` и `.chat-input-main.is-selecting` |
| Selectable rendered message | `.bubble[data-mid][data-peer-id]` |
| Album item | `.grouped-item[data-mid][data-peer-id]` |
| Checkbox | label `.bubble-select-checkbox`, внутри `input.checkbox-field-input[type="checkbox"]` |
| Selected projection | `.bubble.is-selected` или `.grouped-item.is-selected`, checkbox `checked` |
| Toolbar wrapper | `.chat-input-wrapper.selection-wrapper` |
| Toolbar | `.chat-input-plate.selection-container` |
| Count | `.selection-container-count` |
| Native Forward | `.selection-container-forward` |
| Delete | `.selection-container-delete` |

У checkbox наблюдался `id="input-{mid}"`, но это эвристика оформления, а не identity API. Надёжными признаками identity в DOM являются только совместно проверенные `data-peer-id` и `data-mid` на bubble/grouped item.

### 2.2 Где хранится выбранный набор

Источник истины — не DOM. `AppSelection` хранит:

```ts
Map<PeerId, Set<number>> selectedMids
```

См. [`selection.ts#L59`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L59). `toggleMid` изменяет map/set ([`selection.ts#L535-L573`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L535-L573)); `cancelSelection` очищает его ([`selection.ts#L495-L501`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L495-L501)).

`getSelectedMessages()` разрешает каждую пару `(peerId, mid)` через `appMessagesManager.getMessageFromStorage`, то есть Telegram сам не извлекает выбранное сообщение из видимого текста ([`selection.ts#L433-L440`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L433-L440)).

### 2.3 Порядок и native Forward/Delete

`getSelectedMids()` делает numeric ascending sort ([`selection.ts#L429-L430`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L429-L430)). Native Forward строит объект вида `{ [fromPeerId]: sortedMid[] }` прямо из `selectedMids` и вызывает `showForwardPopup` ([`selection.ts#L1192-L1201`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L1192-L1201)). Delete также получает внутренние IDs, а не DOM nodes.

В обычном chat selection практически все элементы принадлежат одному source peer, хотя `Map` технически поддерживает несколько peer (например, другие Telegram contexts). Для Clean Forward порядок должен нормализоваться внутри одного source chat по `mid ASC`; `date` используется как проверка/diagnostic и tie-breaker, а не как единственный ключ.

### 2.4 Range selection и albums

Desktop range selection в текущем Web K — drag: `mousedown`, затем `mousemove`, вычисление элементов между anchor/end. Shift-click в live-проверке выбрал только второй элемент, диапазон не создал. Touch использует long-press/gesture path. Источник: [`selection.ts#L164-L316`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L164-L316).

Для album/grouped documents selection unit может быть внешней `.bubble` либо отдельным `.grouped-item`. Range logic расширяет album до всех его items, кроме случая, когда обе границы — items того же album. См. [`selectionRange.ts`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selectionRange.ts) и [`selection.ts#L925-L1022`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L925-L1022).

### 2.5 Virtualized DOM

При входе в selection mode Telegram добавляет checkbox только к `getRenderedHistory('asc')` ([`selection.ts#L911-L918`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/selection.ts#L911-L918)). При последующем render/recycle `toggleElementCheckbox` заново проецирует состояние из `selectedMids`. Следствия:

- `.is-selected` перечисляет только выбранные **сейчас отрисованные** элементы;
- offscreen selected message может отсутствовать из DOM;
- DOM index меняется при virtualization;
- toolbar count может быть больше числа `.is-selected` nodes;
- observer, следящий только за `class=is-selected`, не способен гарантированно восстановить полный selected-set.

### 2.6 Можно ли добавить «Отправить как новое» в native toolbar

Визуально — да: sibling-кнопка с теми же toolbar classes не требует клика по native Forward. Семантически безопасно — только если имеется полный и проверенный selected-set.

Обычный userscript не получает стабильную ссылку на module-private `chat.selection.selectedMids`. Поэтому допустимы лишь два режима:

1. **Verified internal read bridge** — read-only bridge для snapshot `Map<peerId, Set<mid>>`, привязанный к конкретной проверенной версии Web K. При несовпадении contract/version — feature off.
2. **DOM fail-closed fallback** — собрать видимые `.is-selected`, сравнить количество уникальных `(peerId, mid)` с toolbar count и отказаться, если числа не совпали, есть group ambiguity или любой элемент без identity. Это не общая поддержка selection, а ограниченный fallback.

Собственный source-selection controller над DOM может быть надёжнее native toolbar только если он сам владеет полным набором identities и не пытается «подсмотреть» уже существующий native selection. На mobile/PWA он должен оставаться отдельным адаптером ввода; delivery model от этого не меняется.

Перехватывать native Forward после клика нельзя: доказанной атомарной границы между выбранным набором и запуском forward flow нет. Clean Forward button не должен вызывать `.selection-container-forward` вообще.

## 3. Source-message identity model

### 3.1 Наблюдаемые DOM-поля

В live Web K подтверждены:

- `.bubble[data-mid]` — Telegram-local message id (`mid`) для текущего storage peer;
- `.bubble[data-peer-id]` — source/storage peer;
- `.bubble[data-timestamp]` — дата как вспомогательная проверка;
- class hints вроде `.photo` — presentation hint, не полный media discriminator;
- у forwarded/saved content может присутствовать `data-saved-from`; это provenance, **не** identity текущего source chat.

Для album отдельные `.grouped-item[data-mid][data-peer-id]` важнее внешней bubble. `grouped_id` в подтверждённом live DOM не экспонировался и не должен вычисляться по layout.

### 3.2 Авторитетная Telegram model

Processed `Message.message` содержит `id`, `mid`, `peer_id`, normalized `peerId`, `date`, `message`, `entities`, `media`, `fwd_from`, `reply_to`, `grouped_id`, `storageKey` и flags, включая `noforwards`. См. [`layer.d.ts#L1035-L1117`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/layer.d.ts#L1035-L1117).

Рекомендуемый identity record:

```ts
interface SourceMessageRef {
  readonly sourcePeerKey: string;
  readonly mid: number;
  readonly groupedId?: string;
  readonly date: number;
  readonly order: number;
}
```

Правила:

- `sourcePeerKey + mid` — минимальный unique key в capture session;
- `groupedId` читается только из message model; DOM может лишь указать, что элемент grouped;
- `source chat` — peer активного chat snapshot плюс совпадение с `data-peer-id`; `savedFrom/fwd_from` не подменяет source peer;
- тип определяется по `message.media._`, а для document — по `document.type` и attributes, не по CSS/icon/text;
- `order` задаётся после разрешения всего snapshot: `mid ASC` внутри одного peer; album children также берутся `mid ASC`;
- DOM element хранится только как ephemeral handle на время capture. В payload нельзя сохранять Telegram-owned node.

`appMessagesManager.getMessagesByGroupedId()` получает mids ascending и возвращает model messages в этом порядке ([`appMessagesManager.ts#L6214-L6221`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/lib/appManagers/appMessagesManager.ts#L6214-L6221)). Это авторитетнее перечисления `.grouped-item`.

### 3.3 Type classification

Первый discriminator — `message._` (`message` vs `messageService`), затем `message.media?._`. Для `messageMediaDocument` Web K вычисляет `document.type` из attributes:

- `documentAttributeAudio` → `audio` либо `voice`;
- `documentAttributeVideo` + `round_message` → `round`, иначе `video`;
- sticker/custom emoji attributes + MIME → `sticker`;
- `documentAttributeAnimated` → `gif`;
- image size → `photo`.

См. [`appDocsManager.ts#L153-L225`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/lib/appManagers/appDocsManager.ts#L153-L225).

`noforwards`, unavailable media, ephemeral/TTL, paid/protected content и missing full model — hard capture failure. Userscript не должен обходить Telegram restrictions или извлекать bytes из одного thumbnail.

## 4. Message support matrix

Общие правила матрицы:

- «Model» означает read-only Telegram message model; наличие type в source code не означает, что обычный userscript стабильно имеет доступ к manager instance.
- «Re-upload» означает получение полного Blob/File и отправку через штатный composer/preview. Thumbnail, canvas snapshot или уже уменьшенное DOM-изображение не эквивалентны source file.
- После Send любые ошибки считаются ambiguous, пока ожидаемый outgoing receipt не подтверждён. Повторный Send запрещён.

| Тип | Исходные данные и источник | Отправка как новое через Web K UI | Семантика / transfer / internal state | Двойная отправка и подтверждение | Verdict |
|---|---|---|---|---|---|
| Plain text | DOM text допустим как fallback; model `message` — источник истины | Contenteditable + native Send | Текст сохраняется; без download. Model не обязателен для plain subset | Один ожидаемый outgoing `mid`; безопасен текущий receipt | **GREEN** |
| Formatted text | Model `message + entities`; DOM разметка неполна | Нативный composer может пересоздать formatting, но стабильного public entity injection нет | Exact entities/overlaps/custom emoji могут измениться; read-only model нужен для capture | Один bubble; correlation по normalized text/entities слабее | **YELLOW** |
| Forwarded source message | Model content + `fwd_from`; DOM banner только hint | Воспроизводится underlying content, `fwd_from` намеренно отбрасывается | Clean semantics сохраняет payload, но не attribution; capability наследуется от underlying type | Как у underlying type; native Forward никогда не вызывается | **GREEN/YELLOW** |
| Reply | Model `reply_to`, `reply_to_mid`, underlying content | Content можно скопировать как новое | Исходную reply-связь в другом peer сохранить нельзя. Теоретически reply на ранее скопированный target требует mapping destination mids и отдельного UI-пути | Content-only подтверждается; semantic reply без mapping — не отправлять | **RED** для reply semantics; underlying content отдельно |
| Photo | `messageMediaPhoto` + full photo/document bytes; DOM URL допустим только после проверки качества | Photo/Video file input → preview → Send | Re-upload; caption отдельно. Spoiler/invert/TTL требуют дополнительных UI capabilities | Один bubble; ожидать media bubble с новым `mid` | **GREEN** для обычной photo/caption; advanced flags YELLOW |
| Album/media group | `grouped_id` + `getMessagesByGroupedId`; каждая item media/caption | Multiple files → `PopupNewMedia`, `group=true`, один confirm | Re-upload всех bytes. Album atomic; order `mid ASC`; captions/spoilers/type partition надо валидировать | Один click может создать 2–10 outgoing mids; нужен composite receipt с одним новым group | **YELLOW** |
| Video | `messageMediaDocument`, `document.type=video`, full bytes/name/MIME/dimensions | Photo/Video input → preview | Re-upload; codec/conversion/streaming attributes могут измениться | Один bubble, но upload может быть долгим; pending bubble не равен success | **YELLOW** |
| GIF/animation | document `type=gif`, animated attribute, full GIF/MP4 | Photo/Video input | Re-upload; Telegram может нормализовать/перекодировать. GIF ломает media grouping и отправляется отдельно | Один bubble на item; type/class и new `mid` проверяются | **YELLOW** |
| Generic document | `messageMediaDocument`, full bytes, `file_name`, MIME, size | Document input → file preview | Re-upload; полное имя/MIME нужно сохранить. DOM download label/thumbnail недостаточны | Один document bubble; сверять name/size hint + new `mid` | **YELLOW** |
| Audio/music | document `type=audio`, audio attributes + full bytes | Document input; Web K сам классифицирует supported MIME | Re-upload; title/performer/duration могут быть заново выведены и измениться | Один audio/document bubble; new `mid`, type hint | **YELLOW** |
| Voice message | document `type=voice`, OGG, waveform/duration | Штатный UI создаёт voice только через recorder | Загрузка OGG через Document не гарантирует `voice` semantics; exact path требует private `isVoiceMessage` | Bubble можно подтвердить только если voice composer path существовал; повтор опасен | **RED** exact; можно предложить explicit «как файл» |
| Video note | document `type=round`, round flag | Штатный UI создаёт через camera recorder | Upload MP4 не гарантирует `round_message`; private `isRoundMessage` не использовать | Аналогично voice | **RED** exact; можно отправить как обычное video с потерей semantics |
| Sticker | document sticker attributes + Telegram document object | Sticker picker вызывает internal document send | Re-upload WEBP как file/media не создаёт sticker. Нельзя детерминированно найти тот же sticker в installed/recent picker | Один bubble возможен, но selection by visual DOM хрупок и может выбрать другой sticker | **RED** general; YELLOW только для явно найденного exact sticker id при доказанном UI bridge |
| Animated sticker | TGS/WEBM document + sticker attributes | Sticker picker | File upload не сохраняет sticker semantics; playback format может измениться | Как sticker | **RED** |
| Contact | `messageMediaContact`: phone/name/vcard/user_id | В общем attach menu нет Contact; Share Contact существует из user profile и шлёт известного peer contact | Arbitrary vCard/messageMediaContact через UI не реконструируется; private `sendContact` запрещён | Один bubble, если бы был UI path | **RED** exact; vCard document/text — другая семантика |
| Location | `messageMediaGeo`, coordinates | В текущем generic ChatInput нет location composer | Map URL/text — не Telegram location; internal/inline bot paths не являются generic UI | Один bubble только при недоступном generic path | **RED** |
| Venue | `messageMediaVenue`: geo/title/address/provider/venue ids | Generic venue composer не найден | Text/map link теряет venue semantics | Аналогично location | **RED** |
| Poll | `messageMediaPoll` model: question/options/settings/results | Attach → Poll → native poll popup | Можно создать **новый** poll template. Голоса, voter identity, closed state и original poll id не сохраняются | Один poll bubble; new `mid`; submit — необратимая boundary | **YELLOW** |
| Quiz | Poll model + quiz flag; correct answer/explanation могут зависеть от доступных results | Native Poll popup в quiz mode | Новый quiz возможен только если capture содержит правильный answer/explanation; результаты не копируются | Один bubble; fail closed при missing answer | **YELLOW** |
| Text with link preview | Text/entities + `messageMediaWebPage`, URL | Вставить text и дать Telegram сгенерировать preview | Preview регенерируется: page могла измениться; exact media/layout/invert flags не гарантированы | Один bubble; проверять text/new `mid`, не exact preview | **YELLOW** |
| Multiple arbitrary selected messages | Полный ordered selected-set + model каждого mid | Последовательность type-specific native UI units | Только intersection поддержанных capabilities; albums atomic. Unsupported item должен остановить capture целиком, если пользователь явно не выбрал partial policy | Receipt per unit; после ambiguous unit весь recipient останавливается, последующие не отправляются | **YELLOW**, не «любые сообщения» |

Дополнительно **RED/out of scope** до отдельного доказательства: service messages, games, invoices/payments, paid media, stories, giveaways, dice, live location, bot keyboards/inline results, protected/ephemeral media, scheduled/suggested posts, effects and reactions. Их нельзя молча превращать в текстовый screenshot.

### Native composition paths, подтверждённые исходниками

| Payload | Native UI path | Существенные детали |
|---|---|---|
| Multiple photo/video | Attach → Photo or Video → один `input[type=file][multiple]` → `PopupNewMedia` | input получает media MIME `accept`; `change` читает `FileList` и открывает/дополняет preview ([`input.ts#L1307-L1322`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/input.ts#L1307-L1322), [`input.ts#L1484-L1511`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/input.ts#L1484-L1511)) |
| Album | То же, `PopupNewMedia.willAttach.group=true` по умолчанию | UI имеет Group/Ungroup; `iterate` делит совместимые группы максимум по 10, разделяет audio и compress/non-compress, GIF отправляет отдельно ([`newMedia.ts#L235-L306`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/popups/newMedia.ts#L235-L306), [`newMedia.ts#L1956-L1990`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/popups/newMedia.ts#L1956-L1990)) |
| Document/audio | Attach → Document → тот же file input без `accept` → preview | `willAttachType='document'`; multiple files разрешены. Audio grouping отделяется по MIME |
| Video/GIF | Photo/Video input | Preview может конвертировать unsupported video; GIF препятствует обычному group album |
| Voice | Record button/microphone | Recorder создаёт OGG и вызывает private send path с `isVoiceMessage:true` ([`chatRecording.ts#L224-L249`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/recording/chatRecording.ts#L224-L249)) |
| Video note | Record-video/camera mode | Recorder передаёт `isRoundMessage:true` ([`chatRecording.ts#L286-L328`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/recording/chatRecording.ts#L286-L328)) |
| Sticker | Emoji/sticker picker → `sendMessageWithDocument` | Работает с Telegram `MyDocument`, а не с произвольным re-uploaded File ([`input.ts#L4511-L4580`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/input.ts#L4511-L4580)) |
| Poll/quiz | Attach → Poll → `openCreatePollPopup` | Submit передаёт structured payload в poll manager ([`input.ts#L1117-L1177`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/input.ts#L1117-L1177)) |
| Contact | Profile/topbar → Share Contact | Это не generic attach arbitrary contact; внутри используется sharing picker и internal `sendContact` ([`topbar.ts#L619-L646`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/topbar.ts#L619-L646)) |
| Location/venue | Generic attach flow не найден | Source содержит rendering и inline-bot geo paths, но не общий composer для реконструкции arbitrary source location |

Фактическая отправка multiple media в `PopupNewMedia.send()` идёт через private `appMessagesManager.sendGrouped` ([`newMedia.ts#L1034-L1081`](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/popups/newMedia.ts#L1034-L1081)). Clean Forward не должен вызывать этот manager напрямую; безопасная граница — управлять тем же native file input/preview и нажать native confirm ровно один раз.

## 5. Album/group semantics

Album — не один Blob и не просто несколько соседних bubbles. Это atomic source unit:

```text
grouped_id
  -> ordered source messages (mid ASC)
  -> one or more compatible upload groups (max 10 each)
  -> one native preview confirmation per produced group
  -> N outgoing mids per group
```

Правила будущей реализации:

1. Если выбран один item album, product policy должна быть явной: либо copy only selected item, либо expand full album. Native Telegram selection умеет оба случая; скрытое expansion недопустимо.
2. Для «copy album» capture обязательно разрешает полный `grouped_id` через model storage. Только видимых DOM items недостаточно.
3. Сохраняются item order, MIME/filename и caption ownership. Нельзя объединять captions в один текст без проверки Telegram rules.
4. Если source group содержит несовместимые типы, native `PopupNewMedia.iterate` может разбить её на несколько sends. Capture должен заранее вычислить expected groups либо отказаться; нельзя ожидать один album bubble вслепую.
5. GIF/animation не входит в обычный grouped media send; аудио и media/document partitions могут образовать разные groups.
6. Confirmation должна получить полный новый набор mids. Успех: ровно ожидаемое число новых outgoing records, все вышли из pending/error state и, для настоящего album, принадлежат одному новому grouped container/model id. «Появился хотя бы один bubble» — недостаточно.
7. После частичного album result статус recipient/unit — `unknown`; повтор всего album запрещён из-за риска дублей.

## 6. Proposed generalized payload model

Нужны две модели: неизменяемый source snapshot и воспроизводимый payload. Telegram model object и DOM node нельзя переносить в delivery напрямую.

```ts
interface SourceChatRef {
  readonly peerKey: string;
  readonly title: string;
}

interface SourceMessageRef {
  readonly sourcePeerKey: string;
  readonly mid: number;
  readonly groupedId?: string;
  readonly date: number;
  readonly order: number;
}

interface CapturedMessageBatch {
  readonly operationId: string;
  readonly source: SourceChatRef;
  readonly refs: readonly SourceMessageRef[];
  readonly units: readonly ReproductionUnit[];
}

type ReproductionUnit =
  | { readonly kind: "text"; readonly source: readonly SourceMessageRef[];
      readonly text: string; readonly entities?: readonly CapturedEntity[];
      readonly linkPreview: "regenerate" | "disable" }
  | { readonly kind: "media-group"; readonly source: readonly SourceMessageRef[];
      readonly items: readonly UploadItem[]; readonly expectedGroups: readonly ExpectedGroup[] }
  | { readonly kind: "file"; readonly source: readonly SourceMessageRef[];
      readonly role: "photo" | "video" | "animation" | "document" | "audio";
      readonly item: UploadItem; readonly caption?: string }
  | { readonly kind: "poll-template"; readonly source: readonly SourceMessageRef[];
      readonly poll: CapturedPollTemplate };

interface UploadItem {
  readonly blob: Blob;
  readonly fileName: string;
  readonly mimeType: string;
  readonly order: number;
  readonly caption?: string;
}
```

Не добавлять `voice`, `round`, `sticker`, `contact`, `geo` в union как будто они поддержаны. Для них classifier возвращает structured `UnsupportedCaptureReason` до открытия recipient picker.

Каждый unit обязан объявлять:

- `prepareCapability` — конкретный native UI adapter;
- `sendClickCount` — обычно 1;
- `expectedOutgoingCount` или composite matcher;
- `atomicity` — `single`, `album`, `sequence`;
- `contentFingerprint` только для корреляции, не как identity;
- пределы размера/таймауты загрузки bytes.

Future delivery ledger должен быть вложенным: `recipient -> unit -> attempt/status`. Duplicate key: `(operationId, recipientPeerKey, unitIndex, preSendAttempt)`. После `send-clicked` attempt больше не увеличивается.

## 7. Proposed capture flow

```text
snapshot source chat
  -> snapshot selected identities
  -> validate count/peer/order
  -> resolve read-only message models
  -> classify every message
  -> expand/normalize grouped units
  -> load required full bytes with timeout/AbortSignal
  -> validate complete immutable batch
  -> close native selection
  -> open existing recipient picker
```

Подробно:

1. Снять `sourcePeerKey` до любых popup/search rerenders.
2. Для single context menu сразу прочитать `(data-peer-id, data-mid)` из connected bubble/grouped item.
3. Для multi-selection получить snapshot из verified bridge. DOM fallback разрешён только при `uniqueVisibleCount === toolbarCount`; иначе показать unsupported/technical error и ничего не готовить.
4. Проверить, что IDs относятся к ожидаемому source context; нормализовать `mid ASC`.
5. Разрешить каждый `SourceMessageRef` в read-only model. Не сохранять ссылку на mutable manager object: скопировать только нужные scalar metadata/entities.
6. Классифицировать по `message.media._` и `document.type/attributes`. Проверить `noforwards`, TTL/protected/unavailable media и destination-independent restrictions.
7. Для `grouped_id` получить полный ordered group. Сопоставить selected item policy и не дублировать одну group unit при выборе нескольких её items.
8. Скачать только full bytes, с `AbortSignal`, timeout, size limit и MIME/filename validation. Не использовать thumbnail как fallback.
9. Если любой selected item unsupported, по умолчанию fail closed для всей capture. Partial copy допустим лишь как отдельная будущая UX-функция с явным списком исключённых items.
10. Заморозить `CapturedMessageBatch`; только после этого закрыть native selection и открыть существующий recipient picker.

Internal bridge criteria:

- read-only;
- версия/shape contract проверяются при startup;
- snapshot возвращает plain scalars, не manager references;
- никакие `sendText/sendFile/sendGrouped/forwardMessages` не экспортируются;
- при contract mismatch adapter сообщает `unavailable`, DOM fallback не расширяет поддержку молча.

## 8. Proposed delivery flow

Внешний recipient pipeline остаётся тем же. Внутри каждого recipient добавляется ordered unit loop:

```text
recipient
  -> navigate + validate peer
  -> acquire composer
  -> preserve destination draft
  -> for each unit in source order:
       validate same peer/composer
       prepare through type-specific native UI
       validate preview and expected send semantics
       native Send/Confirm click exactly once
       confirm complete outgoing receipt
       stop fail-closed on unknown
  -> restore destination draft
  -> next recipient
finally -> restore source chat
```

Type adapters:

- `TextCompositionAdapter` — text/plain subset first; entities behind separate capability.
- `MediaUploadAdapter` — photo/video/animation; uses media file input and preview readiness.
- `DocumentUploadAdapter` — document/audio; uses document mode and verifies preview type.
- `AlbumUploadAdapter` — multiple files, grouping state, item order and composite receipt.
- `PollCompositionAdapter` — later stage; fills native popup and validates all fields before submit.

Safety rules:

1. Draft transaction начинается после peer validation и покрывает все units одного recipient. Restore выполняется в `finally`, даже после unknown/cancel.
2. Перед каждым unit снова проверяются active peer, composer ownership и отсутствие reply/forward/edit draft.
3. Retry bounded только для navigation/acquire/prepare/readiness, пока native send control не был нажат.
4. Send click фиксируется до dispatch события. После него cancel ждёт confirmation boundary; повтор запрещён.
5. Confirmation — не просто CSS bubble. Нужны новые `data-mid`, outgoing direction и terminal/non-pending state. Для album — весь expected set.
6. Следующий unit не начинается, пока предыдущий не подтверждён.
7. При unknown последующие units этого и следующих recipients не отправляются. Уже подтверждённые units не повторяются.
8. Перед переходом к следующему recipient preview/composer должны быть clean. Cleanup не удаляет пользовательский draft, появившийся после начала transaction; ownership остаётся exact-value/version based.

Отправка arbitrary batch «без визуального перехода» не рекомендуется: текущие безопасные guarantees завязаны на native visible composer и подтверждение DOM bubble. Private manager calls обошли бы peer/composer/draft guards и сделали delivery зависимым от внутренних API.

## 9. Risks and fragile points

### High risk

- Native selected-set module-private; DOM selection неполон при virtualization.
- Telegram Web K не имеет стабильного public message-model API для userscript.
- Media URLs могут быть thumbnail/object URL, истечь или требовать Telegram download manager.
- Album один click → несколько messages; частичное подтверждение создаёт нерешаемый duplicate risk.
- Voice/video note/sticker type зависит от document attributes/private send options, не только MIME.
- Exact reply, poll results, forward attribution, reactions и webpage object нельзя перенести как «новое» сообщение через общий UI.
- Telegram rights/slow mode/paid-message dialogs могут появиться между prepare и Send; adapters обязаны fail closed.

### Medium risk

- CSS classes и toolbar layout меняются между Web K builds.
- `data-mid` может появиться после optimistic bubble render; observer должен отслеживать attribute mutation.
- Formatted text entities use UTF-16 offsets and Telegram-specific entity overlap/custom emoji rules.
- Native media preview может автоматически конвертировать, split или reorder incompatible inputs.
- PWA и обычная вкладка используют тот же Web K, но focus/file-dialog lifecycle отличается; state readiness нельзя заменять одним `requestAnimationFrame`/timeout.
- Большие downloads/uploads требуют раздельных bounded timeouts и progress; upload timeout до Send безопасен, timeout после Send — ambiguous.

### Stable vs heuristic selectors

Относительно устойчивы, потому что одновременно используются как identity/state:

- `.bubble[data-mid][data-peer-id]`;
- `.grouped-item[data-mid][data-peer-id]`;
- `.bubbles.is-selecting`;
- `.selection-container`, `.selection-container-count`, `.selection-container-forward`;
- active composer/file input только после peer-scoped container validation.

Эвристики:

- checkbox `id="input-{mid}"`;
- CSS media classes (`photo`, `document`, icon classes) как type source;
- DOM order;
- displayed selection count parsing/locale;
- `data-saved-from` как source identity;
- наличие thumbnail или object URL как доказательство full file;
- исчезновение preview, Send button click или один новый bubble как доказательство полного album success.

## 10. Concrete staged implementation plan

### Stage 0 — contracts and tests only

- Ввести отдельно `SourceMessageRef`, classifier result, `CapturedMessageBatch` и `ReproductionUnit` без подключения новых delivery paths.
- Зафиксировать fail-closed capability table и fixture-based model classifier tests.
- Добавить tests на stable ordering, duplicate `(peer,mid)`, mixed peer rejection, unsupported whole-batch rejection и album de-duplication.

### Stage 1 — identity capture, single message

- Заменить «DOM element = source» на immutable `(sourcePeerKey, mid)` snapshot.
- Сохранить текущий text/photo extractor как fallback capability.
- Добавить read-only model adapter contract с runtime shape/version check, но без send methods.
- Не включать native multi-selection до доказанного complete selected-set snapshot.

### Stage 2 — single generic document and video

- Самый безопасный новый end-to-end slice: один generic document **или** один обычный video.
- Получать full Blob/File, имя и MIME; использовать существующий native file-input/preview pipeline.
- Расширить outgoing matcher для соответствующего одного bubble, сохранив текущую post-Send fail-closed semantics.
- Voice/round/sticker formats явно отвергать, а не классифицировать по extension как поддержанные.

### Stage 3 — source multi-selection for GREEN units

- Добавить Clean Forward action в native selection toolbar только вместе с verified snapshot adapter либо строгим visible-count fallback.
- Сначала поддержать последовательность plain text + one photo/document/video units.
- Nested delivery ledger, unit-level receipt, no post-Send retry; все текущие recipient/draft/source restoration tests должны оставаться зелёными.

### Stage 4 — albums

- Internal `grouped_id` expansion, selected-item policy, multiple file preview order/group readiness.
- Composite outgoing receipt и tests на partial/late/extra bubbles.
- Fail closed при split, если expected native grouping нельзя определить до Send.

### Stage 5 — richer semantics

- Formatted entities/link-preview regeneration за отдельным capability flag.
- Poll/quiz template recreation через native popup, без результатов/identity.
- Не включать voice/video note/sticker/contact/location/venue до появления доказанного deterministic native UI adapter.

### Required regression coverage for every stage

- existing multi-recipient sequence;
- draft restore on success, pre-Send failure, cancel, exception and unknown;
- source-chat restoration after full/partial batch;
- bounded pre-Send retries only;
- no duplicate Send after late receipt;
- ambiguous unit stops remaining units/recipients;
- cleanup removes owned preview only;
- album partial receipt is unknown, never retryable;
- virtualized selection count mismatch rejects capture.

## Verdict

Реально поддержать безопасно: plain text; обычные photos; затем обычные video, GIF и generic documents/audio через download/re-upload; ограниченные formatted text/link previews; albums после composite confirmation; новые poll/quiz templates без результатов. Группы произвольных сообщений поддерживаются только как ordered batch из этих capability-approved units.

Нельзя обещать «любое сообщение». Exact reply semantics, voice messages, video notes, stickers/animated stickers, arbitrary contacts, locations/venues, poll results, protected/ephemeral/paid/service content не имеют подтверждённого безопасного generic UI reconstruction path.

Самый безопасный следующий implementation slice: **immutable source identity + classifier foundation, затем один generic document или обычный video через уже проверяемый native file-input/preview pipeline**. Native multi-selection и albums следует подключать позже, только после complete selected-set snapshot и composite outgoing confirmation.

## Implementation status (2026-08-12)

Статус ниже разделяет три разные вещи: построение immutable payload, получение данных из production Web K и фактическую delivery через native UI. Наличие capture adapter само по себе не означает пользовательскую end-to-end поддержку. В текущем userscript нет version-pinned read-only model bridge, поэтому model-backed YELLOW adapters доступны как проверяемая граница/контракт, но не получают внутренние Telegram models в production.

| Type | Capture source | Generalized payload | Фактический статус | Ограничения |
|---|---|---|---|---|
| Plain text | Строгий DOM fallback; verified model snapshot | `text / plain-text` | **Implemented end-to-end** | DOM не используется для восстановления entities |
| Formatted text | Только verified model `message + entities` | `text / formatted-text` | **Capture adapter implemented; production acquisition/delivery not implemented** | Невалидные UTF-16 ranges/metadata отклоняются; plain composer не получает formatted payload |
| Link preview | Verified model policy `regenerate/disable` | text preview policy | **Capture contract implemented; exact preview not implemented** | Допускается только regeneration policy; исходный webpage object/layout не копируется |
| Forwarded content | Underlying supported model content | Unit underlying type | **Capture behavior implemented at contract level** | `fwd_from` всегда отбрасывается; доступность равна underlying type |
| Reply | Underlying supported model content | Unit underlying type | **Content-only capture implemented at contract level; reply semantics unsupported** | `reply_to` не переносится; explicit request сохранить relation — RED |
| Ordinary photo + plain caption | `img.media-photo` DOM fallback либо verified full-byte model | `file / photo` | **Existing end-to-end scenario preserved** | DOM album ambiguity, spoiler, invert-media, TTL/protected/paid отклоняются |
| Photo + formatted caption | Только verified model bytes + caption entities | `file / photo` + entity-aware caption | **Capture adapter implemented; delivery not implemented** | Старый photo pipeline получает только plain caption |
| Album (photo/video) | Только полный verified `grouped_id`, 2–10 full-byte items | `media-group` | **Capture adapter implemented; production acquisition/delivery not implemented** | DOM group rejected; incomplete/mixed/inconsistent group rejected; нужен composite outgoing receipt |
| Video | Verified model discriminator + full bytes/name/MIME/dimensions/duration | `file / video` | **Capture adapter implemented; production acquisition/delivery not implemented** | Spoiler/invert rejected; native preview/upload receipt ещё не подключены |
| GIF/animation | Verified model discriminator + full GIF/MP4 bytes and metadata | `file / animation` | **Capture adapter implemented; production acquisition/delivery not implemented** | Telegram transcoding не обещается; animation в album rejected |
| Generic document | Verified model discriminator + full bytes/name/MIME/size | `file / document` | **Capture adapter implemented; production acquisition/delivery not implemented** | Thumbnail/label DOM не принимаются за файл |
| Audio/music | Verified model discriminator + full bytes and audio attributes | `file / audio` | **Capture adapter implemented; production acquisition/delivery not implemented** | Voice discriminator rejected; native document/audio receipt ещё не подключён |
| Poll | Verified result-free poll template | `poll-template / poll` | **Capture adapter implemented; production acquisition/delivery not implemented** | Results, voters, closed state и original id отсутствуют по конструкции |
| Quiz | Verified template + correct option (+ optional explanation) | `poll-template / quiz` | **Capture adapter implemented; production acquisition/delivery not implemented** | Missing correct answer отклоняется до recipient picker |
| Voice, video note, sticker/animated sticker | Explicit model discriminator | `unsupported-source` | **Not implemented (RED)** | Нельзя менять семантику загрузкой «как файл/video» без отдельного opt-in продукта |
| Contact, location/venue | Explicit model discriminator | `unsupported-source` | **Not implemented (RED)** | Generic deterministic native composer path не подтверждён |
| Service, game, invoice, story, giveaway, dice и unknown | Explicit model discriminator | `unsupported-source` | **Not implemented (RED)** | Unknown model/markup всегда fail closed |
| Protected, ephemeral, paid или unavailable media | Verified restriction flags | `unsupported-source` | **Explicitly rejected** | Bytes не попадают в reusable transfer bundle |

Type-specific capture реализован стратегиями `TextSourceCaptureAdapter`, `BinaryMediaSourceCaptureAdapter`, `MediaGroupSourceCaptureAdapter` и `PollSourceCaptureAdapter`. `SourceCaptureService` сначала валидирует весь selected set, ограничения и group boundaries и только затем публикует один immutable bundle. Любая ошибка member-а отменяет capture целиком.
