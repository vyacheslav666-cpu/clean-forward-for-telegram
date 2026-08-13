/** Owns the page-wide userscript runtime identity and replacement handshake. */
import packageMetadata from "../../package.json";
import type { Logger } from "../utils/logger";

export const CLEAN_FORWARD_RUNTIME_VERSION = packageMetadata.version;
export const CLEAN_FORWARD_RUNTIME_FINGERPRINT =
  `clean-forward/${CLEAN_FORWARD_RUNTIME_VERSION}+singleton-source-restore-proof-v2`;

export const CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR = "[data-clean-forward-runtime]";
export const CLEAN_FORWARD_RUNTIME_REGISTRY_KEY = "__cleanForwardForTelegramRuntime__";

const RUNTIME_BRAND = "clean-forward-for-telegram/runtime";
const RUNTIME_STOP_EVENT = "clean-forward:runtime-stop";
const RUNTIME_MARKER_VERSION_ATTRIBUTE = "data-clean-forward-runtime-version";
const RUNTIME_MARKER_FINGERPRINT_ATTRIBUTE = "data-clean-forward-runtime-fingerprint";
const RUNTIME_MARKER_TOKEN_ATTRIBUTE = "data-clean-forward-runtime-token";
const RUNTIME_MARKER_STATE_ATTRIBUTE = "data-clean-forward-runtime-state";
const LEGACY_ARTIFACT_SELECTOR = [
  "[data-clean-forward-context-action]",
  "[data-clean-forward-selection-action]",
  "[data-clean-forward-recipient-picker]",
  "[data-clean-forward-delivery-progress]",
].join(", ");
const VISIBLE_WORKFLOW_SELECTOR = [
  "[data-clean-forward-recipient-picker]:not([hidden])",
  "[data-clean-forward-delivery-progress]:not([hidden])",
].join(", ");

export interface CleanForwardRuntimeIdentity {
  readonly version: string;
  readonly fingerprint: string;
}

export interface CleanForwardRuntimeController {
  start(): void;
  stop(): void;
}

export interface CleanForwardRuntimeLease {
  readonly identity: CleanForwardRuntimeIdentity;
  /** Starts the controller and promotes the shared marker from claimed to active. */
  start(controller: CleanForwardRuntimeController): void;
  /** Idempotently stops the controller and releases only this lease's marker/registry entry. */
  stop(): boolean;
}

interface RuntimeRegistryEntry {
  readonly brand: typeof RUNTIME_BRAND;
  readonly version: string;
  readonly fingerprint: string;
  readonly token: string;
  readonly stop: () => boolean;
}

type RuntimeHost = Record<string, unknown>;

export const CLEAN_FORWARD_RUNTIME_IDENTITY: CleanForwardRuntimeIdentity = Object.freeze({
  version: CLEAN_FORWARD_RUNTIME_VERSION,
  fingerprint: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
});

/**
 * Claims one shared runtime slot.
 *
 * The DOM stop event is deliberate: it also crosses userscript/page realms where a property on
 * `window` may be wrapped or invisible. The global registry is a fast same-realm path and a
 * diagnostic identity, while the marker remains the cross-realm source of truth.
 */
export function claimCleanForwardRuntime(
  document: Document,
  host: RuntimeHost,
  log: Pick<Logger, "info" | "warn" | "error">,
): CleanForwardRuntimeLease | null {
  const existingMarkers = readRuntimeMarkers(document);
  const existingRegistry = readRegistry(host);
  const compatibleRegistry = readCompatibleRegistry(existingRegistry);
  const hasExistingRuntime = existingMarkers.length > 0 || compatibleRegistry !== null;

  if (hasExistingRuntime && document.querySelector(VISIBLE_WORKFLOW_SELECTOR)) {
    log.warn("A previous Clean Forward runtime still owns a visible workflow; reload is required.", {
      next: CLEAN_FORWARD_RUNTIME_IDENTITY,
      previous: describeExistingRuntime(existingMarkers, compatibleRegistry),
    });
    return null;
  }

  if (hasExistingRuntime) {
    // A marker listener is the only stop channel that remains reliable across isolated realms.
    for (const marker of existingMarkers) {
      marker.dispatchEvent(createStopEvent(document));
    }
    let registryStopped = true;
    if (compatibleRegistry) {
      try {
        registryStopped = compatibleRegistry.stop();
      } catch (error) {
        registryStopped = false;
        log.error("The previous Clean Forward runtime stop callback threw.", {
          previous: describeExistingRuntime(existingMarkers, compatibleRegistry),
          error,
        });
      }
    }

    const remainingMarkers = readRuntimeMarkers(document);
    if (!registryStopped || remainingMarkers.length > 0) {
      log.warn("The previous Clean Forward runtime did not acknowledge the stop handshake.", {
        next: CLEAN_FORWARD_RUNTIME_IDENTITY,
        previous: describeExistingRuntime(remainingMarkers, compatibleRegistry),
      });
      return null;
    }
    if (compatibleRegistry && readRegistry(host) === existingRegistry) {
      deleteRegistry(host, existingRegistry);
    }
    if (readRegistry(host) !== undefined) {
      log.warn("The previous Clean Forward runtime left an occupied registry behind.", {
        next: CLEAN_FORWARD_RUNTIME_IDENTITY,
        previous: describeExistingRuntime(existingMarkers, compatibleRegistry),
      });
      return null;
    }
    cleanupStoppedRuntimeArtifacts(document);
    log.info("Previous Clean Forward runtime stopped before replacement.", {
      next: CLEAN_FORWARD_RUNTIME_IDENTITY,
      previous: describeExistingRuntime(existingMarkers, compatibleRegistry),
    });
  } else {
    if (existingRegistry !== undefined) {
      log.warn("The Clean Forward runtime registry key is occupied by an incompatible value.", {
        next: CLEAN_FORWARD_RUNTIME_IDENTITY,
      });
      return null;
    }
    if (document.querySelector(LEGACY_ARTIFACT_SELECTOR)) {
      // Releases before 0.1.2 had no cross-realm stop contract. Starting another controller would
      // leave the old MutationObserver and callbacks alive, so fail closed and require one reload.
      log.warn(`Legacy Clean Forward DOM is still active; reload before starting runtime ${CLEAN_FORWARD_RUNTIME_VERSION}.`, {
        next: CLEAN_FORWARD_RUNTIME_IDENTITY,
      });
      return null;
    }
  }

  const root = document.documentElement;
  if (!root) {
    log.error("Clean Forward runtime cannot start before documentElement exists.", {
      runtime: CLEAN_FORWARD_RUNTIME_IDENTITY,
    });
    return null;
  }

  const token = createRuntimeToken();
  const marker = document.createElement("span");
  marker.hidden = true;
  marker.setAttribute("data-clean-forward-runtime", "");
  marker.setAttribute(RUNTIME_MARKER_VERSION_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_VERSION);
  marker.setAttribute(RUNTIME_MARKER_FINGERPRINT_ATTRIBUTE, CLEAN_FORWARD_RUNTIME_FINGERPRINT);
  marker.setAttribute(RUNTIME_MARKER_TOKEN_ATTRIBUTE, token);
  marker.setAttribute(RUNTIME_MARKER_STATE_ATTRIBUTE, "claimed");

  let controller: CleanForwardRuntimeController | null = null;
  let started = false;
  let stopping = false;
  let stopped = false;
  let entry: RuntimeRegistryEntry;

  const releaseOwnedState = (): void => {
    marker.removeEventListener(RUNTIME_STOP_EVENT, onStopRequest);
    if (
      marker.getAttribute(RUNTIME_MARKER_TOKEN_ATTRIBUTE) === token &&
      marker.isConnected
    ) {
      marker.remove();
    }
    deleteRegistry(host, entry);
  };

  const stop = (): boolean => {
    if (stopped) {
      return true;
    }
    if (stopping) {
      return false;
    }
    stopping = true;
    marker.setAttribute(RUNTIME_MARKER_STATE_ATTRIBUTE, "stopping");
    try {
      controller?.stop();
    } catch (error) {
      stopping = false;
      marker.setAttribute(RUNTIME_MARKER_STATE_ATTRIBUTE, "stop-failed");
      log.error("Clean Forward runtime could not stop safely; replacement was blocked.", {
        runtime: CLEAN_FORWARD_RUNTIME_IDENTITY,
        error,
      });
      return false;
    }
    stopped = true;
    stopping = false;
    releaseOwnedState();
    log.info("Clean Forward runtime stopped.", { runtime: CLEAN_FORWARD_RUNTIME_IDENTITY });
    return true;
  };

  const onStopRequest = (): void => {
    stop();
  };
  marker.addEventListener(RUNTIME_STOP_EVENT, onStopRequest);

  entry = Object.freeze({
    brand: RUNTIME_BRAND,
    version: CLEAN_FORWARD_RUNTIME_VERSION,
    fingerprint: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
    token,
    stop,
  });

  root.append(marker);
  if (!writeRegistry(host, entry)) {
    releaseOwnedState();
    log.error("Clean Forward runtime could not publish its singleton registry.", {
      runtime: CLEAN_FORWARD_RUNTIME_IDENTITY,
    });
    return null;
  }

  return Object.freeze({
    identity: CLEAN_FORWARD_RUNTIME_IDENTITY,
    start(runtimeController: CleanForwardRuntimeController): void {
      if (started || stopped || stopping) {
        throw new Error("Clean Forward runtime lease cannot be started twice.");
      }
      controller = runtimeController;
      try {
        runtimeController.start();
        if (stopped || stopping || readRegistry(host) !== entry || !marker.isConnected) {
          throw new Error("Clean Forward runtime lost singleton ownership during startup.");
        }
        started = true;
        marker.setAttribute(RUNTIME_MARKER_STATE_ATTRIBUTE, "active");
        log.info("Clean Forward runtime initialized.", {
          runtime: CLEAN_FORWARD_RUNTIME_IDENTITY,
        });
      } catch (error) {
        stop();
        throw error;
      }
    },
    stop,
  });
}

function readRuntimeMarkers(document: Document): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR));
}

function createStopEvent(document: Document): Event {
  const event = document.createEvent("Event");
  event.initEvent(RUNTIME_STOP_EVENT, false, false);
  return event;
}

function readRegistry(host: RuntimeHost): unknown {
  try {
    return Reflect.get(host, CLEAN_FORWARD_RUNTIME_REGISTRY_KEY);
  } catch {
    return undefined;
  }
}

function readCompatibleRegistry(value: unknown): RuntimeRegistryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<RuntimeRegistryEntry>;
  return candidate.brand === RUNTIME_BRAND &&
    typeof candidate.version === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.token === "string" &&
    typeof candidate.stop === "function"
    ? candidate as RuntimeRegistryEntry
    : null;
}

function writeRegistry(host: RuntimeHost, entry: RuntimeRegistryEntry): boolean {
  try {
    Object.defineProperty(host, CLEAN_FORWARD_RUNTIME_REGISTRY_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: entry,
    });
    return readRegistry(host) === entry;
  } catch {
    return false;
  }
}

function deleteRegistry(host: RuntimeHost, expected: unknown): void {
  try {
    if (readRegistry(host) === expected) {
      Reflect.deleteProperty(host, CLEAN_FORWARD_RUNTIME_REGISTRY_KEY);
    }
  } catch {
    // The DOM marker still prevents another runtime from starting if a hostile host blocks cleanup.
  }
}

function cleanupStoppedRuntimeArtifacts(document: Document): void {
  for (const element of document.querySelectorAll<HTMLElement>(LEGACY_ARTIFACT_SELECTOR)) {
    element.remove();
  }
}

function describeExistingRuntime(
  markers: readonly HTMLElement[],
  registry: RuntimeRegistryEntry | null,
): ReadonlyArray<CleanForwardRuntimeIdentity> {
  const identities = markers.map((marker) => ({
    version: marker.getAttribute(RUNTIME_MARKER_VERSION_ATTRIBUTE) ?? "unknown",
    fingerprint: marker.getAttribute(RUNTIME_MARKER_FINGERPRINT_ATTRIBUTE) ?? "unknown",
  }));
  if (identities.length === 0 && registry) {
    identities.push({ version: registry.version, fingerprint: registry.fingerprint });
  }
  return Object.freeze(identities.map((identity) => Object.freeze(identity)));
}

let tokenSequence = 0;

function createRuntimeToken(): string {
  tokenSequence += 1;
  return `${Date.now().toString(36)}-${tokenSequence.toString(36)}`;
}
