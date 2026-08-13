import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAN_FORWARD_RUNTIME_FINGERPRINT,
  CLEAN_FORWARD_RUNTIME_IDENTITY,
  CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR,
  CLEAN_FORWARD_RUNTIME_REGISTRY_KEY,
  CLEAN_FORWARD_RUNTIME_VERSION,
  claimCleanForwardRuntime,
  type CleanForwardRuntimeLease,
} from "../../src/app/CleanForwardRuntime";

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const leases: CleanForwardRuntimeLease[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) {
    lease.stop();
  }
  for (const marker of document.querySelectorAll(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)) {
    marker.remove();
  }
});

describe("Clean Forward runtime identity", () => {
  it("publishes the release fingerprint in the init log, DOM marker, and registry", () => {
    const host: Record<string, unknown> = {};
    const log = createLog();
    const lease = claimCleanForwardRuntime(document, host, log);
    expect(lease).not.toBeNull();
    leases.push(lease!);
    const controller = { start: vi.fn(), stop: vi.fn() };

    lease!.start(controller);

    const marker = document.querySelector<HTMLElement>(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR);
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("data-clean-forward-runtime-version"))
      .toBe(CLEAN_FORWARD_RUNTIME_VERSION);
    expect(marker?.getAttribute("data-clean-forward-runtime-fingerprint"))
      .toBe(CLEAN_FORWARD_RUNTIME_FINGERPRINT);
    expect(marker?.getAttribute("data-clean-forward-runtime-state")).toBe("active");
    expect(host[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toMatchObject({
      version: CLEAN_FORWARD_RUNTIME_VERSION,
      fingerprint: CLEAN_FORWARD_RUNTIME_FINGERPRINT,
    });
    expect(log.info).toHaveBeenCalledWith("Clean Forward runtime initialized.", {
      runtime: CLEAN_FORWARD_RUNTIME_IDENTITY,
    });

    expect(lease!.stop()).toBe(true);
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(document.querySelector(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)).toBeNull();
    expect(host[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toBeUndefined();
  });

  it("stops and replaces a prior idle runtime without leaving duplicate callbacks or markers", () => {
    const host: Record<string, unknown> = {};
    const firstLog = createLog();
    const first = claimCleanForwardRuntime(document, host, firstLog)!;
    leases.push(first);
    const firstController = { start: vi.fn(), stop: vi.fn() };
    first.start(firstController);
    const staleAction = document.createElement("button");
    staleAction.setAttribute("data-clean-forward-context-action", "");
    document.body.append(staleAction);

    const secondLog = createLog();
    const second = claimCleanForwardRuntime(document, host, secondLog);
    expect(second).not.toBeNull();
    leases.push(second!);
    const secondController = { start: vi.fn(), stop: vi.fn() };
    second!.start(secondController);

    expect(firstController.stop).toHaveBeenCalledOnce();
    expect(secondController.start).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)).toHaveLength(1);
    expect(document.querySelector("[data-clean-forward-context-action]")).toBeNull();
    expect(secondLog.info).toHaveBeenCalledWith(
      "Previous Clean Forward runtime stopped before replacement.",
      expect.objectContaining({ next: CLEAN_FORWARD_RUNTIME_IDENTITY }),
    );
  });

  it("uses the DOM stop handshake when the prior global registry is in another realm", () => {
    const firstHost: Record<string, unknown> = {};
    const first = claimCleanForwardRuntime(document, firstHost, createLog())!;
    leases.push(first);
    const firstController = { start: vi.fn(), stop: vi.fn() };
    first.start(firstController);

    const isolatedHost: Record<string, unknown> = {};
    const second = claimCleanForwardRuntime(document, isolatedHost, createLog());
    expect(second).not.toBeNull();
    leases.push(second!);

    expect(firstController.stop).toHaveBeenCalledOnce();
    expect(firstHost[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toBeUndefined();
    expect(isolatedHost[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toBeDefined();
    expect(document.querySelectorAll(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)).toHaveLength(1);
  });

  it("does not replace a runtime that still owns a visible delivery workflow", () => {
    const host: Record<string, unknown> = {};
    const first = claimCleanForwardRuntime(document, host, createLog())!;
    leases.push(first);
    const firstController = { start: vi.fn(), stop: vi.fn() };
    first.start(firstController);
    const progress = document.createElement("div");
    progress.setAttribute("data-clean-forward-delivery-progress", "");
    document.body.append(progress);
    const nextLog = createLog();

    const second = claimCleanForwardRuntime(document, host, nextLog);

    expect(second).toBeNull();
    expect(firstController.stop).not.toHaveBeenCalled();
    expect(document.querySelectorAll(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)).toHaveLength(1);
    expect(nextLog.warn).toHaveBeenCalledWith(
      "A previous Clean Forward runtime still owns a visible workflow; reload is required.",
      expect.any(Object),
    );
  });

  it("fails closed on an unacknowledged cross-realm marker", () => {
    const marker = document.createElement("span");
    marker.setAttribute("data-clean-forward-runtime", "");
    marker.setAttribute("data-clean-forward-runtime-version", "0.1.2");
    marker.setAttribute("data-clean-forward-runtime-fingerprint", "unreachable-runtime");
    document.documentElement.append(marker);
    const log = createLog();

    const lease = claimCleanForwardRuntime(document, {}, log);

    expect(lease).toBeNull();
    expect(marker.isConnected).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "The previous Clean Forward runtime did not acknowledge the stop handshake.",
      expect.any(Object),
    );
  });

  it("does not overwrite an incompatible registry even when its marker disappears", () => {
    const marker = document.createElement("span");
    marker.setAttribute("data-clean-forward-runtime", "");
    marker.addEventListener("clean-forward:runtime-stop", () => marker.remove());
    document.documentElement.append(marker);
    const foreignRegistry = { owner: "another realm without the runtime contract" };
    const host: Record<string, unknown> = {
      [CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]: foreignRegistry,
    };
    const log = createLog();

    const lease = claimCleanForwardRuntime(document, host, log);

    expect(lease).toBeNull();
    expect(host[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toBe(foreignRegistry);
    expect(log.warn).toHaveBeenCalledWith(
      "The previous Clean Forward runtime left an occupied registry behind.",
      expect.any(Object),
    );
  });

  it("refuses ambiguous pre-0.1.2 DOM instead of running a second controller", () => {
    const legacyAction = document.createElement("button");
    legacyAction.setAttribute("data-clean-forward-selection-action", "");
    document.body.append(legacyAction);
    const log = createLog();

    const lease = claimCleanForwardRuntime(document, {}, log);

    expect(lease).toBeNull();
    expect(legacyAction.isConnected).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      `Legacy Clean Forward DOM is still active; reload before starting runtime ${CLEAN_FORWARD_RUNTIME_VERSION}.`,
      { next: CLEAN_FORWARD_RUNTIME_IDENTITY },
    );
  });

  it("removes its claim when controller startup throws", () => {
    const host: Record<string, unknown> = {};
    const lease = claimCleanForwardRuntime(document, host, createLog())!;
    leases.push(lease);
    const startupError = new Error("startup failed");
    const controller = {
      start: vi.fn(() => { throw startupError; }),
      stop: vi.fn(),
    };

    expect(() => lease.start(controller)).toThrow(startupError);
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(document.querySelector(CLEAN_FORWARD_RUNTIME_MARKER_SELECTOR)).toBeNull();
    expect(host[CLEAN_FORWARD_RUNTIME_REGISTRY_KEY]).toBeUndefined();
  });
});
