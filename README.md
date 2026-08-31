# Clean Forward for Telegram

Экспериментальное дополнение к Telegram Web K: одна и та же сборка ставится как Tampermonkey userscript или как распакованное расширение Chrome (MV3). Оно создаёт immutable snapshot одного или нескольких исходных сообщений, последовательно открывает выбранные чаты и отправляет содержимое через нативные кнопки Telegram как новые сообщения — без `Forwarded from`.

> [!WARNING]
> Проект зависит от непубличной DOM-структуры Telegram Web K. Любое обновление Telegram может изменить selectors, preview или outgoing markup. При несоответствии проверенного контракта операция должна завершиться fail-closed до Send либо получить `unknown` после уже нажатого Send.

> [!IMPORTANT]
> Реальные Send из собранного расширения в авторизованной Telegram-сессии подтверждены мейнтейнером вручную (2026-08-27): текст, одиночное видео и фото-альбомы уходят получателям без `Forwarded from`. Это ручная проверка одного человека, а не автоматическая: browser E2E с авторизованной сессией в suite не входит и войти не может. Поэтому каждая новая сборка проверяется по чеклисту в конце этого файла и только в контролируемых чатах.

## Пользовательский сценарий

1. Откройте контекстное меню одного сообщения либо выделите несколько сообщений в нативном selection mode Telegram.
2. Нажмите «Отправить как новое». В selection mode пункт называется «Отправить как новые» и доступен на двух поверхностях: в нижней панели выделения рядом с нативным Forward и в контекстном меню выделения, рядом с `Forward selected`. Обе работают над всем выбранным набором, а не над одним долгонажатым сообщением.
3. Выберите одного или нескольких получателей. Порядок выбора сохраняется.
4. Нажмите «Далее» один раз.
5. Clean Forward последовательно доставит весь bundle каждому получателю.
6. После успеха, ошибки, отмены или неизвестного результата Clean Forward возвращает исходный чат и
   завершает нормальный результат только после того, как переход в него доказан.

Ручное подтверждение Send для каждого получателя не требуется. В production-конфигурации итоговое окно полностью успешной операции автоматически скрывается.

## Фактическая support matrix

| Тип | Capture model | Native delivery | Статус и ограничения |
|---|---|---|---|
| Plain text | DOM fallback или verified Telegram model | Text composer + native Send | Поддерживается end-to-end; политика link preview — только `regenerate` |
| Photo | Полные bytes, имя и MIME | `Photo or Video` preview + native confirm | Поддерживается; только plain caption без entities |
| Video | DOM capture полных bytes + размеры/длительность из `<video>` | `Photo or Video` preview + native confirm | Поддерживается: одно обычное видео, опционально с plain caption. Требуется загруженная браузером metadata и свободное место в хранилище origin; Telegram перекодирует видео при загрузке |
| GIF/animation | Verified model + полные bytes/metadata | `Photo or Video` preview + native confirm | **Не поддерживается production capture:** strategy test-only; Telegram также может транскодировать media |
| Document | Verified model + полные bytes/имя/MIME | `Document` preview + native confirm | **Не поддерживается production capture:** strategy test-only; thumbnail не считается содержимым файла |
| Audio/music | Verified model + полные bytes/metadata | `Document` preview + native confirm | **Не поддерживается production capture:** strategy test-only; voice message не преобразуется в audio file |
| Фото-альбом | `grouped_id` и число участников из read-only model bridge, байты из DOM | Один grouped preview и один native confirm | Поддерживается: 2–10 обычных фото. Альбом копируется только целиком; когда bridge не отвечает, группу нельзя доказать и она отклоняется как раньше |
| Альбом с видео, GIF или смешанный | Группа доказывается, содержимое — нет | Нет | Отклоняется отдельной формулировкой: `PopupNewMedia.iterate` в Web K может разбить такой альбом на несколько Send, и критерий «одна группа = одно сообщение» перестал бы описывать результат |
| Несколько сообщений | Ordered immutable bundle | По одному item/group за раз | Поддерживается, если каждый unit имеет безопасную capture и delivery strategy |
| Formatted text/caption | Entities сохраняются в generalized model | Нет lossless DOM injection | Explicit fail-before-Send; форматирование не сбрасывается молча |
| Exact/disabled link preview | Policy сохраняется в model | Нет доказанного точного native control | Explicit fail-before-Send |
| Poll/quiz | Result-free template может быть captured | Текущий popup содержит дополнительные настройки | Explicit fail-before-Send; результаты и voters не копируются |
| Voice, video note, stickers | Explicit discriminator | Не реализовано | Unsupported (RED), без преобразования в другой смысловой тип |
| Contact, location/venue | Explicit discriminator | Не реализовано | Unsupported (RED) |
| Service, game, invoice, story, giveaway, dice | Explicit discriminator | Не реализовано | Unsupported (RED) |
| Protected, TTL/ephemeral, paid или unavailable media | Restriction flags | Запрещено | Capture отклоняется целиком до recipient picker |

Нельзя описывать проект как поддерживающий «любое сообщение Telegram»: capture adapter сам по себе не означает end-to-end поддержку. Для model-backed типов нужны и проверяемый read-only model bridge, и полные binary bytes; неизвестное состояние отклоняется. Bridge подключён только для доказательства альбома — он отвечает на вопрос «какая это группа и сколько в ней участников», а байты по-прежнему читаются из DOM, поэтому моделировать каждое семейство медиа не приходится.

## Reliability guarantees

- source bundle и recipient list snapshot immutable и хранятся только в памяти;
- source navigation target берётся из peer identity captured bundle, а не из поздней sidebar row;
- сохраняются порядок исходных сообщений и порядок выбора получателей;
- выполняется только один recipient и один item/group одновременно;
- используются только нативные Telegram Send controls — не Enter, не Forward и не private send API;
- navigation проходит `resolve → address → initiate → observe → exact peer → owned composer → stabilize → cleanup → final proof`;
- exact peer подтверждается реальным узлом ввода внутри единственного active main-chat, а не URL/title или глобальным composer. Для получателя этот узел обязан быть редактируемым — туда сразу пишут draft и жмут native Send; для источника достаточно нередактируемого, потому что чтение выделенных сообщений права писать не требует ни в одной точке;
- каждый search retry заново получает одноразовую row; закрытие search имеет completion barrier перед следующим peer;
- пользовательский plain-text draft временно освобождается и восстанавливается после попытки recipient;
- успех требует нового outgoing `data-mid`, подтверждённого сервером Telegram: пока Web K держит
  временный дробный mid либо классы `is-outgoing`/`is-sending`, отправка не завершена. Именно это
  сохраняет порядок bundle — следующий item не уходит, пока предыдущий ещё загружается. Закрытие
  preview и очистка composer успехом не считаются;
- захват медиа не тратит хранилище Telegram сверх необходимого: требуемое место проверяется до
  чтения, а чанки, которые захват заставил service worker сохранить, удаляются после него;
- альбом подтверждается как одно исходящее сообщение, а не как N: Web K вешает `data-mid` и на бабл группы, и на каждый `.grouped-item`, поэтому identity схлопываются по `data-mid`. Бабл, чей mid не принадлежит ни одному его элементу, по-прежнему считается отдельным сообщением — ради этого случая проверка и существует;
- automatic retry ограничен и разрешён только до Send;
- после Send повтор item/group запрещён; неоднозначность становится `unknown` и останавливает batch;
- user retry возобновляет только `pending`/`failed-before-send` pairs и не повторяет `sent`/`unknown-after-send`;
- Cancel до Send очищает только подготовленное Clean Forward содержимое; после Send сначала завершается reconciliation;
- source-chat restore выполняется после любого terminal outcome и не переписывает delivery statuses при собственной ошибке;
- Escape перехватывается только верхним Clean Forward overlay и не используется для управления Telegram chat;
- общий MutationObserver вызывается на каждой пачке мутаций Telegram, поэтому вне selection mode реконсиляция обязана оставаться reflow-free: признаки выделения проверяются дешёвыми selector-совпадениями до любого разрешения composer, которое доходит до `getComputedStyle`. Нарушение этого порядка возвращает layout thrashing, из-за которого Telegram Web K переставал загружаться.

## Item-level state

```text
pending
  -> preparing
      -> failed-before-send  (safeToRetry=true)
      -> sendClicked         (необратимая граница)
          -> sent
          -> unknown-after-send
```

Recipient status вычисляется из вложенных item/group states. Для каждой пары доступны признаки `sendClicked`, `outgoingConfirmed`, `failedBeforeSend`, `unknownAfterSend`, `safeToRetry` и подтверждённые `messageIds`.

## Ограничения интеграции

- поддерживается только `https://web.telegram.org/k/*`;
- attachment actions `Photo or Video` и `Document` пока зависят от подтверждённых английских labels;
- recipient navigation использует fresh exact `data-peer-id` rows, bounded native search и официальный `#/im?p=<peer>` только как initiation fallback; URL не считается peer proof;
- forum topics, sponsored rows и неоднозначные peer keys не выбираются;
- источником может быть broadcast-канал, у которого поля ввода нет в принципе: identity читается с нередактируемого узла ввода, который Web K строит для любого чата. Владение при этом не ослаблено — тулбар выделения обязан лежать в том же chat-input-контейнере, список сообщений в том же активном чате, а узел ввода в шелле быть единственным. Получателем read-only peer по-прежнему быть не может: писать туда нельзя, и `TelegramPeerEligibility` отсекает его до picker;
- formatted drafts, reply/edit/forward state и существующий attachment preview не изменяются автоматически;
- альбом копируется только целиком и только непрерывным участком исходной ленты. Выбор части альбома и вызов из контекстного меню на одной фотографии отклоняются с указанием, сколько частей в альбоме: молча расширить выделение, которого никто не делал, запрещено. Отклоняются также incomplete group, несовместимое native partitioning, animation внутри группы и caption boundaries, которые нельзя сохранить;
- browser E2E с авторизованной сессией не входит в автоматическую suite и не войдёт: она потребовала бы реальных Send и реальной сессии. Ручная проверка по чеклисту остаётся единственным доказательством того, что сборка работает, и проводить её нужно только в контролируемых чатах.
- DOM-контракт должен сверяться с исходным кодом Web K, а не с записями ручного исследования: три селектора уже отличались от реального кода и молча отключали интеграцию именно на мобильных и в selection mode, при полностью зелёной suite. Фикстуры воспроизводят предположения автора, поэтому сами по себе несовпадение контракта не ловят.
- read-only model bridge ([`src/telegram/TelegramModelBridge.ts`](src/telegram/TelegramModelBridge.ts)) подключён, но только для фото-альбомов: он отвечает на один вопрос — `grouped_id` и число участников. Document/audio strategies по-прежнему не являются production support;
- bridge требует, чтобы код выполнялся в realm самой страницы: в userscript это даёт `@grant none`, в расширении — `world: "MAIN"` в манифесте. В изолированном мире content script у страницы другой global, bridge не нашёл бы ничего, и каждый альбом откатывался бы в отказ «нужен verified grouped_id» — как сломанная функция, а не как отсутствующее разрешение;
- bridge читает приватный `window.apiManagerProxy`. Это не контракт, а особенность сборки upstream: API неверсионируемый и может исчезнуть в любом деплое, поэтому отсутствие API, метода, исключение, неожиданная форма ответа и несовпавшая identity дают один и тот же `null` — ровно то поведение, которое было до появления bridge. Наличие API перепроверяется на каждом вызове, потому что Telegram обновляется под уже открытой вкладкой. `grouped_id` переносится строкой и никогда не парсится в число: он превышает 2^53, и разные альбомы начали бы сравниваться как равные;
- video captured из DOM: поддерживается ровно одно обычное видео в сообщении, без photo рядом и вне album. Video note (кружок) и GIF/animation намеренно не считаются video, потому что повторная отправка через media path изменила бы смысл сообщения;
- байты видео собираются полностью до отправки. Telegram отдаёт их своим service worker по частям, поэтому неизвестный общий размер или обрыв передачи отклоняются: усечённый файл остаётся воспроизводимым видео и молча заменил бы оригинал;
- capture видео начинается только после того, как браузер сообщил его реальные размеры и длительность. До этого сообщение отклоняется, а не отправляется одной подписью;
- чтение видео идёт через service worker Web K, а тот сохраняет **каждый** выданный чанк в CacheStorage `cachedStreamChunks` и дополнительно читает 20 МБ вперёд. Это тот же origin, где Telegram держит собственную сессию и state, поэтому цена копии ложится на Telegram. Захват отклоняется до чтения, если копия не помещается в свободное место, а вызванные им чанки удаляются после захвата. Браузер, не сообщающий `navigator.storage.estimate()`, захват не блокирует: иначе копирование было бы невозможно там, где оценки нет.

## Установка

Требуется Node.js 18 или новее.

```bash
npm install
npm run validate
```

`npm run build` собирает обе поставки в `dist/` из одного и того же `src/main.ts`:

| Файл | Для чего |
|---|---|
| `clean-forward-for-telegram.user.js` | userscript для Tampermonkey |
| `content-script.js` + `manifest.json` + `icon-128.png` | распакованное расширение Chrome (MV3) |

Собрать по отдельности — `npm run build:userscript` и `npm run build:extension`.
Отдельная extension-сборка дописывает файлы в `dist/` и не трогает userscript, а
userscript-сборка очищает `dist/` целиком — поэтому после неё нужен полный
`npm run build`, если нужны обе поставки.

Для загрузки в Chrome Web Store — `npm run package:extension`: чистая сборка плюс
`clean-forward-<версия>.zip` в корне репозитория. В архив попадают только файлы, на которые
ссылается манифест, и лежат они в корне ZIP, как того требует стор. Упаковка падает, если
версия в собранном манифесте разошлась с `package.json` — то есть если `dist/` собран до
бампа версии.

Код в обеих поставках побайтово одинаковый; различается только обёртка —
Tampermonkey-хедер против `manifest.json`.

### Вариант 1: Tampermonkey

1. Откройте Tampermonkey и создайте userscript.
2. Замените его содержимое файлом `dist/clean-forward-for-telegram.user.js`.
3. Сохраните userscript и полностью перезагрузите уже открытую вкладку Telegram Web K.

После новой сборки нужно повторно заменить код в Tampermonkey: уже установленная
копия не синхронизируется с локальным `dist` автоматически.

Сборка содержит header с `@match https://web.telegram.org/k/*`.

### Вариант 2: расширение Chrome

1. Откройте `chrome://extensions`.
2. Включите **Developer mode**.
3. **Load unpacked** → выберите папку `dist/`.
4. Полностью перезагрузите уже открытую вкладку Telegram Web K.

После новой сборки нажмите «Обновить» на карточке расширения — Chrome не
перечитывает `dist/` сам.

Манифест объявляет `world: "MAIN"`, и это обязательно, а не предпочтение: capture
альбомов читает приватный объект страницы `apiManagerProxy` через
`src/telegram/TelegramModelBridge.ts`. В изолированном мире content script у
страницы другой global, бридж не нашёл бы ничего, и каждый альбом молча
откатывался бы в отказ «нужен verified grouped_id» — выглядело бы как сломанная
функция, а не как отсутствующее разрешение.

Разрешений (`permissions`) манифест не запрашивает: скрипт работает только с DOM
той страницы, в которую внедрён, и никуда не обращается. Право на внедрение даёт
сам `matches`.

> [!WARNING]
> Ставить обе поставки одновременно смысла нет. Обе внедряют один и тот же код в
> одну вкладку, и стартующий вторым перехватывает управление у первого через
> stop-handshake. Отказ стартовать он выдаёт только если первый занят видимым
> workflow или не подтвердил остановку — то есть в худшем случае вы получите
> «reload is required» посреди работы. Выберите что-то одно.

Текущий релиз — `0.1.12`; версия показывается не только в userscript header и
`manifest.json`, но и в заголовках picker/progress UI. Если там нет `v0.1.12`,
новый runtime не запущен — это первое, что нужно проверить, когда сборка ведёт
себя как предыдущая.

## Разработка и проверки

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

- `typecheck` проверяет TypeScript;
- `test` запускает Vitest/jsdom regression suite;
- `build` создаёт `dist/clean-forward-for-telegram.user.js`;
- `validate` последовательно запускает typecheck, tests и production build.

Отдельно, потому что требует сети и зависит от чужого репозитория:

```bash
npm run check:tweb
```

`check:tweb` скачивает исходники Telegram Web K и проверяет, что каждый класс/id/атрибут из
`contracts/tweb-dom-contract.json` и каждый приватный символ из
`contracts/tweb-api-contract.json` там ещё существует. Это детектор дрейфа, а не доказательство
корректности: он видит исчезновение токена, но не изменение структуры. Запускается еженедельно
и на PR, меняющих сам контракт; подробности — в
[docs/tweb-navigation-contract.md](docs/tweb-navigation-contract.md).

Структуру `check:tweb` не видит принципиально: класс может уцелеть, но переехать на другой узел,
и тогда селектор мёртв при зелёной проверке. Такая ручная сверка каждого селектора с исходниками
upstream — в [docs/tweb-contract-audit.md](docs/tweb-contract-audit.md); там же список того, что
сломано прямо сейчас.

Fixtures синтетические и не содержат реальных сообщений, peer IDs, cookies или Telegram session data.

## Архитектура

- `src/domain/` — immutable source descriptors, transferable content, ordered bundle и pending in-memory state;
- `src/telegram/capture/` — type-specific capture adapters с atomic fail-closed snapshot;
- `src/telegram/domContract.ts` — единственное место, где живут селекторы Telegram Web K;
- `contracts/tweb-dom-contract.json` — инвентарь токенов этого контракта для сверки с апстримом;
- `src/telegram/TelegramModelBridge.ts` — единственное место, которому разрешено читать приватный API Telegram, ровно как `domContract.ts` — единственное место с селекторами;
- `contracts/tweb-api-contract.json` — приватные символы, от которых зависит bridge; неверсионируемый API ломается тише, чем CSS-класс;
- `src/telegram/` — Telegram DOM contracts, navigation, draft transaction, preparation и native Send confirmation;
- `src/delivery/DeliveryBatch.ts` — nested recipient/item ledger и duplicate-prevention states;
- `src/delivery/DeliveryCoordinator.ts` — последовательный N×M обход, retry boundaries, draft/source restoration;
- `src/recipient/` — immutable recipient selection и picker controller;
- `src/ui/` — Shadow DOM picker и progress UI без Telegram selectors; поведение панели прогресса разобрано в [docs/delivery-progress-panel.md](docs/delivery-progress-panel.md);
- `tests/` — domain, DOM, integration и reliability regressions.

Payload и binary Blob живут только в памяти. `localStorage`, IndexedDB, Telegram Bot API, native Forward и private Telegram send methods не используются.

## Ручная проверка перед релизом

Используйте только контролируемые тестовые чаты и останавливайтесь при любой неоднозначности:

- 1 text → 1 recipient и 1 text → 2 recipients;
- 3 ordered text messages → 1 и 2 recipients;
- selection mode: смешанный набор text, photo и photo + caption, запущенный и из нижней панели выделения, и из контекстного меню выделения;
- холодная перезагрузка вкладки с установленной поставкой: Telegram Web K должен полностью загрузиться без зависания. Проверять нужно ту поставку, которую собираетесь отдавать: код одинаковый, но момент внедрения у Tampermonkey и у content script разный;
- в заголовке picker/progress стоит версия из свежей сборки, а не предыдущая: у расширения это значит «Обновить» на карточке в `chrome://extensions`, у userscript — заново вставленный код;
- source chat также выбран recipient;
- источник — broadcast-канал: пункт «Отправить как новые» обязан появиться и в нижней панели выделения, и в контекстном меню выделения, отработать над всем выделенным набором, а не над одним долгонажатым сообщением, и вернуться в канал без «Остановки безопасности»;
- канал как получатель по-прежнему недоступен в picker;
- photo и photo + caption; document/audio — только после подключения verified production model bridge;
- одно видео и видео + caption, включая большое видео, которое Telegram отдаёт частями;
- видео, у которого ещё не загрузилась metadata, и видео-кружок: оба должны быть отклонены до recipient picker;
- видео при почти заполненном хранилище origin: захват должен быть отклонён до recipient picker с явной причиной, а Telegram — остаться работоспособным;
- после успешного захвата видео в CacheStorage `cachedStreamChunks` не остаётся чанков, вызванных этим захватом;
- альбом из 2–10 фото: один native Send, альбом приходит целым, а панель показывает `Отправлено: 1`, а не «Результат неизвестен»;
- альбом, выбранный частично, и альбом, вызванный из контекстного меню на одной фотографии: оба отклоняются с указанием числа частей;
- альбом с видео или GIF: отклоняется формулировкой про видео, а не общей ошибкой альбома;
- альбом при недоступном `window.apiManagerProxy`: поведение возвращается к прежнему отказу, без исключения в консоли;
- пользовательский draft в destination до success, pre-Send failure и Cancel;
- recipient/composer/upload-preview rerender;
- source chat отсутствует в recent list и находится через search fallback;
- Cancel до Send, во время подготовки и сразу после Send click;
- network/DOM delay до Send и confirmation timeout после Send;
- retry после частичного bundle: ранее подтверждённые пары не появляются повторно;
- у новых сообщений отсутствует forwarded label, а исходный чат восстановлен.

## Безопасность

Не добавляйте в issues, tests или commits реальные сообщения, названия чатов, peer IDs, cookies, session data или screenshots авторизованного интерфейса. Уязвимости сообщайте согласно [SECURITY.md](SECURITY.md).

## Лицензия

[MIT](LICENSE)
