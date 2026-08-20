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

### When the peer has no composer at all

A broadcast channel is the normal source of this tool, and there the proof above is unreachable by
construction: Web K shows an Unmute/Join control instead of an input, so nothing matches
`[contenteditable="true"]`. The identity is still published on the same node — `ChatInput.finishPeerChange`
sets `contentEditable = 'false'` for a peer that cannot be posted to and *then* writes
`messageInput.dataset.peerId`. A chat still switching therefore carries the previous peer id, which
is what keeps the weaker read valid.

Source restore alone may accept that node (`.input-message-input[data-peer-id]:not([contenteditable="true"])`),
under the same scoping as the strict proof plus the independent active-peer evidence. Destination
navigation keeps requiring a writable composer, because everything after it writes into one.

Primary sources:

- [read-only input state and peer binding](https://github.com/morethanwords/tweb/blob/master/src/components/chat/input.ts) (`finishPeerChange`: `updateMessageInput` → `messageInput.dataset.peerId`)
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

## Machine-checked token inventory

The prose above is verified by hand at one pinned commit; upstream keeps moving. Three files turn
the parts that can be checked automatically into a check:

- `src/telegram/domContract.ts` — every Telegram-owned selector the code uses, in one module.
  Project-owned markers (`data-clean-forward-*`) are deliberately not here.
- `contracts/tweb-dom-contract.json` — the atomic tokens those selectors are built from, each with
  a status: `required` (must exist upstream), `legacy` (kept for older builds), `dynamic` (upstream
  composes the name at runtime, so a literal search cannot prove it — the note says where).
- `scripts/check-tweb-contract.mjs` (`npm run check:tweb`) — downloads upstream sources at a ref and
  reports every `required` token that no longer exists. The `Telegram DOM contract` workflow runs it
  weekly and on any pull request that touches the contract.

`tests/telegram/dom-contract.test.ts` closes the loop offline: a selector written straight into an
adapter fails the suite unless its tokens are declared, so nothing can escape the upstream check by
never being written down.

### What this does not prove

Only existence, never structure. A class that survives a refactor but moves to a different node
still passes, and so does a selector whose ancestor chain no longer holds. Composed names
(`'search-group-' + type`) are skipped outright. Treat a green run as “no token disappeared”, not as
“the DOM contract still holds”; the manual checks in the README stay necessary.
