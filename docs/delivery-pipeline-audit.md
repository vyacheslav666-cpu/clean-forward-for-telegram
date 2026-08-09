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
| `acquire composer → preserve draft` | — | — | — | Текущий код не сохраняет draft: непустой composer просто блокирует операцию | — |
| `preserve draft → prepare payload` | Composer считается чистым и принадлежит peer | Text точно прочитан обратно; либо готов один blob preview и проверена caption | Media arm 2 s; popup 5 s; preview 10 s; caption 2 s | Cleanup подготовленного text/preview; `failed` | Preview, который не удалось закрыть, оставляет ручную очистку |
| `prepare payload → send` | Peer всё ещё активен; payload совпадает; нет reply/forward draft; ровно одна enabled Send button | Confirmation wait вооружён, затем callback помечает irreversible boundary и вызывается `button.click()` | Отдельного timeout нет | Ошибка до boundary → `failed` | Любая неоднозначность после boundary → `unknown` |
| `send → confirm` | Send boundary пересечён; сохранён baseline outgoing `data-mid` | Появилась ровно одна новая `.bubble.is-out[data-mid][data-peer-id=peer]`, на ней/в ней нет `.sending` | 12 s | Нет: post-Send retry запрещён | Timeout, смена active peer, >1 новая bubble → `unknown` |
| `confirm → restore draft` | — | — | — | Не реализовано | — |
| `restore draft → next recipient` | Предыдущий recipient имеет `sent`; cancel не запрошен | `nextPending()` возвращает следующего и цикл повторяется | Нет | Любой pre-Send `failed` сейчас останавливает весь batch | `unknown` останавливает batch и уничтожает retryable payload |
| `next recipient → restore source chat` | — | — | — | Не реализовано; UI остаётся в последнем destination chat | — |
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
10. **Draft preservation отсутствует.** Непустой target composer или видимый reply/forward draft блокирует доставку. Snapshot, очистка с ownership token и restore не реализованы.
11. **Source chat restoration отсутствует.** После batch пользователь остаётся в последнем destination chat.
12. **Recoverable failure требует ручного Retry.** `DeliveryCoordinator` останавливает batch после первого pre-Send failure, а `DeliveryProgressPanel` показывает «Повторить оставшиеся». Это противоречит требованию, что Retry не должен быть обязательной частью нормального pipeline.
13. **Cleanup preview иногда требует ручного действия.** Если scoped close не закрывает preview, ошибка прямо просит закрыть его вручную. Это допустимый аварийный fail-closed исход, но не нормальный автономный pipeline.
14. **Media mode ищется по английскому тексту `Photo or Video`.** В другой локали photo preparation не стартует.

### P2 — хрупкость интерфейса, не доказательство доставки

15. Picker намеренно управляет focus внутри Shadow DOM. Это влияет на modal UX/Escape, но recipient state хранится контроллером и не зависит от focus.
16. Context-menu geometry использует два rAF после поздней вставки. Это не delivery sequencing и перед коррекцией каждый раз проверяет актуальный active menu.
17. Image extraction использует `fetch(imageUrl)` без AbortSignal/timeout. Медленная загрузка может оставить pre-picker capture дольше ожидаемого, хотя Send ещё невозможен.

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

Следующий P0 должен быть отдельным небольшим изменением вокруг navigation/composer acquisition:

1. Ввести immutable `DeliveryTransactionContext`: source peer, target peer, payload identity, source/target draft snapshots и текущая явная phase.
2. Разделить `navigate` и `acquire composer`: ждать active list/row по predicate, проверить connected/visible row, выполнить поддерживаемую UI event sequence, затем требовать устойчивый target composer и target Send control.
3. Заменить single-rAF recipient loading на abortable state wait с timeout и MutationObserver/rAF fallback, пригодный для PWA/sidebar transitions.
4. Добавить owned draft snapshot/restore и обязательное восстановление source chat в `finally` — отдельно от Send result.
5. После этого добавить bounded automatic retry только для доказанно pre-Send фаз. Post-Send `unknown` по-прежнему никогда не повторять.
6. Усилить confirmation корреляцией с подготовленным payload, не используя Send click как success.

До выполнения пунктов 1–4 не следует добавлять новые типы сообщений.
