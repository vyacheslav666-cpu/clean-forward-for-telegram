/**
 * The only place in this project that reads Telegram's private in-page API.
 *
 * It exists for one question the DOM cannot answer: does this message belong to an album, and how
 * many items does that album have? A bubble shows that an element is grouped, but never the
 * `grouped_id` and never how many members the group really has — so capture could either guess or
 * refuse, and it refused.
 *
 * `apiManagerProxy` is reachable because upstream mounts it on `window` unconditionally
 * (`MOUNT_CLASS_TO = DEBUG || true ? ctx : {}`, `config/debug.ts`; `apiManagerProxy.ts:1441`) and
 * this userscript runs in the page realm with `@grant none`. That is an accident of upstream's
 * build, not a contract: it is unversioned, unannounced, and can vanish in any deploy. Everything
 * here is therefore written to lose that race quietly — see {@link resolveMessageGroup}.
 *
 * The two reads used are synchronous mirror lookups, not network calls: `getMessageByPeer` reads a
 * message storage (`apiManagerProxy.ts:1222`) and `getMessagesByGroupedId` reads
 * `mirrors.groupedMessages` (`apiManagerProxy.ts:1197`). For an album already painted on screen the
 * mirror is necessarily populated, because upstream renders a group whole rather than in pieces
 * (`bubbles.ts:6877`).
 *
 * Scope is deliberately narrow: proving group membership only. Bytes still come from the DOM, the
 * same way a single photo already works, so this module never has to model every media family.
 */

/** Proven album membership, reduced to primitives before it leaves this module. */
export interface ResolvedGroup {
  readonly groupedId: string;
  readonly expectedItemCount: number;
}

/** The shape this module is willing to read off a Telegram message; everything else is ignored. */
interface TelegramMessageLike {
  readonly mid?: unknown;
  readonly peerId?: unknown;
  readonly grouped_id?: unknown;
}

/**
 * Resolves the album a message belongs to, or returns null when that cannot be proven.
 *
 * Never throws and never caches whether the bridge exists: Telegram updates underneath an open tab,
 * so a capability proven one minute ago says nothing about this call. Every failure — no API, no
 * method, a throwing method, an unexpected shape, an identity that does not match what was asked
 * for — collapses into the same null, which leaves the caller with exactly the behaviour it had
 * before this module existed.
 */
export function resolveMessageGroup(peerKey: string, mid: number): ResolvedGroup | null {
  try {
    const peerId = Number(peerKey);
    if (!peerKey.trim() || !Number.isFinite(peerId) || !Number.isSafeInteger(mid)) {
      return null;
    }

    const proxy = readProxy();
    if (!proxy) {
      return null;
    }

    const message = callMethod<TelegramMessageLike>(proxy, "getMessageByPeer", peerId, mid);
    // A storage miss is normal, not an error: the message may simply not be mirrored yet.
    if (!isObject(message) || !identityMatches(message, peerKey, mid)) {
      return null;
    }

    const groupedId = readGroupedId(message);
    if (groupedId === null) {
      return null;
    }

    const members = callMethod<unknown>(proxy, "getMessagesByGroupedId", groupedId);
    if (!Array.isArray(members) || members.length < 2) {
      return null;
    }
    // `getMessagesByGroupedId` maps mids through a storage that can miss, so a hole would silently
    // shrink the album. Requiring every member to be a real message keeps `expectedItemCount` a
    // count of proven items rather than of array slots.
    if (!members.every((member) => isObject(member) && readGroupedId(member) === groupedId)) {
      return null;
    }
    // The requested message must be inside the group it claims to belong to.
    if (!members.some((member) => midOf(member) === mid)) {
      return null;
    }

    return { groupedId, expectedItemCount: members.length };
  } catch {
    // Reaching a private API is the whole point of this module, so any throw it produces is
    // expected input, not an incident: it means the assumption no longer holds.
    return null;
  }
}

function readProxy(): Record<string, unknown> | null {
  const candidate = (globalThis as Record<string, unknown>)["apiManagerProxy"];
  return isObject(candidate) ? candidate : null;
}

function callMethod<T>(
  proxy: Record<string, unknown>,
  name: string,
  ...args: unknown[]
): T | null {
  const method = proxy[name];
  if (typeof method !== "function") {
    return null;
  }
  return (method as (...values: unknown[]) => T).apply(proxy, args) ?? null;
}

function identityMatches(message: TelegramMessageLike, peerKey: string, mid: number): boolean {
  return midOf(message) === mid && String(message.peerId ?? "") === peerKey;
}

function midOf(message: TelegramMessageLike): number | null {
  return typeof message.mid === "number" && Number.isSafeInteger(message.mid) ? message.mid : null;
}

/**
 * Reads `grouped_id` as a string without ever going through a number.
 *
 * It is a 64-bit id in the schema, so parsing it would start losing precision above 2^53 and two
 * different albums could compare equal.
 */
function readGroupedId(message: TelegramMessageLike): string | null {
  const raw = message.grouped_id;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const groupedId = String(raw).trim();
  return groupedId && groupedId !== "0" ? groupedId : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
