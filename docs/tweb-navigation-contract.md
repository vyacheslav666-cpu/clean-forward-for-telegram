# Telegram Web K navigation contract

Research baseline: official upstream `morethanwords/tweb`, commit
[`e3730e10073c3fc02e1360e3513b70b176d6afec`](https://github.com/morethanwords/tweb/commit/e3730e10073c3fc02e1360e3513b70b176d6afec), inspected 2026-08-12.

## Identity and activation

- Recipient identity is the exact string in `row.dataset.peerId`; title, username and URL are locator hints, not identity proof.
- TWeb dialog lists navigate from a capture-phase `mousedown`; DOM `row.click()` alone is not equivalent. A browser automation click works because it emits the full mouse sequence.
- Autonomous search rows legitimately have no `href`.
- Rows carrying `data-mid`, `data-thread-id` or `data-monoforum-parent-peer-id` represent a richer destination tuple and are rejected by the P0 simple-peer flow.
- `#/im?p=<peerKey>` is a supported public route for initiating a fallback transition. TWeb may normalize the hash to `#@username`, so route text cannot prove the active peer.

Primary sources:

- [dialog row identity and list activation](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/lib/appDialogsManager.ts#L1968-L2187)
- [autonomous search rows](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/searchGroup.tsx#L13-L35)
- [public route parsing](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/lib/appImManager.ts#L1812-L1922)

## One-shot search lifecycle

Search groups are destroyed/rebuilt per query. Closing search schedules destruction and `replaceChildren()` after roughly 150 ms. Code must never retain a Telegram-owned result node across a retry, and the next recipient must wait until cleanup is acknowledged.

Primary sources:

- [sidebar close/search teardown](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/sidebarLeft/index.ts#L1395-L1509)
- [search group cleanup](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/searchGroup.tsx#L142-L150)

## Authoritative readiness proof

The accepted composer must be owned by exactly one active main chat:

```text
#column-center > .chats-container > .chat.tabs-tab.active
  > .chat-input.chat-input-main
  .input-message-input[contenteditable="true"][data-peer-id="<expected>"]
```

Old chats can remain mounted. Global “exactly one composer in document” is therefore not a valid production rule. TWeb assigns the editor `data-peer-id` after the asynchronous peer/input transition remains current; that scoped value is the strongest available DOM proof. The proof is repeated after search teardown and again by the preparation/Send adapters before side effects.

Primary sources:

- [active chat ownership](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/lib/appImManager.ts#L2501-L2540)
- [composer owner construction](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/chat.ts#L608-L647)
- [peer-scoped editor readiness](https://github.com/morethanwords/tweb/blob/e3730e10073c3fc02e1360e3513b70b176d6afec/src/components/chat/input.ts#L2399-L2680)

## Implemented transaction

```text
resolve target
→ make addressable (recent/search, then public route fallback)
→ native mousedown / route initiation
→ observe transition
→ prove exact peer
→ prove active-chat composer ownership and blockers
→ semantic stabilization
→ release owned search and wait for teardown
→ final exact peer/composer proof
→ success
```

Every bounded retry restarts from resolution with fresh DOM. Source restore calls the same navigator with the immutable captured source peer. Mismatch or ambiguous composer state fails closed before Send.
