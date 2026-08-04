# Telegram Web K: исследование upload preview одной картинки

Дата проверки: 2026-08-03. Интерфейс: авторизованный Telegram Web K в Chrome, чат `Saved Messages`. Тестовый файл: нейтральное системное JPEG-изображение Windows, 1920×1200. Кнопка Send и горячие клавиши отправки не использовались.

Проверка исходного кода относится к `morethanwords/tweb` commit [`e52b5d9318848ab83316cb53138358cf49d2a27f`](https://github.com/morethanwords/tweb/commit/e52b5d9318848ab83316cb53138358cf49d2a27f) от 2026-07-23. DOM и поведение дополнительно подтверждены в живой сессии.

## Краткий вывод

Для активного composer Telegram создаёт один скрытый `input[type="file"]`. Он находится внутри `.new-message-wrapper`, которая входит в текущий `.chat-input-main`. Сам input не специализирован: изначально у него только `type="file"`, `multiple` и `style="display: none"`. Выбор пункта `Photo or Video` сначала задаёт media-режим во внутреннем состоянии Telegram и устанавливает `accept`, затем вызывает `fileInput.click()`.

После выбора файла Telegram слушает только событие `change`, копирует `File` из `input.files`, открывает `.popup.popup-send-photo.popup-new-media.active` и сразу сбрасывает `fileInput.value` в пустую строку. Preview строится локально через `blob:` URL. Фактическая передача байтов картинки на сервер начинается не при открытии preview, а только из `send()` после нажатия подтверждения, где вызывается `appMessagesManager.sendGrouped(...)`.

## 1. Подтверждённый file input

Живой DOM до выбора режима:

```html
<div class="new-message-wrapper rows-wrapper-row" data-offset="commands">
  ...
  <input type="file" multiple style="display: none;">
</div>
```

После выбора `Photo or Video` тот же элемент получил:

```html
<input
  type="file"
  multiple
  style="display: none;"
  accept="image/jpeg, image/png, image/bmp, image/webp, image/avif, image/gif, video/mp4, video/webm, video/quicktime"
>
```

В исходном коде input создаётся один раз и добавляется в `newMessageWrapper`: [`input.ts` L1268-L1284](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/input.ts#L1268-L1284).

Рекомендуемый поиск в проекте:

```ts
const activeComposer = document.querySelector<HTMLElement>(
  '.input-message-input[contenteditable="true"][data-peer-id]'
);
const chatInput = activeComposer?.closest<HTMLElement>('.chat-input-main');
const fileInputs = chatInput?.querySelectorAll<HTMLInputElement>(
  '.new-message-wrapper input[type="file"]'
);
```

Продолжать можно только если найден ровно один input, активный composer принадлежит ожидаемому peer, а открытого `.popup-new-media.active` ещё нет.

## 2. Полный pipeline: Blob/File → готовый preview

1. Создать нормальный `File`, сохранив MIME type и осмысленное имя:

   ```ts
   const file = new File([blob], fileName, {
     type: blob.type || 'image/jpeg',
     lastModified: Date.now(),
   });
   ```

2. Активировать именно media-ветку Telegram. Подтверждённый UI-путь: attachment menu → `Photo or Video`. Обработчик вызывает `onAttachClick(false, true, true)`, выставляет список MIME в `accept`, записывает внутренний `willAttachType = 'media'` и вызывает `fileInput.click()`: [`input.ts` L1059-L1063](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/input.ts#L1059-L1063), [`input.ts` L1653-L1700](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/input.ts#L1653-L1700).

3. В исследовании файл был установлен через браузерный file chooser (`setFiles`), то есть Chrome выполнил нативное присваивание `FileList` и сгенерировал событие выбора.

4. Для DOM-реализации стандартный эквивалент присваивания — `DataTransfer`:

   ```ts
   const transfer = new DataTransfer();
   transfer.items.add(file);
   fileInput.files = transfer.files;
   fileInput.dispatchEvent(new Event('change', {bubbles: true}));
   ```

   Этот фрагмент является рекомендацией для реализации, а не отдельным живым экспериментом: в Chrome исследование использовало нативный chooser. Критически важно, чтобы до `change` Telegram уже находился в media-режиме. Простая ручная установка `accept` не заменяет внутренний `willAttachType`.

5. На `change` Telegram копирует `Array.from(fileInput.files)`, создаёт `PopupNewMedia`, а затем очищает `fileInput.value`: [`input.ts` L1432-L1448](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/chat/input.ts#L1432-L1448).

6. Для картинки popup создаёт локальный object URL, декодирует изображение и при необходимости локально масштабирует/перекодирует его. Для проверенного JPEG preview получил `blob:https://web.telegram.org/...`, `img.complete === true`, `naturalWidth === 1920`, `naturalHeight === 1200`. Соответствующий путь находится в [`newMedia.ts` L1149-L1338](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/newMedia.ts#L1149-L1338).

7. После готовности caption заполняется через нативный editing path, затем состояние и DOM проверяются. Send не нажимается.

## 3. DOM upload preview

Корневой элемент:

```html
<div class="popup popup-send-photo popup-new-media active">
```

Значимые дочерние узлы:

```html
<button class="btn-icon popup-close">...</button>
<div class="popup-title"><span class="i18n">Send Photo</span></div>
<div class="popup-photo">
  <div class="popup-item popup-item-media" style="width: 384px; height: 240px;">
    <img decoding="async" src="blob:https://web.telegram.org/...">
  </div>
</div>
<div
  class="input-message-input is-empty scrollable scrollable-y no-scrollbar simple-message-input-input"
  contenteditable="true"
  dir="auto"
  data-animation-group="NEW-MEDIA"
></div>
<span class="... simple-message-input-placeholder">Add a caption...</span>
<div contenteditable="true" class="... input-field-input-fake simple-message-input-input"></div>
<button class="btn-primary btn-color-primary simple-message-input-confirm">...</button>
```

Preview не имеет `role="dialog"`, `aria-label` или `data-testid`. Поэтому классы popup сейчас являются основным контрактом.

## 4. Поле подписи и корректная вставка

Подтверждённый селектор реального, а не fake-поля:

```css
.popup-send-photo.popup-new-media.active
  .simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)
```

В эксперименте нативная вставка строки

```text
Тестовая подпись 🧪
Вторая строка 🙂
```

дала DOM:

```html
Тестовая подпись <img src="assets/img/emoji/1f9ea.png" class="emoji emoji-image" alt="🧪">
Вторая строка <img src="assets/img/emoji/1f642.png" class="emoji emoji-image" alt="🙂">
```

Перевод строки остался текстовым `\n`, а emoji были преобразованы Telegram в `img.emoji` с исходным символом в `alt`. Поэтому проверять результат только через `textContent` нельзя: emoji там отсутствуют. Для чтения/проверки нужно рекурсивно объединять text nodes, `BR` как `\n` и `IMG[alt]` как значение `alt`, как уже делает `extractReadableText` проекта.

Рекомендованный способ для `ComposerAdapter`:

1. сфокусировать подтверждённое real contenteditable;
2. выделить/очистить его содержимое без клавиш отправки;
3. вставить всю подпись одной нативной операцией редактирования, предпочтительно тем же `document.execCommand('insertText', false, caption)`, который уже используется проектом для основного composer;
4. дождаться `input` и завершения изменения высоты (`.animating`/`.is-changing-height` исчезли в проверке);
5. сравнить восстановленное readable-значение с исходной подписью.

Прямое `element.textContent = caption` или `innerHTML = ...` не рекомендуется: картинка на экране может выглядеть правильно, но Telegram не получит полный rich-input event sequence и не нормализует emoji/переносы.

## 5. Обязательные события

### File input

- `change` — обязательное и достаточное событие приложения. На нём установлен единственный подтверждённый обработчик Telegram.
- `input` — Telegram для этого file input не слушает; вручную не требуется.
- `beforeinput` — к file input не относится и не требуется.
- Событие лучше отправлять с `{bubbles: true}` для совместимости, хотя текущий обработчик висит непосредственно на input.

Важно: сам `change` не задаёт media/document mode. Режим должен быть активирован раньше через Telegram UI или другой подтверждённый внутренний путь.

### Caption contenteditable

- `input` — обязательный сигнал. `InputFieldAnimated` обновляет fake input и высоту на `input`: [`inputFieldAnimated.ts` L22-L28](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/inputFieldAnimated.ts#L22-L28). `InputFieldMessage` также обновляет состояние caption на `input`: [`inputFieldMessage.tsx` L146-L157](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/inputFieldMessage.tsx#L146-L157).
- `beforeinput` — Telegram слушает его на уровне document для rich-input обработки: [`richInputHandler.ts` L35-L48](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/helpers/dom/richInputHandler.ts#L35-L48). Его не следует синтезировать отдельно от фактического редактирования. Нативная печать/`insertText` должна породить согласованную пару `beforeinput` → изменение DOM → `input`.
- `change` — для caption не используется и не нужен.

Живой эксперимент подтвердил, что браузерная нативная вставка многострочного текста с emoji запускает нужную нормализацию. Отдельно доказать, что искусственный `input` без `beforeinput` безопасен, нельзя; такой fallback не рекомендуется.

## 6. Критерий полной готовности preview

Для одной картинки считать preview готовым только при одновременном выполнении всех условий:

```ts
const popup = document.querySelector<HTMLElement>(
  '.popup-send-photo.popup-new-media.active'
);
const image = popup?.querySelector<HTMLImageElement>(
  '.popup-item.popup-item-media img'
);
const caption = popup?.querySelector<HTMLElement>(
  '.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)'
);
const confirm = popup?.querySelector<HTMLButtonElement>(
  '.simple-message-input-confirm'
);

const ready = Boolean(
  popup &&
  image?.complete &&
  image.naturalWidth > 0 &&
  image.naturalHeight > 0 &&
  image.src.startsWith('blob:') &&
  caption &&
  confirm &&
  !confirm.disabled
);
```

После заполнения подписи дополнительно дождаться отсутствия временных классов `.animating` и `.is-changing-height`, затем проверить readable caption. `fileInput.value` и `fileInput.files` не являются критерием: Telegram очищает value сразу после копирования File.

Рекомендуемые таймауты для небольшого изображения: 5 секунд на появление popup, до 10 секунд на `img.complete && naturalWidth > 0`, 2 секунды на стабилизацию caption и 5 секунд на закрытие. Для тяжёлых изображений, GIF/видео и локальной конвертации нужен отдельный более длинный timeout и проверка блокировки confirm.

## 7. Безопасная отмена

Подтверждённый селектор:

```css
.popup-send-photo.popup-new-media.active .popup-close
```

Перед click требуется убедиться, что найден ровно один элемент и что он находится внутри нужного активного media popup. После click дождаться удаления `.popup-send-photo.popup-new-media.active` из DOM.

Исходный код на `close` очищает внутренние `files` и `sendFileDetails`: [`newMedia.ts` L387-L397](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/newMedia.ts#L387-L397).

После отмены в живой проверке:

- активных media popup: 0;
- `fileInput.value`: пустая строка;
- основной real composer: пустой, класс `is-empty`;
- fake composer: пустой;
- активный peer: `Saved Messages`;
- счётчик сообщений остался `341 messages`;
- исходящих элементов со статусом `sending`: 0.

## 8. Передача на сервер до Send

Байты картинки до Send на сервер не загружаются.

Наблюдаемое поведение:

- preview использовал локальный `blob:` URL;
- видимого прогресса сетевой загрузки не было;
- upload-специфичных console logs не появилось;
- доступная поверхность управления Chrome не предоставляла просмотр WebSocket/MTProto frames, поэтому прямой packet-level захват не выполнялся.

Подтверждение исходным кодом сильнее косвенного DOM-сигнала: подготовка preview вызывает `createObjectURL`, декодирование, создание thumbnail и при необходимости локальное canvas-масштабирование. Метод `send()` и вызов `appMessagesManager.sendGrouped(...)` находятся только на пути подтверждения: [`newMedia.ts` L835-L1003](https://github.com/morethanwords/tweb/blob/e52b5d9318848ab83316cb53138358cf49d2a27f/src/components/popups/newMedia.ts#L835-L1003).

До Send Telegram может выполнить служебные API-запросы за лимитом caption или правами чата, но содержимое File в этот момент остаётся локальным.

## 9. Устойчивые селекторы и эвристики

### Наиболее устойчивые из доступных

- `.input-message-input[contenteditable="true"][data-peer-id]` — активный основной composer; `data-peer-id` позволяет проверить адресата.
- `.chat-input-main` + `.new-message-wrapper input[type="file"]` — scope file input к активному composer.
- `.popup-send-photo.popup-new-media.active` — активный upload preview.
- `.popup-new-media.active .popup-item.popup-item-media img` — изображение preview, только внутри popup.
- `.popup-new-media.active .simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)` — real caption editor.
- `.popup-new-media.active .popup-close` — отмена.
- `.popup-new-media.active .simple-message-input-confirm` — индикатор наличия/разблокировки confirm; никогда не нажимать автоматически.

У Telegram нет `data-testid`, dialog role или aria-label для этих элементов, поэтому даже эти селекторы остаются DOM-контрактом, а не публичным API.

### Эвристики и хрупкие признаки

- текст `Photo or Video`, `Send Photo`, `Add a caption...` — локализуется;
- icon-font символы (``, ``, ``) — не использовать;
- сгенерированный класс вида `_Container_bns2b_1` — не использовать;
- точная строка `accept` — может меняться с поддержкой форматов; проверять смысл, а не полное равенство;
- `blob:` UUID, размеры `style="width: ..."`, порядок кнопок — нестабильны;
- позиционные селекторы, `first/last/nth-child` — запрещённая эвристика;
- наличие слова `preview` в произвольном class — даёт ложные совпадения с webpage preview в истории сообщений.

## 10. Ошибки, гонки и таймауты

- Нет ровно одного активного composer или `data-peer-id` изменился: прекратить операцию.
- Не найден ровно один scoped file input: прекратить операцию.
- Уже открыт `.popup-new-media.active`: не добавлять файл неявно; вернуть ошибку состояния.
- Media mode не активирован: `change` может открыть document preview или использовать устаревший `willAttachType`.
- MIME File пустой/неподдерживаемый: Telegram может классифицировать его как document или показать ошибку.
- Popup появился, но image не загрузился (`complete === false`, `naturalWidth === 0`) либо confirm остаётся disabled: timeout, затем безопасная отмена.
- Popup исчез во время ожидания: пользователь отменил или сменил состояние; считать операцию отменённой, не повторять автоматически.
- Caption превышает серверный limit: confirm-path покажет ошибку; адаптер должен проверять лимит заранее, если он известен, и никогда не нажимать confirm.
- При emoji нельзя сравнивать `textContent`; требуется учитывать `img[alt]`.
- При ошибке после открытия popup cleanup обязателен в `finally`: нажать scoped `.popup-close`, дождаться удаления popup, проверить пустой основной composer.
- В Chrome automation загрузка локального File требует разрешения расширения `Allow access to file URLs`; без него установка файла отклоняется до передачи странице.

## 11. Рекомендации для ComposerAdapter

1. Оставить всю Telegram-специфику в `TelegramDomAdapter`; `ComposerAdapter` должен оркестрировать state machine и результат, но не знать селекторы.
2. Ввести явные состояния: `idle → arming-media → file-selected → preview-rendering → preview-ready → caption-ready`; любое исключение после `preview-rendering` ведёт в `cancelling → clean`.
3. Перед началом сохранить и повторно проверить `data-peer-id`. Если пользователь переключил чат, немедленно отменить popup.
4. Не считать простую установку `input.files` достаточной. Нужен подтверждённый способ выставить внутренний `willAttachType = 'media'`. UI-путь через `Photo or Video` подтверждён, но локализованный текст и открытие native chooser делают его хрупким для production-кода. Это главный оставшийся инженерный риск.
5. После присваивания File посылать `change`; не посылать лишние `input`/`beforeinput` на file input.
6. Preview искать только по `.popup-send-photo.popup-new-media.active`, а caption — только внутри этого popup и с исключением `.input-field-input-fake`.
7. Для caption переиспользовать существующий нативный `execCommand('insertText')`-подход. Не присваивать `textContent`/`innerHTML` напрямую.
8. Готовность подтверждать составным predicate, а не timeout-only ожиданием и не `fileInput.value`.
9. Никогда не кликать `.simple-message-input-confirm`, не нажимать Enter/Ctrl+Enter и не вызывать внутренний `send()`.
10. Любой failure после появления popup обязан завершаться scoped close и постусловиями: popup отсутствует, основной composer пуст, нет `.sending`.
11. Перед реализацией production-функции отдельно прототипировать способ «arm media mode без оставленного native file picker». Если надёжного DOM-пути нет, лучше сохранить feature disabled, чем зависеть от устаревшего `willAttachType`.

## Итоговая последовательность подтверждённого исследования

```text
Saved Messages, пустой composer
→ открыть attachment menu
→ выбрать Photo or Video
→ Telegram задаёт accept и media mode
→ Chrome устанавливает один JPEG File
→ native change
→ Telegram копирует File и очищает fileInput.value
→ появляется .popup-send-photo.popup-new-media.active
→ локальный blob: preview декодирован (1920×1200)
→ real caption contenteditable найден
→ нативно вставлены две строки и emoji
→ Telegram нормализовал emoji в img[alt]
→ readiness predicate выполнен
→ click только по .popup-close
→ popup удалён, composer пуст, сообщений по-прежнему 341, sending = 0
```
