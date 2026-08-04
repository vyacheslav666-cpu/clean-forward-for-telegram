# Telegram Web K: исследование штатного recipient picker и контекстного меню

Дата проверки: 2026-08-04. Интерфейс: авторизованный Telegram Web K в Chrome. Рабочий проект: `Clean Forward for Telegram` 0.1.0.

Проверка исходного кода относится к `morethanwords/tweb` commit [`e52b5d9318848ab83316cb53138358cf49d2a27f`](https://github.com/morethanwords/tweb/commit/e52b5d9318848ab83316cb53138358cf49d2a27f). DOM и основные переходы дополнительно проверены в живой сессии.

## Важное замечание о безопасности исследования

В живом эксперименте была выбрана строка `Saved Messages`, но кнопка Send и горячая клавиша подтверждения не нажимались. Оказалось, что для одного получателя `Saved Messages` и пустого текста в picker сам клик по строке является подтверждением: Telegram не создаёт промежуточный draft, а сразу вызывает `ChatInput.sendMessageWithForward(...)`. Поэтому одна тестовая пересылка в Saved Messages, вероятно, была реально выполнена.

Это подтверждено исходным кодом, но не сетевым захватом: сетевой payload не просматривался, чтобы не раскрывать приватные данные. Сообщение намеренно не удалялось, поскольку удаление пользовательских данных не входило в разрешённые действия. Все popup закрыты, активного forward draft нет, текущий composer пуст. Следовательно, нельзя честно подтвердить требование «ничего не отправлено»; подтверждается только отсутствие оставленного popup/draft/composer content.

## Краткий вывод

Штатный Forward открывает `.popup.popup-forward.active` с заголовком `Share with`. Строки чатов имеют `data-peer-id`; полный выбранный элемент внутри Telegram хранится в приватном массиве как `{ peerId, threadId?, monoforumThreadId?, key }`. Picker поддерживает мультивыбор, но открывается в режиме `multiSelect: "hidden"`: обычный клик по строке немедленно завершает одиночный выбор, а режим нескольких получателей включается через контекстное действие `Select` на строке.

Переиспользовать уже запущенный штатный Forward picker через DOM небезопасно. После одиночного выбора нет надёжного промежутка, в котором выбранный peer уже доступен, а штатный callback ещё не начал forward. Для Saved Messages отправка начинается прямо из обработчика выбора; для нескольких получателей — из кнопки подтверждения; для одного обычного чата Telegram сначала открывает его и создаёт forward draft.

Внутри самого приложения безопасный вариант существует: вызвать `showPickUserPopup`, `showSharingPickerPopup` или `showForwardPopup(undefined, ownOnSelect)` со своим callback, то есть без `peerIdMids`. Но эти функции являются импортами модулей Telegram и в проверенной странице не опубликованы в `window`. Для отдельного Tampermonkey userscript они не являются доступным API.

Рекомендация для текущей архитектуры — вариант B: собственный picker с собственным состоянием и явным подтверждением, использующий `data-peer-id` уже загруженных диалогов и/или безопасную навигацию через существующие строки Telegram. На первом этапе следует поддержать одного получателя и подготовку нового сообщения с ручным Send. Мультивыбор и фоновая отправка требуют отдельного исследования внутреннего API отправки и существенно увеличивают риск.

## 1. Исправление переполнения контекстного меню

### Живой DOM до исправления

Активное меню сообщения имело структуру:

```html
<div
  id="bubble-contextmenu"
  class="btn-menu contextmenu has-items-wrapper bottom-right active was-open"
  style="min-width: 194px; left: 828px; top: 304px;"
>
  <div class="btn-menu-items btn-menu-transition">
    ...
    <div class="btn-menu-item rp-overflow">
      <span class="tgico btn-menu-item-icon">...</span>
      <span class="i18n btn-menu-item-text">Forward</span>
    </div>
    <div class="btn-menu-item rp-overflow">Select</div>
    <div class="btn-menu-item rp-overflow danger">Delete</div>
    <div data-clean-forward-context-action><!-- old Shadow Root --></div>
  </div>
</div>
```

При viewport 1280×609 меню имело `top = 304`, `height = 309`, `bottom = 613`, то есть выходило вниз на 4 px. Причина диагностически подтверждена: Telegram вычислил позицию по нативной высоте, после чего MutationObserver проекта поздно добавил отдельный Shadow DOM host последней строкой.

### Выполненное минимальное исправление

`ContextMenuIntegration` теперь создаёт обычный нативоподобный элемент непосредственно внутри `.btn-menu-items`:

```html
<div class="btn-menu-item rp-overflow" data-clean-forward-context-action>
  <span class="tgico btn-menu-item-icon">...</span>
  <span class="btn-menu-item-text">Отправить как новое</span>
</div>
```

Shadow DOM и отдельные стили удалены. Элемент вставляется сразу после найденного нативного `Forward`; fallback — непосредственно перед первым `.btn-menu-item.danger`, затем append как последний резервный вариант. Обработчики остаются на самом `.btn-menu-item`, включая раннюю активацию на primary `pointerdown` и `click` как keyboard fallback.

Изменение ограничено `src/ui/ContextMenuIntegration.ts`; `npm run build` прошёл успешно.

### Почему Telegram сам не пересчитывает положение

В `contextMenu.ts` Telegram сначала добавляет собственные пункты и один раз вызывает `positionMenu(...)`, после чего открывает menu controller: [`contextMenu.ts`](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/contextMenu.ts). `positionMenu` измеряет `.btn-menu-items`, учитывает отступ 8 px и выставляет `left/top`: [`positionMenu.ts`](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/helpers/positionMenu.ts). Публичного DOM-события «reposition» нет; `resize` не является подтверждённым контрактом.

После поздней вставки проект поэтому повторяет только вертикальный clamp:

1. ждёт два `requestAnimationFrame`, чтобы новый пункт попал в layout;
2. измеряет ближайший `.btn-menu.contextmenu.active`;
3. вычисляет overflow относительно диапазона `8 .. innerHeight - 8`;
4. корректирует существующий inline `style.top`;
5. ничего не делает, если menu уже закрыто или `top` не является числом.

Это не вызывает приватную функцию Telegram и не меняет горизонтальную геометрию. При повторном открытии переиспользуемого DOM Telegram уже видит существующий пункт во время собственного измерения.

### Устойчивость решения меню

Относительно устойчивые признаки:

- активный контейнер `.btn-menu.contextmenu.active`;
- непосредственный список `.btn-menu-items`;
- нативная структура `.btn-menu-item.rp-overflow` + `.btn-menu-item-icon` + `.btn-menu-item-text`;
- `.danger` как fallback для размещения перед Delete;
- собственный marker `data-clean-forward-context-action` для дедупликации.

Эвристики:

- текст `Forward` зависит от языка интерфейса;
- glyph иконочного шрифта `` может измениться;
- порядок пунктов и класс `.danger` не являются публичным API;
- Telegram может заменить `div` или CSS-классы при обновлении.

Для будущего усиления следует вынести поиск Forward в TelegramDomAdapter, учитывать локализованные подписи и проверять структуру/соседние нативные пункты. Клонировать весь native item нельзя без очистки его listeners и внутренних ссылок; безопаснее создавать новый элемент с текущей подтверждённой структурой.

## 2. Что открывает штатный Forward

Контекстный обработчик `onForwardClick` собирает исходные `peerId/mid` и вызывает:

```ts
showForwardPopup({
  [peerId]: mids,
});
```

Источник: [`contextMenu.ts` L2023-L2032](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/contextMenu.ts#L2023-L2032).

`showForwardPopup` вычисляет права, подходящие для исходного содержимого (`send_plain`, `send_photos` и т. п.), затем вызывает `showPickUserPopup(...)`: [`forward.tsx` L93-L118](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L93-L118), [`forward.tsx` L360-L376](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L360-L376).

Подтверждённый корень popup:

```css
.popup.popup-forward.active
```

Внутри:

```text
.popup-container
├─ .popup-header
│  ├─ button.btn-icon.popup-close
│  └─ .popup-title                 # “Share with”
├─ .popup-body
│  └─ .tabs-container
│     └─ .selector.selector-round.selector-right.selector-multiselect-hidden
│        ├─ .selector-search-container
│        │  └─ input.selector-search-input[type="text"]
│        ├─ .popup-forward-top-peers
│        │  └─ ul.chatlist > a.row.chatlist-chat[data-peer-id]
│        ├─ .popup-forward-folder-tabs-container
│        └─ .selector-list-section-container
│           └─ ul.chatlist > a.row.chatlist-chat[data-peer-id]
└─ .popup-footer.popup-forward-footer
   └─ .simple-message-input-container
      └─ button.simple-message-input-confirm.btn-primary
```

Top peers и основной список могут содержать один и тот же peer. В проверенном DOM было 16 строк и 15 уникальных peer ID. Ссылочного `href` у строк внутри popup не было.

## 3. Представление peer и состояния выбора

### DOM

Для обычного диалога наиболее полезный атрибут:

```html
<a class="row ... chatlist-chat ..." data-peer-id="..."></a>
```

Тот же ID может повторяться на вложенных avatar/title. Источником следует считать ближайший `a.row.chatlist-chat[data-peer-id]`, а не произвольного потомка.

В режиме с checkbox строка содержит:

```html
<label class="checkbox-field ...">
  <input class="checkbox-field-input" type="checkbox">
</label>
```

`input.checked` отражает DOM-состояние, но не является источником истины Telegram.

Для forum/topic `data-peer-id` может быть составным ключом `peerId_threadId`. Простое `Number(dataset.peerId)` потеряет thread context.

### Внутреннее состояние

`showPickUserPopup` хранит приватный массив:

```ts
type PopupPickUserSelectedItem = {
  peerId: PeerId;
  threadId?: number;
  monoforumThreadId?: PeerId;
  key: string;
};

const selected: PopupPickUserSelectedItem[] = [];
```

`AppSelectPeers` отдельно хранит `selected` как Set ключей и предоставляет внутренний `getSelected()`. Forward копирует выбранные peer IDs в Solid store `starsState.store.selectedPeers`, но этот store также не отражается в публичном DOM и не опубликован в `window`: [`pickUser.tsx` L115-L176](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/pickUser.tsx#L115-L176), [`forward.tsx` L360-L370](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L360-L370).

В live page проверено, что `window.rootScope`, `window.appImManager`, `window.showPickUserPopup` и `window.appMessagesManager` отсутствуют.

## 4. События и state machine выбора

`AppSelectPeers` использует собственный `attachClickEvent` на контейнере. Обработчик:

1. находит ближайший `data-peer-id`;
2. принимает только `.row` или специальную `.btn-primary`;
3. вызывает `cancelEvent(e)`;
4. вычисляет `adding = !selected.has(key)`;
5. вызывает внутренний `onSelect` для forum/topic проверки;
6. вызывает `add({key})` или `remove(key)`;
7. обновляет checkbox.

Источник: [`appSelectPeers.ts` L411-L454](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/appSelectPeers.ts#L411-L454).

В Forward picker передаётся `multiSelect: "hidden"`. При добавлении первого peer `onSingleSelect` добавляет объект в приватный `selected` и немедленно вызывает `finalize()`, если режим не равен `enabled`: [`pickUser.tsx` L157-L181](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/pickUser.tsx#L157-L181).

Внешних `input`, `change` или `beforeinput` событий выбора peer не требуется и не наблюдалось. Значимые переходы происходят через click abstraction и внутренние callbacks `onSelect`/`onChange`/`finalize`. Поле дополнительного текста в footer использует собственный input-компонент; Enter связан с `btnConfirmOnEnter`, поэтому Enter является ещё одним потенциальным путём подтверждения и не подходит для безопасного DOM-перехвата.

## 5. Одиночный и множественный выбор

### Одиночный выбор по умолчанию

Класс `.selector-multiselect-hidden` означает не запрет multi-select, а скрытый multi-select. Обычный клик по строке сразу завершает выбор.

После `finalize()` Forward вычисляет:

```ts
const isSavedMessagesNoText =
  chosen.length === 1 &&
  chosen[0].peerId === rootScope.myId &&
  !messageLength;

const openChat =
  chosen.length === 1 &&
  !finalizingThroughButton &&
  !isSavedMessagesNoText;
```

Источник: [`forward.tsx` L308-L323](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L308-L323).

- Один обычный peer, выбор строкой: `openChat = true`; Telegram вызывает `appImManager.setInnerPeer(...)`, затем `chat.input.initMessagesForward(peerIdMids)`. Реальная отправка ещё не началась, но уже создан forward draft в новом чате.
- Один `Saved Messages`, пустой footer: `openChat = false`; Telegram сразу вызывает `ChatInput.sendMessageWithForward(...)`.
- Один peer, подтверждение footer-кнопкой или Enter: `finalizingThroughButton = true`, поэтому `openChat = false` и начинается отправка.

### Множественный выбор

При `multiSelect: "hidden"` Telegram добавляет контекстное меню строки с действиями `Select`/`Deselect`. `Select` переводит selector в `enabled` и симулирует клик по выбранной строке: [`appSelectPeers.ts` L456-L487](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/appSelectPeers.ts#L456-L487).

В режиме `enabled`:

- checkbox видимы;
- клики добавляют/удаляют peer из Set и массива `selected`;
- picker остаётся открыт;
- footer confirm вызывает `finalizingThroughButton = true; handle.finalize()`;
- `processSingle(..., openChat = false)` выполняется для каждого выбранного получателя, то есть настоящая пересылка начинается прямо из подтверждения.

Таким образом, штатный picker действительно поддерживает несколько получателей, включая общий подтверждающий шаг, но не создаёт отдельный безопасный draft для каждого.

## 6. Момент реальной пересылки и безопасная отмена

Внутри `processSingle` есть развилка:

```ts
if (openChat) {
  await appImManager.setInnerPeer(...);
  appImManager.chat.input.initMessagesForward(peerIdMids);
} else {
  await ChatInput.sendMessageWithForward(...);
}
```

Источник: [`forward.tsx` L186-L227](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L186-L227).

Безопасные точки отмены:

1. До любого выбора — `.popup-forward .popup-close` или Escape. Это надёжно и не создаёт draft.
2. В уже включённом multi-select — закрыть popup до footer confirm/Enter. Выбранные checkbox исчезнут вместе с popup, отправка не начнётся.
3. После одиночного выбора обычного peer — удалить созданный forward draft через composer cancel. Это уже не «до вызова forward flow», но ещё до сетевой отправки.

Небезопасные точки:

- после клика по `Saved Messages`: вызов отправки уже начался;
- после footer confirm/Enter для любого peer;
- после подтверждения multi-select;
- bubble/capture listener, который ждёт изменения checkbox: для hidden-single finalize запускается в том же внутреннем callback, поэтому ожидание DOM уже опаздывает.

Теоретически capture-phase listener может прочитать `data-peer-id`, вызвать `preventDefault()` и `stopImmediatePropagation()` до Telegram. Но тогда внутренний выбор ещё не выполнен; keyboard, touch abstraction, forum topics, top peers, Enter и изменения реализации создают обходные пути. Это нельзя считать безопасным способом переиспользования native Forward picker.

## 7. Получение выбранных peer ID

Подтверждённые варианты:

- одиночный DOM-клик: `event.target.closest('a.row.chatlist-chat[data-peer-id]')?.dataset.peerId`;
- включённый multi-select до confirm: собрать уникальные строки с `input.checkbox-field-input:checked` и взять `data-peer-id` ближайшей строки;
- внутренний API: `handle.selector.getSelected()` возвращает ключи, а callback `onSelect(chosen)` получает полные `{peerId, threadId, monoforumThreadId, key}`.

Ограничения DOM-подхода:

- top peers дублируют основной список;
- виртуализованный/ленивый список содержит только загруженную часть;
- search может заменить list DOM;
- forum/topic использует составной key;
- checked DOM — отражение, а не первичное состояние;
- peer ID не следует логировать вместе с названиями чатов в production.

## 8. Можно ли переиспользовать picker без forward draft

### На уровне исходного приложения — да

Есть два чистых внутренних пути:

1. `showPickUserPopup({ onSelect: ownCallback, ... })` или helper `showSharingPickerPopup(...)`: [`pickUser.tsx` L697-L723](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/pickUser.tsx#L697-L723).
2. `showForwardPopup(undefined, ownCallback)`. Когда `peerIdMids` отсутствует, `showForwardPopup` вызывает переданный `_onSelect` и не использует штатную ветку пересылки: [`forward.tsx` L308-L311](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/forward.tsx#L308-L311).

Это лучший архитектурный вариант, если код является частью Telegram bundle или имеет официально предоставленный module bridge.

### Из текущего userscript — практически нет

Указанные функции и manager objects не опубликованы в `window`. Импорт из собранного Telegram chunk по внутреннему URL, поиск webpack module ID, monkey-patch chunk loader или подмена module factory будут зависеть от конкретной сборки и CSP. Это значительно хрупче собственного picker и может сломаться без видимого DOM-признака.

## 9. Внутренние функции штатного flow

| Этап | Внутренняя функция/состояние | Назначение |
|---|---|---|
| Контекстное действие | `onForwardClick` | Собирает исходные `peerIdMids` и вызывает popup |
| Forward orchestration | `showForwardPopup(peerIdMids, ...)` | Права, footer, send options и выбор стратегии draft/send |
| Открытие picker | `showPickUserPopup(...)` | Создаёт `.popup-forward`, selector, footer и приватный `selected[]` |
| Универсальный picker | `showSharingPickerPopup(...)` | Безопасный helper с пользовательским `onSelect`, если доступен модуль |
| Загрузка/отрисовка peer | `AppSelectPeers`, `dialogsStorage.getDialogs`, `appUsersManager` | Search, folders, contacts, права и lazy loading |
| Выбор строки | `AppSelectPeers.add/remove`, `onSingleSelect` | Обновляет Set/checkbox и при hidden-single вызывает `finalize` |
| Подтверждение | `handle.finalize()` | Вызывает `onSelect(selected)`, затем скрывает popup |
| Один обычный peer | `appImManager.setInnerPeer`, `initMessagesForward` | Открывает чат и создаёт forward draft |
| Немедленный forward | `ChatInput.sendMessageWithForward` | Отправляет в Saved, по footer confirm и для multi-select |

## 10. Открытие чата и отправка нового сообщения

### Открыть выбранный чат

Внутренний способ — `appImManager.setInnerPeer({peerId, threadId, monoforumThreadId})`. Он используется самим Forward. Для userscript безопаснее предпочесть существующую строку диалога/маршрут и затем дождаться, пока активный composer получит ожидаемый `data-peer-id`. Любая навигация должна иметь timeout и проверку, что не остался forward draft.

### Подготовить новое сообщение

После подтверждения ожидаемого активного peer можно использовать существующий `ComposerAdapter`:

- текст — вставить в пустой composer как новый content;
- фото — передать File в media input, дождаться Send Photo preview и установить caption по уже проведённому исследованию `upload-preview-research.md`;
- не нажимать Send до отдельного этапа реализации и явного UX-решения.

### Отправить без визуального перехода и без Bot API

Технически Telegram Web K сам имеет MTProto managers (`rootScope.managers.appMessagesManager`, методы отправки текста/media) и `ChatInput.sendMessageWithForward`. Это не Bot API. Но для userscript эти объекты приватны, их сигнатуры и required state нестабильны, а вызов сразу создаёт сетевое действие без визуального safety gate.

Вывод: в текущей архитектуре надёжно отправлять новое сообщение в произвольный peer без визуального перехода нельзя. Возможность существует только через приватный internal bridge, который сначала нужно отдельно исследовать и обернуть fail-closed проверками. DOM composer требует перехода в конкретный чат.

## 11. Сравнение вариантов A и B

| Критерий | Вариант A: запустить штатный Forward и перехватить | Вариант B: собственный picker |
|---|---|---|
| Надёжность | Низкая для DOM interception; высокая только при прямом доступе к `showPickUserPopup` со своим callback | Средняя; состояние и confirm полностью контролируются проектом |
| Зависимость от internals | Очень высокая: callbacks, hidden multi-select, send branches, module loader | Средняя: DOM чатов/CSS/peer attributes; ниже при собственных styles/state |
| Один получатель | DOM ID получить легко, но Saved может отправиться немедленно | Прямо поддерживается собственным `selectedPeer` |
| Несколько получателей | Нативно поддерживается, но confirm сразу пересылает всем | Легко хранить несколько ID; безопасная доставка требует отдельной стратегии |
| Риск настоящей пересылки | Высокий; подтверждён фактическим экспериментом с Saved | Низкий, если собственный picker вообще не вызывает native Forward |
| Поддержка обновлений | Плохая: приватный flow и module boundaries | Требуется следить за DOM/CSS, но бизнес-логика остаётся своей |
| Новый текст | После перехвата надо отменить forward и отдельно заполнить composer | Естественный pipeline через ComposerAdapter |
| Фото + caption | Те же риски плюс очистка forward draft | Естественный pipeline через существующее media-preview исследование |
| Визуальное сходство | Идеальное | Высокое при повторении текущей popup/row структуры, но CSS-классы не публичны |

### Решение

Рекомендуется вариант B.

Исключение: если в будущем появится надёжный same-bundle bridge, позволяющий прямо вызвать `showSharingPickerPopup({onSelect})`, следует рассмотреть «A-safe»: использовать нативный picker как компонент, но никогда не передавать `peerIdMids` и не запускать штатный Forward. Это принципиально отличается от перехвата уже запущенной пересылки.

## 12. Точный pipeline будущего Clean Forward

### Рекомендуемый MVP: один получатель, подготовка с ручным Send

1. На нативоподобном пункте контекстного меню зафиксировать immutable source descriptor: тип (`text`/`photo`), извлечённый текст/caption, Blob/File, source peer/mid только для диагностики.
2. Закрыть context menu и открыть собственный recipient picker. Native `showForwardPopup(peerIdMids)` не вызывать.
3. Загрузить/показать доступные диалоги; каждая строка должна иметь собственный нормализованный `{peerId, threadId?}`. Дедуплицировать top/main rows.
4. При выборе менять только локальный state. Никакая строка не должна выполнять навигацию или отправку.
5. Отдельная кнопка `Выбрать`/`Далее` фиксирует snapshot получателя. До неё Escape/close просто отменяет операцию.
6. Закрыть picker, открыть выбранный чат безопасным UI-маршрутом.
7. Дождаться одновременно:
   - отсутствия `.popup-forward.active` и `.popup-new-media.active`;
   - активного composer с ожидаемым `data-peer-id`;
   - пустого composer;
   - отсутствия forward/reply draft;
   - отсутствия текущей sending-операции.
8. Для текста подготовить новый composer content. Для фото подготовить File → Send Photo preview → caption по `upload-preview-research.md`.
9. Ещё раз проверить target peer и preview/composer readiness.
10. В MVP оставить пользователю нативный Send как явное подтверждение. При cancel полностью очистить content/preview и operation state.

### Мультивыбор

Собственный picker может хранить массив уникальных `{peerId, threadId?}`, но DOM composer существует только для активного чата. Без private send API возможны лишь:

- последовательный переход по чатам и ручное подтверждение каждого сообщения;
- отказ от multi-select в первом MVP;
- будущий internal bridge для headless send после отдельного исследования, permission check и fail-closed транзакции.

Рекомендуется явно ограничить первый релиз одним получателем. Не имитировать batch send через серию скрытых clicks/Enter.

## 13. Ошибки, таймауты и fail-closed проверки

- Picker не появился за 2–3 секунды: отменить operation state, ничего не готовить.
- Найдено несколько `.popup-forward.active`: считать DOM неподдерживаемым.
- У строки нет единственного корректного `data-peer-id`: отключить её выбор.
- Составной forum key не распознан: не терять suffix, попросить выбрать обычный чат.
- Search заменил list DOM: заново связать rows с локальным state, не полагаться на Element identity.
- Целевой чат не открылся за 5 секунд или composer peer не совпал: остановиться и очистить только созданные проектом данные.
- Composer уже содержит текст/draft: не перезаписывать; показать диагностическую ошибку.
- Media preview не готов по критериям из `upload-preview-research.md`: отменить attachment.
- Popup закрыт пользователем: AbortController должен остановить все ожидающие шаги.
- Telegram обновил классы: selector probe должен завершаться ошибкой, а не переходить к более широкому `document.querySelector('[data-peer-id]')`.
- Любая отправка должна требовать отдельной, ещё не реализованной авторизации состояния: точный peer, payload hash/type, visible confirmation и отсутствие native forward state.

## 14. Подтверждённые селекторы и эвристики

| Назначение | Селектор | Оценка |
|---|---|---|
| Активный Forward picker | `.popup.popup-forward.active` | Подтверждён, но internal CSS |
| Закрытие picker | `.popup.popup-forward.active .popup-close` | Подтверждён |
| Search | `.popup.popup-forward.active input.selector-search-input[type="text"]` | Подтверждён |
| Строка peer | `.popup.popup-forward.active a.row.chatlist-chat[data-peer-id]` | Подтверждён; `data-peer-id` — самый ценный признак |
| Top peers | `.popup-forward-top-peers a.row[data-peer-id]` | Подтверждён, возможны дубли |
| Main list | `.selector-list-section-container a.row[data-peer-id]` | Подтверждён, lazy/replaceable |
| Checkbox | `a.row[data-peer-id] input.checkbox-field-input[type="checkbox"]` | Подтверждён только для multi-capable DOM |
| Footer | `.popup-forward-footer` | Подтверждён |
| Confirm | `.simple-message-input-confirm.btn-primary` | Подтверждён, но не использовать для interception |
| Native context list | `.btn-menu.contextmenu.active .btn-menu-items` | Подтверждён |
| Native context item | `.btn-menu-item.rp-overflow` | Подтверждён |
| Label | `.btn-menu-item-text` | Подтверждён; текст локализован |
| Delete fallback | `.btn-menu-item.danger` | Эвристика порядка/семантики |

`data-peer-id` — не официальный extension API, но он семантичнее CSS-классов и используется самим Telegram для event delegation. Все остальные классы следует считать version-pinned к исследованной сборке.

## 15. Финальное состояние интерфейса

После исследования DOM-проверка показала:

- активных `.popup.active`: 0;
- активных context menu: 0;
- текущий composer: пустой (`textContent.length = 0`, `innerHTML = ""`);
- file input текущего composer: `value = ""`;
- видимого reply/forward wrapper: нет;
- элементов `.sending`: 0;
- URL остался на исходном чате.

Активного popup, attachment preview или forward draft не оставлено. Исключение по фактической отправке в Saved Messages описано в начале отчёта.
