# План: включить capture фото-альбомов через read-only model bridge

Статус: **реализовано 2026-08-25.** Составлен 2026-08-20 по результатам
[docs/tweb-contract-audit.md](tweb-contract-audit.md); документ сохранён как источник истины по
задаче — здесь разобрано, почему альбомы не работали и почему выбран именно гибрид «группа из
модели, байты из DOM».

Что получилось на выходе: [`src/telegram/TelegramModelBridge.ts`](../src/telegram/TelegramModelBridge.ts)
(единственное место, читающее приватный API), [`contracts/tweb-api-contract.json`](../contracts/tweb-api-contract.json)
(символы, которые проверяет `npm run check:tweb`) и первая итерация объёмом 2–10 обычных фото.
Альбомы с видео, GIF и смешанные отклоняются отдельной формулировкой. Одно последствие обнаружилось
уже после включения: подтверждение отправки считало узлы, а не сообщения, и доставленный альбом
объявлялся неизвестным результатом — разбор в
[docs/delivery-pipeline-audit.md](delivery-pipeline-audit.md#альбом--это-одно-сообщение-а-не-n-узлов).

Этот документ — источник истины по задаче «альбомы». Промпт для разработки — в самом конце.

---

## 1. Что сейчас происходит

Пользователь выбирает альбом → получает отказ:

> Clean Forward не может скопировать это сообщение
> Album needs verified grouped_id and complete model membership.

Отказов на самом деле два, на разных путях:

| Путь | Место | Условие |
|---|---|---|
| Контекстное меню одного сообщения | [SourceCaptureService.ts:236-244](../src/telegram/SourceCaptureService.ts:236) | `snapshot.group.kind === "ambiguous-dom"` |
| Selection mode | [TelegramSelectionDomAdapter.ts:141-147](../src/telegram/TelegramSelectionDomAdapter.ts:141) | элемент есть/содержит `GROUPED_MESSAGE_SELECTOR` — ранний выход до чтения снапшотов |

Скриншот от пользователя показывает первый.

### Почему это не баг, а незакрытая ветка

`group.kind` выставляется ровно в одном месте:

```ts
group: grouped ? { kind: "ambiguous-dom" } : { kind: "none" }
```
— [TelegramDomAdapter.ts:260](../src/telegram/TelegramDomAdapter.ts:260)

Снапшот с `identityResolution: "telegram-model"` в `src/` **не создаёт никто** — только тесты
(`tests/telegram/model-source-capture.test.ts:21`, `tests/telegram/source-capture.test.ts:39`).
Единственный живой путь — `dom-fallback`, а он по определению не может дать `complete-model`.

Это зафиксировано в README: «production bootstrap пока не предоставляет verified read-only
Telegram model bridge; document/audio/album strategies не являются production support».

Суть отказа: из DOM видно, что сообщение входит *в какую-то* группу, но не видно `grouped_id`
и не доказано, что видны все её члены. Capture сделан fail-closed и не гадает — это правильно.

### Что уже готово и трогать не надо

Вся машинерия ниже продюсера написана и покрыта тестами:

- [MediaGroupSourceCaptureAdapter](../src/telegram/capture/MediaGroupSourceCaptureAdapter.ts) — атомарная сборка группы 2–10 items;
- `media-group` как transfer unit — [TransferUnit.ts:65](../src/domain/TransferUnit.ts:65), [MessagePayload.ts:354](../src/domain/MessagePayload.ts:354);
- подготовка превью — [ComposerAdapter.ts:229](../src/telegram/ComposerAdapter.ts:229), [UploadPreviewAdapter.ts:344](../src/telegram/UploadPreviewAdapter.ts:344);
- подтверждение отправки по полному набору новых mid в одной группе — [TelegramSendAdapter.ts:405](../src/telegram/TelegramSendAdapter.ts:405) (`hasOneOutgoingGroup`).

**Не хватает только производителя снапшота с доказанной группой.**

---

## 2. Bridge подтверждён живым

Проверено в консоли рабочего `web.telegram.org/k/` 2026-08-20:

```
> typeof apiManagerProxy?.getMessagesByGroupedId
< 'function'
```

Почему он вообще доступен, по исходникам upstream (`master` @ `b21491c`):

- `MOUNT_CLASS_TO = DEBUG || true ? ctx : {}` — то есть **всегда `window`**, и в проде тоже (`src/config/debug.ts:10`);
- `MOUNT_CLASS_TO.apiManagerProxy = apiManagerProxy` (`src/lib/apiManagerProxy.ts:1441`);
- юзерскрипт стоит с `@grant none` ([vite.config.ts:13](../vite.config.ts:13)) → крутится в контексте страницы, без песочницы Tampermonkey;
- имена методов пережили минификацию — доказано консольной проверкой выше.

### Нужная цепочка — синхронная и без сети

```
DOM: data-peer-id + data-mid
  → apiManagerProxy.getMessageByPeer(peerId, mid).grouped_id     // apiManagerProxy.ts:1222
  → apiManagerProxy.getMessagesByGroupedId(grouped_id)           // apiManagerProxy.ts:1197
  → { groupedId, expectedItemCount: mids.length }
```

`getMessagesByGroupedId` читает локальное зеркало `this.mirrors.groupedMessages[groupedId]`
(`apiManagerProxy.ts:1197-1203`) — ни промисов, ни запросов. Для альбома, уже нарисованного на
экране, зеркало заведомо заполнено: tweb рендерит группу целиком, а не по частям —
`groupedMustBeRenderedFull = this.chat.type !== ChatType.Pinned` (`bubbles.ts:6877`), затем
`wrapAlbum({messages: groupedMessages, …})` (`bubbles.ts:8217-8219`).

---

## 3. Решение: гибрид

**Bridge используется только для доказательства группы. Байты остаются из DOM.**

Это осознанный компромисс, а не экономия усилий:

- поверхность зависимости от приватного API сжимается до двух вызовов, которые легко
  feature-detect'ить и обернуть guard'ом;
- не пишется слой маппинга всех медиа-типов, который требует полноценный
  `TelegramModelMessageSnapshot` (`restrictions`, `provenance`, `content` с готовым `Blob` —
  [TelegramSourceSnapshot.ts:110-121](../src/telegram/TelegramSourceSnapshot.ts:110));
- байты фото из DOM уже умеет доставать существующий путь одиночного фото
  ([BinaryMediaSourceCaptureAdapter.ts:66-77](../src/telegram/capture/BinaryMediaSourceCaptureAdapter.ts:66)).

### Почему «просто подставить grouped_id» не сработает

Ветка альбома входит по `group.kind === "complete-model"`
([SourceCaptureService.ts:313](../src/telegram/SourceCaptureService.ts:313)), но тут же
фильтрует членов по `identityResolution === "telegram-model"`
([:320](../src/telegram/SourceCaptureService.ts:320), [:330](../src/telegram/SourceCaptureService.ts:330)).
DOM-снапшот с доказанной группой пролетит первую проверку и получит **пустой** `groupSnapshots`
→ `MediaGroupSourceCaptureAdapter` упадёт с `incomplete-selection`. Поэтому правки нужны и в
роутинге, и в адаптерах.

### Границы первой итерации

Поддерживается: альбом, **все** члены которого — обычные фото, 2–10 items, один peer.

Отклоняется явно и с отдельным текстом (не тем, что сегодня — чтобы было видно, что это
осознанный предел, а не поломка):

- альбом с видео или смешанный photo+video — native `PopupNewMedia.iterate` может разбить его
  на несколько отправок, это отдельная валидация expected groups (`source-message-and-selection-research.md:244`);
- альбом с GIF/animation внутри — upstream отправляет их отдельно (`newMedia.ts:1956-1990`);
- альбом в Pinned-вьюхе — там рендерится только первый элемент (`bubbles.ts:6877`), полнота DOM не гарантирована;
- любые per-item captions с entities — текущая политика и так plain-only;
- bridge недоступен или вернул неполные данные → сегодняшний отказ, дословно.

### Известное ограничение, которое гибрид не лечит

DOM отдаёт картинку того размера, под который свёрстана ячейка альбома, а не оригинал. Это та
же оговорка, что уже действует для одиночного фото. Лечится только полными байтами через
`appDownloadManager`, то есть переходом на полный model bridge — вне этой задачи.

---

## 4. Правки по файлам

### 4.1 Новый модуль — `src/telegram/TelegramModelBridge.ts`

Единственное место в проекте, которое знает о приватном API Telegram. По той же логике, по
которой [domContract.ts](../src/telegram/domContract.ts) — единственное место с селекторами.

Контракт модуля:

```ts
/** Доказанная принадлежность сообщения к альбому, прочитанная из модели Web K. */
export interface ResolvedGroup {
  readonly groupedId: string;
  readonly expectedItemCount: number;
}

/** Возвращает null всегда, когда доказать группу нельзя — по любой причине. */
export function resolveMessageGroup(peerKey: string, mid: number): ResolvedGroup | null;
```

Требования к реализации:

- **fail-closed и не бросает.** Любая неожиданность — нет `window.apiManagerProxy`, нет метода,
  метод бросил, вернул не массив, вернул пустой массив, `grouped_id` пустой — это `null`, а не
  исключение. Отсутствие бриджа обязано деградировать в сегодняшнее поведение;
- **feature-detect на каждом вызове**, не кэшировать «бридж есть». Telegram обновляется под
  ногами прямо во вкладке;
- **никаких мутаций.** Только чтение. Ничего из модели не удерживать: наружу отдаются
  примитивы, а не объекты Telegram — то же правило, что у `TelegramSourceSnapshot`;
- `expectedItemCount` берётся из длины результата `getMessagesByGroupedId`, а `groupedId` —
  строкой как есть, без приведения к числу (в layer это строка);
- сверить `peerKey`/`mid` вернувшегося сообщения с запрошенными; расхождение → `null`.

### 4.2 `src/telegram/TelegramDomAdapter.ts:255-260`

Сейчас:

```ts
const grouped = message.matches(GROUPED_ITEM_SELECTOR) || … ;
// …
group: grouped ? { kind: "ambiguous-dom" } : { kind: "none" },
```

Станет: если `grouped`, спросить бридж. Ответ → `{ kind: "complete-model", groupedId,
expectedItemCount }`. `null` → как сегодня, `ambiguous-dom`.

Новых селекторов не появляется — `contracts/tweb-dom-contract.json` не меняется.

### 4.3 `src/telegram/SourceCaptureService.ts:320` и `:330`

Снять требование `identityResolution === "telegram-model"` при сборе членов группы. Ключом
остаётся `group.kind === "complete-model"` + совпадение `groupedId`. Тип `groupSnapshots`
расширяется до `TelegramSourceSnapshot`.

Preflight на `ambiguous-dom` ([:236-244](../src/telegram/SourceCaptureService.ts:236))
**остаётся нетронутым** — теперь он срабатывает только когда бридж не смог доказать группу.

### 4.4 `src/telegram/capture/MediaGroupSourceCaptureAdapter.ts:20-53`

Принимать членов с `identityResolution: "dom-fallback"`. Сегодняшняя проверка требует у каждого
`content.kind === "binary"` и роль photo/video — для DOM-члена эквивалент: ровно одно фото
(`imageCount === 1 && imageUrl`), нет видео, нет `hasUnsupportedAttachment`.

Сохранить как есть: 2–10 items, contiguous `order`, единый `groupedId`, совпадение
`expectedItemCount`.

### 4.5 `src/telegram/capture/BinaryMediaSourceCaptureAdapter.ts:60`

`snapshot.group.kind !== "none"` → разрешить также `"complete-model"`. Остальные условия
DOM-фото не трогать. Текст ошибки обновить: сейчас он говорит «requires exactly one ordinary
ungrouped image», что перестанет быть правдой.

### 4.6 `src/telegram/TelegramSelectionDomAdapter.ts:141-147`

Убрать ранний безусловный отказ. Grouped-элементы проходят дальше и получают снапшоты как все
остальные; решение о группе принимает бридж внутри `readMessageSnapshot`. Отказ
`group-model-required` сохранить как исход, когда бридж вернул `null`.

Проверка `identities.size !== expectedCount` ([:155](../src/telegram/TelegramSelectionDomAdapter.ts:155))
критична и остаётся: она ловит виртуализованное выделение. Убедиться, что Telegram считает
items альбома отдельными единицами в `selection-container-count` — иначе счёт разъедется.

### 4.7 `scripts/check-tweb-contract.mjs`

Добавить проверку самого бриджа: что `MOUNT_CLASS_TO.apiManagerProxy`, `getMessageByPeer` и
`getMessagesByGroupedId` ещё присутствуют в исходниках upstream. Приватный API не
версионируется и ломается тише, чем CSS-класс — без этой проверки регрессия придёт молча.

Формат — отдельная секция в `contracts/`, чтобы не смешивать DOM-токены с API-символами.

---

## 5. Тесты

Обязательный минимум, все на фикстурах, без сети:

1. `TelegramModelBridge` — нет `window.apiManagerProxy` → `null`; метод бросил → `null`;
   вернул `[]` → `null`; вернул чужой `peerKey`/`mid` → `null`; здоровый случай → корректные
   `groupedId` и `expectedItemCount`.
2. `TelegramDomAdapter` — grouped-сообщение при живом бридже даёт `complete-model`; при
   `null`-бридже даёт `ambiguous-dom` (регрессия на сегодняшнее поведение).
3. `SourceCaptureService` — альбом из 3 DOM-фото с доказанной группой даёт **один**
   `media-group` unit; альбом, где один член не резолвится, отклоняется целиком.
4. `MediaGroupSourceCaptureAdapter` — несовпадение `expectedItemCount` и фактического числа
   выбранных items отклоняется; неконтiguous `order` отклоняется.
5. Selection path — выделение альбома целиком проходит; частичное выделение альбома
   отклоняется (не «тихо расширяется» — скрытое expansion запрещено,
   `source-message-and-selection-research.md:241`).
6. Регрессия: одиночное фото вне альбома по-прежнему capture'ится ровно как раньше.

Перед коммитом — полный `npm run validate`, не только typecheck и один файл.

## 6. Ручная проверка

Только в контролируемых тестовых чатах:

- альбом из 2 фото и из 10 фото → один native Send, полный grouped result у получателя;
- альбом из 3 фото при двух получателях;
- альбом с видео внутри → явный отказ с новым текстом, до recipient picker;
- альбом, открытый в Pinned-вьюхе → отказ;
- source chat одновременно является recipient;
- отмена во время подготовки альбома и сразу после Send click;
- проверить, что при выключенном/сломанном бридже поведение ровно сегодняшнее.

---

## 7. Что обновить в документации после реализации

- [README.md](../README.md) — строка таблицы «Photo/video album» и ограничение про отсутствие
  model bridge; строки про album в «Ручная проверка перед релизом»;
- [docs/tweb-contract-audit.md](tweb-contract-audit.md) — добавить символы бриджа в раздел
  «Селекторы и атрибуты вне domContract.ts»;
- этот файл — сменить статус с «план» на «реализовано» и оставить как обоснование решения.

---

## 8. Промпт для разработки

Скопировать целиком в новый чат.

```text
Проект: Clean Forward for Telegram (Tampermonkey userscript, TypeScript, vitest).
Рабочая папка: корень этого репозитория.

Задача: включить production capture фото-альбомов Telegram через read-only model bridge.

ОБЯЗАТЕЛЬНО ПЕРЕД НАЧАЛОМ прочитай, в этом порядке:

  docs/album-model-bridge-plan.md
      План этой задачи, источник истины. Раздел 4 — правки по файлам, раздел 5 — тесты.

  docs/source-message-and-selection-research.md
      Проектные решения про альбомы, принятые до тебя. Обязательны:
      §2.4  Range selection и albums   — как Telegram расширяет выделение на альбом
      §2.5  Virtualized DOM            — почему нельзя доверять числу отрисованных items
      §3.1  Наблюдаемые DOM-поля       — что честно читается из бабла
      §3.2  Авторитетная Telegram model — какие поля есть в Message.message
      §5    Album/group semantics      — 7 правил, из них п.1 (частичное выделение),
                                         п.2 (полный grouped_id), п.4 (несовместимые типы
                                         рвут группу на несколько sends), п.6 (критерий
                                         успеха), п.7 (после частичного результата повтор
                                         запрещён) — прямые требования к твоему коду
      §10   Stage 4 — albums           — стадия, которую ты закрываешь
      §Implementation status           — что уже сделано на самом деле

  docs/tweb-contract-audit.md
      Сверка каждого селектора с исходниками tweb@b21491c. Раздел «Что сломано прямо
      сейчас» — там есть живой баг в upload preview (п.1), который твой альбом заденет:
      проверка готовности медиа не работает вообще. Чинить его в этой задаче НЕ надо,
      но знать про него обязан — иначе будешь ловить призраков.

  docs/upload-preview-research.md
      §6  Критерий полной готовности preview — как доказывается, что превью готово
      §7  Безопасная отмена                  — что должно произойти при Cancel

  src/telegram/domContract.ts
      Единственное место с селекторами Telegram. Прочитай шапку файла — там правила.

  contracts/tweb-dom-contract.json
      Инвентарь токенов для check:tweb. В этой задаче НЕ меняется.

  CONTRIBUTING.md + README.md
      Правила PR и раздел про поддерживаемые типы/ограничения.

Реализуй ровно то, что описано в разделе 4 плана («Правки по файлам»):
  4.1 новый src/telegram/TelegramModelBridge.ts
  4.2 TelegramDomAdapter.ts:255-260
  4.3 SourceCaptureService.ts:320 и :330
  4.4 capture/MediaGroupSourceCaptureAdapter.ts:20-53
  4.5 capture/BinaryMediaSourceCaptureAdapter.ts:60
  4.6 TelegramSelectionDomAdapter.ts:141-147
  4.7 scripts/check-tweb-contract.mjs

Затем тесты по разделу 5 плана.

Жёсткие правила проекта:
- Селекторы Telegram живут ТОЛЬКО в src/telegram/domContract.ts. В этой задаче новых
  селекторов быть не должно; contracts/tweb-dom-contract.json не меняется.
- Приватный API Telegram (window.apiManagerProxy) допускается ТОЛЬКО внутри нового
  TelegramModelBridge.ts. Нигде больше обращений к нему быть не должно.
- Bridge fail-closed: любая неожиданность возвращает null, функция никогда не бросает.
  Отсутствие бриджа обязано давать РОВНО сегодняшнее поведение — тот же отказ, тот же текст.
  Это регрессионное требование, покрой его тестом.
- Первая итерация — только альбомы из обычных фото. Видео, смешанные, GIF, Pinned-вью
  отклоняются явно и отдельным текстом ошибки, не тем, что сегодня.
- Комментарии и стиль — как в окружающем коде: объясняют ПОЧЕМУ так, а не что делает строка.
- Перед коммитом: npm run validate целиком (typecheck + tests + build), не частями.

Чего НЕ делать:
- Не переходить на полный model bridge с загрузкой байтов через appDownloadManager —
  это отдельная задача, байты в этой итерации берутся из DOM как у одиночного фото.
- Не расширять альбом молча, если пользователь выделил его частично — это запрещено политикой.
- Не коммитить и не пушить без явной просьбы.

Начни с чтения плана и уточни у меня всё, что в нём неоднозначно, ДО написания кода.
```
