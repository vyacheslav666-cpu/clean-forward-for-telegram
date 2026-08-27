# Технический аудит delivery pipeline

Дата: 2026-08-09. Целевая среда: Chrome Desktop, обычная вкладка Telegram Web K и установленное Chrome PWA.

## Результат аудита

Pipeline уже имеет полезную fail-closed основу: получатели обрабатываются последовательно, повторный batch блокируется, Send не считается успехом сам по себе, а неоднозначный post-Send результат получает статус `unknown` и не становится retryable. Поддержка `text`, `photo` и `photo + caption` проходит через отдельные adapters.

Главная подтверждённая race condition находилась в общей DOM-сигнализации. `TelegramChatNavigator` и `TelegramSendAdapter` ожидают изменения `data-peer-id`, `data-mid` и класса `.sending`, но общий `MutationObserver` слушал только `childList`. Telegram Web K часто переиспользует существующие DOM-узлы и меняет только атрибут. В таком случае состояние уже становилось готовым, но pipeline не вызывал повторную проверку и доходил до timeout. Ручное открытие чата создавало дополнительные DOM-мутации и случайно «проталкивало» операцию.

Минимальный foundation исправлен: observer теперь слушает ограниченный набор значимых атрибутов (`class`, `data-peer-id`, `data-mid`, `disabled`, `aria-disabled`) и сохраняет microtask batching. Добавлены regression tests для reused composer, снятия `.sending` и позднего назначения `data-mid`.

Это устраняет один подтверждённый источник поведения «через раз», но не делает delivery полностью детерминированным: navigation по-прежнему зависит от загруженной видимой строки, composer не имеет stability/visibility handshake, draft/source restoration отсутствуют, а recoverable failure останавливает batch до ручного Retry.

## Текущая архитектура

```text
CleanForwardController
  → MessageExtractor
  → PendingTransfer
  → RecipientPickerController
      → TelegramRecipientSourceAdapter
      → RecipientPicker
      → DeliveryCoordinator
          → DeliveryBatch
          → TelegramChatNavigator
          → ComposerAdapter
              → TelegramDomAdapter                 (text)
              → MediaModeActivator                 (photo mode)
              → UploadPreviewAdapter               (photo/caption)
          → TelegramSendAdapter
          → DeliveryProgressPanel
```

`DeliveryBatch` сейчас моделирует только per-recipient статусы:

```text
pending → navigating → preparing → sending → sent
                    ↘ failed      ↘ unknown
```

Статусы `failed` разрешены только до Send. После вызова native Send возможны только `sent` или `unknown`; это сохраняет защиту от дубликатов.

## Target state machine против текущей реализации

В таблице `—` означает, что отдельного перехода в текущем коде нет.

| Переход | Preconditions сейчас | Success condition сейчас | Timeout | Recoverable failure | Terminal failure |
|---|---|---|---|---|---|
| `idle → resolve recipient` | `PendingTransfer` содержит payload; нет активной insertion | После одного rAF найден активный virtual chatlist и хотя бы одна валидная строка | Отдельного timeout нет; ожидание ровно одного rAF | Picker показывает ошибку; payload остаётся | Abort закрытия сессии |
| `resolve recipient → navigate` | Выбран ≥1 поддерживаемый peer; `DeliveryCoordinator` свободен; payload атомарно переведён в `inserting` | Создан immutable `DeliveryBatch`, picker закрыт | Нет | `start()` вернул `null`, picker открывается снова | Нет |
| `navigate → validate peer` | Нет Forward popup/media preview/`.sending`; в активном virtual list есть точная строка `data-peer-id`; строка не forum/sponsored | После synthetic `mousedown` найден composer с ожидаемым `data-peer-id` | 5 s | `failed`, payload остаётся retryable | Нет до Send |
| `validate peer → acquire composer` | В документе ровно один `.input-message-input[contenteditable][data-peer-id]` | Peer совпал, composer пуст, видимого `.reply-wrapper` нет | Включён в те же 5 s | `failed` | Нет |
| `acquire composer → preserve draft` | Composer принадлежит ожидаемому peer | `ComposerDraftTransaction` снял snapshot и освободил composer | Нет | `failed` до Send | Неподтверждённое restore → safety failure |
| `preserve draft → prepare payload` | Composer считается чистым и принадлежит peer | Text точно прочитан обратно; либо готов один blob preview и проверена caption | Media arm 2 s; popup 5 s; preview 10 s; caption 2 s | Cleanup подготовленного text/preview; `failed` | Preview, который не удалось закрыть, оставляет ручную очистку |
| `prepare payload → send` | Peer всё ещё активен; payload совпадает; нет reply/forward draft; ровно одна enabled Send button | Confirmation wait вооружён, затем callback помечает irreversible boundary и вызывается `button.click()` | Отдельного timeout нет | Ошибка до boundary → `failed` | Любая неоднозначность после boundary → `unknown` |
| `send → confirm` | Send boundary пересечён; сохранён baseline outgoing `data-mid` | Появилась ровно одна новая `.bubble.is-out[data-mid][data-peer-id=peer]`, её mid уже не временный (не дробный) и на бабле нет `is-outgoing`/`is-sending`/`.sending` | 12 s, но пока отправка наблюдаемо идёт — до 5 min | Нет: post-Send retry запрещён | Timeout, смена active peer, >1 новая bubble, `is-error` → `unknown` |
| `confirm → restore draft` | Попытка recipient завершена любым исходом | Draft прочитан обратно и совпал | Нет | Нет: restore выполняется в `finally` | Неподтверждённое restore → safety failure |
| `restore draft → next recipient` | Предыдущий recipient имеет `sent`; cancel не запрошен | `nextPending()` возвращает следующего и цикл повторяется | Нет | Любой pre-Send `failed` сейчас останавливает весь batch | `unknown` останавливает batch и уничтожает retryable payload |
| `next recipient → restore source chat` | Batch завершён любым terminal outcome | Exact peer proof исходного чата через owned composer | Тот же navigation timeout | Нет: выполняется в `finally` | Неподтверждённый возврат → safety failure |
| `restore source chat → done` | Нет pending/unknown либо batch остановлен | `PendingTransfer.completeInsertion()` и summary panel | Нет | При `failed/pending` payload возвращается в ready и ждёт ручной Retry | `unknown` очищает payload для защиты от дубликата |

## Найденные race conditions и fragile assumptions

### P0 — непосредственно влияет на нестабильную доставку

1. **Attribute-only DOM transitions не наблюдались.** Исправлено в этом шаге. Смена `data-peer-id`, поздний `data-mid` и снятие `.sending` могли не запустить `notifyDomChanged()`.
2. **Navigation зависит от одной уже загруженной строки.** И source, и navigator ищут только `.tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist > a.row...`. Свернутый sidebar PWA, Telegram search/filter, virtualized-out row или замена списка дают немедленный pre-Send failure.
3. **Навигация основана на одном synthetic `mousedown`.** Предполагается, что Telegram продолжает открывать row capture-phase обработчиком `mousedown` и не требует trusted pointer/click sequence. Изменение Telegram может сделать событие no-op.
4. **Composer принимается без visibility/stability handshake.** Достаточно ровно одного подходящего DOM-узла и совпадения `data-peer-id`. Не проверяются видимость chat container, active dialog row, route, наличие/готовность Send control и устойчивость peer хотя бы через два наблюдения.
5. **Send boundary фиксируется до `button.click()`.** Это правильно для duplicate protection, но если synthetic click не принят Telegram, результат неизбежно становится `unknown`; безопасного автоматического retry уже нет.
6. **Confirmation не коррелирует bubble с payload.** Проверяется новый peer-scoped `data-mid` и отсутствие `.sending`, но другое исходящее сообщение в тот же peer может быть принято за результат текущего Send. Одновременно появившиеся две bubble корректно дают `unknown`.

### P1 — ломает автономность и восстановление

7. **Recipient source ждёт ровно один `requestAnimationFrame`.** Нет predicate «active list стабилен и rows загружены» и нет timeout/observer handshake. В background tab/PWA кадр может быть throttled.
8. **Preview/caption waits зависят от rAF polling.** У них есть state predicates и верхние timeout, то есть это не blind sleep, но background/minimized Chrome может замедлить rAF сильнее timeout.
9. **Text insertion зависит от focus и `document.execCommand`.** `nativeTextEditing` принудительно фокусирует composer и предполагает, что selection/execCommand работают в текущем Chrome document. Результат проверяется, поэтому failure остаётся pre-Send, но focus может быть перехвачен Telegram modal/PWA window state.
10. ~~**Draft preservation отсутствует.**~~ **Исправлено.** `ComposerDraftTransaction` снимает snapshot, освобождает composer и восстанавливает draft после попытки; неподтверждённое восстановление становится safety failure.
11. ~~**Source chat restoration отсутствует.**~~ **Исправлено.** `DeliveryCoordinator.restoreSourceChat()` выполняется в `finally` после любого terminal outcome и требует exact peer proof.
12. ~~**Recoverable failure требует ручного Retry.**~~ **Исправлено.** `DeliveryRetryPolicy` даёт bounded automatic retry, разрешённый только до Send; ручной Retry остаётся для терминальных pre-Send отказов.
13. **Cleanup preview иногда требует ручного действия.** Если scoped close не закрывает preview, ошибка прямо просит закрыть его вручную. Это допустимый аварийный fail-closed исход, но не нормальный автономный pipeline.
14. **Media mode ищется по английскому тексту `Photo or Video`.** В другой локали photo preparation не стартует.

### P2 — хрупкость интерфейса, не доказательство доставки

15. Picker намеренно управляет focus внутри Shadow DOM. Это влияет на modal UX/Escape, но recipient state хранится контроллером и не зависит от focus.
16. Context-menu geometry использует два rAF после поздней вставки. Это не delivery sequencing и перед коррекцией каждый раз проверяет актуальный active menu.
17. ~~Image extraction использует `fetch(imageUrl)` без AbortSignal/timeout.~~ **Частично исправлено.** Capture получает `AbortSignal` сессии из `CleanForwardController`, поэтому отмена прерывает и загрузку фото, и постраничное чтение видео. Собственного timeout у чтения по-прежнему нет: границей остаются общий размер из `Content-Range` и `MAX_RANGE_REQUESTS`, а Send до завершения захвата всё равно невозможен.

## Аудит таймеров и кадров

- `TelegramChatNavigator`: `setTimeout(5000)` — только верхняя граница state wait, не fixed delay.
- `TelegramSendAdapter`: `setTimeout(12000)` — верхняя граница подтверждения, Send click не считается успехом.
- `waitForCondition`: повторный predicate каждый rAF + timeout; state-aware, но чувствителен к background throttling.
- `TelegramRecipientSourceAdapter`: один rAF без readiness predicate — fragile.
- `TelegramContextMenuIntegration`: два rAF для измерения layout; за пределами delivery.
- Произвольных `setTimeout(... продолжить pipeline ...)` без последующей проверки состояния в production delivery не найдено.

## Что уже покрывает duplicate protection

- `PendingTransfer.beginInsertion()` атомарно блокирует повторный запуск payload.
- `DeliveryCoordinator.start()` не запускает второй batch.
- `DeliveryBatch.markFailed()` запрещает retry после Send boundary.
- `unknown` очищает pending payload и останавливает batch.
- Следующий recipient не начинается до подтверждения предыдущего.
- Один recipient получает не более одного вызова Send в одном run; sent recipient не возвращается в retry.
- Send success требует нового outgoing `data-mid`, а не только click/закрытие preview.
- Send success означает identity, выданную сервером, а не optimistic bubble Web K. Пока mid
  временный (дробный) или бабл несёт `is-outgoing`/`is-sending`, следующий item не отправляется:
  иначе Telegram нумерует одновременно загружаемые сообщения по скорости upload и bundle приходит
  в перепутанном порядке.

- Одна группа — одно сообщение. Альбом подтверждается как одна новая identity, а не как число
  совпавших узлов; несколько отдельных сообщений после одного Send по-прежнему дают `unknown`.

Эти правила при последующих исправлениях ослаблять нельзя.

## Regression tests этого шага

1. `observeDom` сообщает attribute-only изменения `class`, `data-peer-id`, `data-mid` и по-прежнему схлопывает burst в один callback.
2. Navigator завершается успешно, когда Telegram переиспользует существующий composer и меняет только `data-peer-id`.
3. Send confirmation завершается после снятия только класса `.sending`, без ручного `notifyDomChanged()`.
4. Send confirmation завершается, когда `data-mid` назначается уже существующему outgoing node позднее.

Ранее существующие tests уже подтверждают: mismatch peer, non-empty composer, reply/forward draft, active preview, `.sending` blocker, navigation timeout, Send timeout → `unknown`, active chat change after Send → `unknown`, sequential recipients и отсутствие duplicate retry.

## Минимальный foundation, добавленный сейчас

Изменён только механизм общей DOM-сигнализации. Observer по-прежнему один, callback batched через microtask, а attribute filter узкий. Delivery orchestration, Send semantics, text/photo/photo+caption adapters и статусы duplicate protection не менялись.

## Что исправлять следующим шагом

Выполнено с момента аудита:

2. ✅ `navigate` и `acquire composer` разделены: navigation проходит `resolve → address → initiate → observe → exact peer → owned composer → stabilize → cleanup → final proof`.
4. ✅ Owned draft snapshot/restore и восстановление source chat выполняются в `finally`, отдельно от Send result.
5. ✅ Bounded automatic retry разрешён только до Send; post-Send `unknown` не повторяется.

Остаётся:

1. Ввести immutable `DeliveryTransactionContext`: source peer, target peer, payload identity, source/target draft snapshots и текущая явная phase.
3. Заменить single-rAF recipient loading на abortable state wait с timeout и MutationObserver/rAF fallback, пригодный для PWA/sidebar transitions. `TelegramRecipientSourceAdapter` по-прежнему использует одиночный `requestAnimationFrame` без readiness predicate.
6. Усилить confirmation корреляцией с подготовленным payload, не используя Send click как success.

До выполнения пунктов 1 и 3 не следует добавлять новые типы сообщений.

## P0 браузерного контракта: verification против собственной вставки

Найдено 2026-08-17, отдельный класс дефекта — предположение не о Telegram, а о браузере.

`readTelegramText` знал только `<br>`, а Chrome записывает результат `execCommand("insertText")` как
отдельный блок `<div>` на строку. Поэтому проверка «вставленное совпадает с подготовленным» не могла
выполниться ни для одного многострочного значения: подпись и текст падали по timeout, а сам Telegram
прочитал бы эти блоки корректно (`BLOCK_TAGS` в `getRichElementValue.ts`). Fail-closed срабатывал на
ложном несовпадении и блокировал корректную отправку; многострочный draft получателя мог довести до
safety stop при восстановлении.

Suite этого не ловил структурно: мок `document.execCommand` присваивал `textContent`, то есть
round-trip проверялся против выдуманной разметки. Один тест прямо фиксировал сломанный вывод как
ожидаемый.

Вывод для дальнейшей работы: **любую верификацию собственной вставки нужно проверять на реальном
выводе браузера, а не на фикстуре, построенной по тому же предположению, что и код.** Ровно то же
правило уже действует для DOM-контракта Telegram, но здесь источником истины является Chrome.
Текущие фикстуры `tests/telegram/read-telegram-text.test.ts` сняты с реального `innerHTML`.

## Побочный эффект хранилища при чтении медиа

Найдено 2026-08-18. Третий класс дефекта: не Telegram DOM и не браузер, а **цена, которую операция
userscript перекладывает на сам Telegram**.

Полные байты видео нельзя получить обычным `fetch`: Web K отдаёт поток своим service worker, который
на любой запрос отвечает `206 Partial Content`. Чтение по диапазонам — единственный способ доказать
полноту копии. Но тот же service worker сохраняет **каждый** выданный чанк в CacheStorage
`cachedStreamChunks` и дополнительно читает 20 МБ вперёд (`src/lib/serviceWorker/stream.ts` в
исходниках Web K). Обычный просмотр кэширует только просмотренную часть; чтение целого файла ради
копии оставляет в кэше файл целиком — в том же origin, где Telegram хранит свою сессию и state.
Достаточно нескольких больших видео, чтобы origin упёрся в квоту, и тогда сбоит Telegram, а не
userscript.

Исправление в `src/telegram/fetchMediaBytes.ts` состоит из двух частей:

- **до чтения** — `requireStorageHeadroom()` сверяет `navigator.storage.estimate()` и отклоняет
  захват, если размер файла плюс preload-окно плюс запас не помещаются в свободное место.
  Недоступная оценка отказом не считается: иначе захват был бы невозможен там, где браузер её не
  сообщает;
- **после чтения** — `releaseCachedStreamChunks()` в `finally` удаляет из `cachedStreamChunks`
  ровно те записи, которые относятся к прочитанному документу. Удаление безопасно по построению:
  это кэш, и Web K заново скачивает отсутствующий чанк. Ошибка уборки не проваливает уже корректный
  захват.

Контракт сверен с исходным кодом Telegram Web K. Связь с белым экраном Web K, который наблюдал
пользователь, **не доказана**: устранён подтверждённый побочный эффект, а не подтверждённая причина.

Вывод для дальнейшей работы: **любое чтение через инфраструктуру Telegram нужно оценивать не только
по результату, но и по состоянию, которое оно оставляет в origin Telegram.** Правило распространяется
на все будущие media strategies (document, audio, album), которые пойдут тем же путём.

## Альбом — это одно сообщение, а не N узлов

Найдено 2026-08-25, сразу после включения capture альбомов
([docs/album-model-bridge-plan.md](album-model-bridge-plan.md)). Четвёртый класс дефекта: правило
подтверждения было верным, но считало не ту единицу.

Успешно доставленный альбом объявлялся результатом `unknown`. На панели —
`Отправлено: 0 · Ошибки: 0 · Неизвестно: 1` и «После одного Send появилось несколько исходящих
сообщений», при том что альбом лежал в чате получателя целым. Батч останавливался, а повтор был уже
запрещён — то есть корректная доставка выглядела как худший из возможных исходов.

Причина: `findNewOutgoing()` считал **узлы**, совпавшие с селектором. Web K вешает `data-mid` и на
бабл альбома (это mid главного сообщения группы), и на каждый `.grouped-item`, поэтому альбом из N
фотографий выглядел как N + 1 исходящих сообщений после одного Send. Проверка «после Send появилось
ровно одно новое сообщение» срабатывала правильно по своей формулировке и неправильно по единице
измерения.

Исправление: identity схлопываются по `data-mid`, и при совпадении остаётся `.grouped-item` — узел,
которому Web K переписывает mid отдельно на подтверждение каждой фотографии, то есть более точный
индикатор серверной identity. Бабл, чей mid не принадлежит ни одному его собственному элементу,
по-прежнему считается отдельным сообщением: это и есть случай, ради которого проверка существует, и
ослаблять его было нельзя.

Вывод для дальнейшей работы: **проверка количества обязана считать сущности предметной области
(сообщения), а не совпадения селектора (узлы).** Тот же вопрос нужно задавать каждой будущей media
strategy: сколько узлов Web K нарисует на одно сообщение и какой из них несёт серверную identity.
## Право читать перепутано с правом писать

Найдено 2026-08-19 и 2026-08-26, двумя половинами одного корня. Пятый класс дефекта: проверка
доказывала не то, что ей было нужно, а то, что оказалось под рукой.

Единственным доказательством «мы находимся в этом чате» служил редактируемый узел ввода
`.input-message-input[contenteditable="true"][data-peer-id]`. Для получателя это правильно: туда
сразу пишут draft, вставляют текст и жмут native Send, поэтому чат без пригодного к записи composer
обязан отказать на навигации, где причина ещё понятна. Но тем же доказательством пользовались две
операции, которым писать не нужно вообще, — и у broadcast-канала такого узла нет по определению.

| Операция | Что ломалось | Когда |
|---|---|---|
| Возврат в исходный чат | Доказательство недостижимо → все попытки в таймаут → батч завершался красной «Остановкой безопасности» при уже открытом канале и уже успешной доставке | 2026-08-19 |
| Чтение источника | Identity источника не резолвилась → пункт «Отправить как новые» не появлялся в канале вовсе, хотя мультивыделение и нативный тулбар работали | 2026-08-26 |

Захват поста из канала — основной сценарий инструмента, и как получатель read-only peer отсекался
`TelegramPeerEligibility`, а как источник не отсекался ничем: он просто молча не работал.

Исправление в обоих случаях одно: принять второе доказательство — тот же узел ввода, но
нередактируемый. Web K строит поле ввода для любого чата и в `ChatInput.finishPeerChange` сначала
ставит `contentEditable = 'false'`, если писать нельзя, и только потом пишет
`messageInput.dataset.peerId`. Значит прочитанный там peer означает «переход в этот чат завершён», а
чат в середине перехода всё ещё показывает предыдущий peer и доказательством не станет.

Требования вокруг не ослаблены: ровно один активный `.chat`, ровно один принадлежащий ему контейнер,
единственный узел ввода в шелле, независимое подтверждение через активную строку списка или
`.topbar .person-avatar[data-peer-id]`, три стабильных опроса подряд. Ослабление применено **только**
к чтению и к `intent === "source-restore"`; для destination-навигации не изменилось ничего, а запись
(`beginDraftTransaction`, `insertTextIntoComposer`, `clearPreparedText`, восстановление draft)
по-прежнему требует редактируемый composer.

У того же корня была тихая половина: при `selection === null` пункт контекстного меню уходил в
одиночную ветку, то есть в канале отправил бы **одно** долгонажатое сообщение там, где меню Telegram
означает весь выделенный набор. Отказ был заметен сразу, а это — нет.

Вывод для дальнейшей работы: **проверка обязана доказывать своё собственное предусловие, а не
ближайшее удобное.** «Мы в этом чате», «сюда можно писать» и «этот чат наш» — три разных
утверждения, и связывать их в одно можно только там, где нужны все три.
