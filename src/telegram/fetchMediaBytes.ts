/** Reads complete media bytes out of the browser-owned URLs Telegram renders in a bubble. */

const RANGE_CHUNK_BYTES = 1024 * 1024;
/** Upper bound on round trips so a stalling stream cannot loop until the tab dies. */
const MAX_RANGE_REQUESTS = 4096;
const CONTENT_RANGE_PATTERN = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i;
/**
 * Web K's service worker persists every stream chunk it serves into this CacheStorage and reads
 * 20 MB ahead of each one (`src/lib/serviceWorker/stream.ts`). Reading a whole video therefore
 * costs its full size in storage on the very origin that also holds the Telegram session, so this
 * module both refuses a capture that would not fit and drops what it caused afterwards.
 */
const STREAM_CHUNK_CACHE_NAME = "cachedStreamChunks";
const STREAM_PRELOAD_BYTES = 20 * 1024 * 1024;
const STORAGE_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;
const STREAM_URL_MARKER = "/stream/";

/** Complete in-memory bytes with the MIME type the browser actually served them under. */
export interface FetchedMediaBytes {
  readonly blob: Blob;
  readonly mimeType: string;
}

/** Fails closed on anything that could produce a truncated or unidentifiable upload. */
export class MediaBytesError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaBytesError";
  }
}

/**
 * Assembles the full file behind one media URL.
 *
 * A fully downloaded document is a `blob:` URL and needs one request. A streaming video is served
 * by Telegram's own service worker, which answers every request with `206 Partial Content` and
 * returns only one chunk when no range is asked for — so a plain `fetch` there yields a truncated
 * file that still looks like a valid video. The total size from `Content-Range` is the only proof
 * of completeness available, and an unknown total is therefore rejected rather than guessed.
 */
export async function fetchMediaBytes(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FetchedMediaBytes> {
  if (url.startsWith("blob:")) {
    return readWholeResponse(url, maxBytes, signal);
  }

  const first = await requestRange(url, 0, null, signal);
  if (first.status === 200) {
    // No range support: the one response already carries the whole file.
    return readWholeResponse(url, maxBytes, signal);
  }

  const { totalBytes, mimeType } = describeRange(first);
  if (totalBytes > maxBytes) {
    throw new MediaBytesError(
      `Media is ${totalBytes} bytes, above the ${maxBytes} byte capture limit.`,
    );
  }
  await requireStorageHeadroom(totalBytes);

  try {
    const parts: BlobPart[] = [];
    let received = 0;
    let response = first;
    for (let request = 0; request < MAX_RANGE_REQUESTS; request += 1) {
      const chunk = await response.arrayBuffer();
      if (chunk.byteLength === 0) {
        throw new MediaBytesError("Media stream stopped returning bytes before the end of the file.");
      }
      parts.push(chunk);
      received += chunk.byteLength;
      if (received >= totalBytes) {
        break;
      }
      response = await requestRange(
        url,
        received,
        Math.min(received + RANGE_CHUNK_BYTES, totalBytes) - 1,
        signal,
      );
    }

    if (received !== totalBytes) {
      throw new MediaBytesError(
        `Media transfer ended at ${received} of ${totalBytes} bytes; a partial upload is never sent.`,
      );
    }

    return { blob: new Blob(parts, { type: mimeType }), mimeType };
  } finally {
    await releaseCachedStreamChunks(url);
  }
}

/**
 * Refuses a capture that Telegram's own storage cannot absorb.
 *
 * Running this origin out of quota is not a local failure: Web K keeps its session and state here
 * too, and a full origin makes Telegram fail to write its own data. An unavailable estimate is not
 * treated as a refusal, because that would block every capture on browsers that do not report one.
 */
async function requireStorageHeadroom(totalBytes: number): Promise<void> {
  const estimate = await readStorageEstimate();
  if (!estimate) {
    return;
  }
  const free = estimate.quota - estimate.usage;
  const required = totalBytes + STREAM_PRELOAD_BYTES + STORAGE_SAFETY_MARGIN_BYTES;
  if (free >= required) {
    return;
  }
  throw new MediaBytesError(
    `Telegram storage has ${describeMegabytes(free)} free, and copying this media needs ` +
      `${describeMegabytes(required)}. The capture stopped so Telegram keeps room for its own data.`,
  );
}

async function readStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return typeof estimate?.usage === "number" && typeof estimate?.quota === "number"
      ? { usage: estimate.usage, quota: estimate.quota }
      : null;
  } catch {
    return null;
  }
}

/**
 * Drops the chunks this read made Telegram persist.
 *
 * Playing a video caches only the part that was watched; reading one whole file for a copy leaves
 * the whole file behind. Deleting them is safe by construction — it is a cache, and Web K
 * re-downloads a chunk it no longer finds.
 */
async function releaseCachedStreamChunks(url: string): Promise<void> {
  const documentId = readStreamDocumentId(url);
  if (!documentId || typeof caches === "undefined") {
    return;
  }
  try {
    const cache = await caches.open(STREAM_CHUNK_CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(
      requests
        .filter((request) => request.url.includes(`${documentId}?offset=`))
        .map((request) => cache.delete(request)),
    );
  } catch {
    // Best effort: failing to tidy Telegram's cache must never fail an otherwise valid capture.
  }
}

function readStreamDocumentId(url: string): string | null {
  const index = url.indexOf(STREAM_URL_MARKER);
  if (index < 0) {
    return null;
  }
  try {
    const info: unknown = JSON.parse(
      decodeURIComponent(url.slice(index + STREAM_URL_MARKER.length).split("?")[0] ?? ""),
    );
    const id = (info as { location?: { id?: unknown } })?.location?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  } catch {
    return null;
  }
}

function describeMegabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`;
}

async function readWholeResponse(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FetchedMediaBytes> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new MediaBytesError(`Media request failed with status ${response.status}.`);
  }
  const blob = await response.blob();
  if (blob.size === 0) {
    throw new MediaBytesError("Media request returned no bytes.");
  }
  if (blob.size > maxBytes) {
    throw new MediaBytesError(
      `Media is ${blob.size} bytes, above the ${maxBytes} byte capture limit.`,
    );
  }
  const mimeType = blob.type || response.headers.get("Content-Type")?.split(";")[0]?.trim() || "";
  if (!mimeType) {
    throw new MediaBytesError("Media was served without a MIME type.");
  }
  return { blob: blob.type ? blob : new Blob([blob], { type: mimeType }), mimeType };
}

async function requestRange(
  url: string,
  offset: number,
  end: number | null,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = { Range: `bytes=${offset}-${end === null ? "" : end}` };
  const response = await fetch(url, signal ? { headers, signal } : { headers });
  if (!response.ok) {
    throw new MediaBytesError(`Media request failed with status ${response.status}.`);
  }
  return response;
}

function describeRange(response: Response): { totalBytes: number; mimeType: string } {
  const match = CONTENT_RANGE_PATTERN.exec(response.headers.get("Content-Range")?.trim() ?? "");
  if (!match || match[3] === "*") {
    throw new MediaBytesError(
      "Media stream did not report its total size, so a complete copy cannot be proven.",
    );
  }
  const totalBytes = Number(match[3]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new MediaBytesError("Media stream reported an unusable total size.");
  }
  const mimeType = response.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
  if (!mimeType) {
    throw new MediaBytesError("Media stream did not report a MIME type.");
  }
  return { totalBytes, mimeType };
}
