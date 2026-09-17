import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type PreviewAutomationResponse,
  type PreviewAutomationStatus,
  type PreviewAutomationStreamEvent,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { __resetClientSettingsPersistenceForTests } from "~/hooks/useSettings";
import {
  applyPreviewDesktopState,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
  type DesktopPreviewOverlay,
} from "~/previewStateStore";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { PreviewAutomationHosts } from "./PreviewAutomationHosts";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn(),
  open: vi.fn(async (_target: { environmentId: EnvironmentId; input: PreviewOpenInput }) =>
    AsyncResult.success(snapshot),
  ),
  list: vi.fn(async () => AsyncResult.success(emptyList)),
  resize: vi.fn(),
  respond:
    vi.fn<
      (target: { environmentId: EnvironmentId; input: PreviewAutomationResponse }) => Promise<void>
    >(),
  focus: vi.fn(async () => undefined),
  automationStatus: vi.fn<(runtimeTabId: string) => Promise<PreviewAutomationStatus>>(),
  automationSnapshot: vi.fn<(runtimeTabId: string) => Promise<unknown>>(),
  navigate: vi.fn<(runtimeTabId: string, url: string) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId }] }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    automationRequests: () => requestsAtom,
    list: () => listAtom,
    open: mocks.open,
    resize: mocks.resize,
    respondToAutomation: mocks.respond,
    focusAutomationHost: mocks.focus,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.list,
}));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    automation: { status: mocks.automationStatus, snapshot: mocks.automationSnapshot },
  },
}));

const environmentId = EnvironmentId.make("automation-environment");
const threadId = ThreadId.make("automation-thread");
const threadRef = { environmentId, threadId };
const viewport = { _tag: "freeform", width: 1440, height: 900 } as const;
const savedSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  browserDefaultViewport: viewport,
  browserDefaultProfileId: "work",
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
};
const snapshot: PreviewSessionSnapshot = {
  threadId,
  tabId: "automation-tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport,
  profileId: "work",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const serverEpoch = "test-server";
const emptyList = { sessions: [], serverEpoch, revision: 0 };
const listAtom = Atom.make(AsyncResult.success(emptyList));
const desktopOverlay: DesktopPreviewOverlay = {
  hasWebContents: true,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  zoomFactor: 1,
  pictureInPicture: false,
  colorScheme: "system",
  audioMuted: false,
  audible: false,
  controller: "agent",
  favicon: null,
};
const automationStatus: PreviewAutomationStatus = {
  available: true,
  visible: true,
  tabId: snapshot.tabId,
  url: "http://example.test/",
  title: "Example",
  loading: false,
};

/** A rendering guest is what `waitForDesktopOverlay` probes for before it runs an operation. */
const renderingWebviewDocument = (
  runtimeTabId: string,
  executeJavaScript?: (code: string) => Promise<unknown>,
) => ({
  hasFocus: () => false,
  querySelectorAll: () => [
    {
      getAttribute: (name: string) => (name === "data-preview-tab" ? runtimeTabId : null),
      closest: () => ({ getAttribute: () => "active" }),
      ...(executeJavaScript ? { executeJavaScript } : {}),
    },
  ],
});
const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
  AsyncResult.initial(false),
);
const requestEvent: PreviewAutomationStreamEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "open-request",
    threadId,
    operation: "open",
    input: { open: false, reuseExistingTab: false },
    timeoutMs: 15_000,
  },
};
const requestTimeoutMs = 15_000;
const statusRequestEvent: PreviewAutomationStreamEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "status-request",
    threadId,
    operation: "status",
    tabId: snapshot.tabId,
    input: {},
    timeoutMs: requestTimeoutMs,
  },
};
const navigateUrl = "http://example.test/next";
const reopenRequestEvent: PreviewAutomationStreamEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "reopen-request",
    threadId,
    operation: "open",
    tabId: snapshot.tabId,
    input: { url: navigateUrl, reuseExistingTab: true, open: false },
    timeoutMs: requestTimeoutMs,
  },
};
const navigateRequestEvent: PreviewAutomationStreamEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "navigate-request",
    threadId,
    operation: "navigate",
    tabId: snapshot.tabId,
    input: { url: navigateUrl },
    timeoutMs: requestTimeoutMs,
  },
};
const snapshotRequestEvent: PreviewAutomationStreamEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "snapshot-request",
    threadId,
    operation: "snapshot",
    tabId: snapshot.tabId,
    input: {},
    timeoutMs: requestTimeoutMs,
  },
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getClientSettings.mockReset().mockResolvedValue(savedSettings);
  mocks.respond.mockReset();
  __resetClientSettingsPersistenceForTests();
  resetPreviewStateForTests();
  appAtomRegistry.set(requestsAtom, AsyncResult.initial(false));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { hasFocus: () => false, querySelectorAll: () => [] });
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <PreviewAutomationHosts />
      </AppAtomRegistryProvider>,
    );
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  resetPreviewStateForTests();
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PreviewAutomationHosts open", () => {
  it("waits for saved settings before opening a tab with the configured profile and viewport", async () => {
    const readStarted = deferred<void>();
    const read = deferred<ClientSettings>();
    const response = deferred<PreviewAutomationResponse>();
    mocks.getClientSettings.mockImplementationOnce(() => {
      readStarted.resolve();
      return read.promise;
    });
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await readStarted.promise;
    });
    expect(mocks.open).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(savedSettings);
      await response.promise;
    });

    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId, viewport, profileId: "work" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    await expect(response.promise).resolves.toMatchObject({ requestId: "open-request", ok: true });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("reports a settings read failure without opening a tab", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getClientSettings.mockRejectedValueOnce(new Error("Settings read failed"));
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await response.promise;
    });

    await expect(response.promise).resolves.toMatchObject({
      requestId: "open-request",
      ok: false,
      error: { _tag: "PreviewAutomationExecutionError" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("PreviewAutomationHosts snapshot", () => {
  it("fails a stalled bridge snapshot on the host deadline instead of losing to the broker", async () => {
    const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId);
    mocks.automationStatus.mockImplementation(async () => automationStatus);
    mocks.automationSnapshot.mockImplementation(() => new Promise(() => {}));
    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot],
      serverEpoch,
      revision: 1,
    });
    applyPreviewDesktopState(threadRef, snapshot.tabId, desktopOverlay);
    vi.stubGlobal("document", renderingWebviewDocument(runtimeTabId));
    const response = deferred<PreviewAutomationResponse>();
    let respondedAt: number | undefined;
    mocks.respond.mockImplementationOnce(async ({ input }) => {
      respondedAt = Date.now();
      response.resolve(input);
    });

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await act(async () => {
        appAtomRegistry.set(requestsAtom, AsyncResult.success(snapshotRequestEvent));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      });
      // The broker fails the request at request.timeoutMs, so a host answer
      // that arrives later is dropped and the agent never learns the class.
      expect(respondedAt).toBeDefined();
      expect(respondedAt ?? Number.POSITIVE_INFINITY).toBeLessThan(startedAt + requestTimeoutMs);
    } finally {
      vi.useRealTimers();
    }

    await expect(response.promise).resolves.toMatchObject({
      requestId: "snapshot-request",
      ok: false,
      error: {
        _tag: "PreviewAutomationTimeoutError",
        hostTag: "PreviewAutomationBridgeTimeoutError",
      },
    });
    expect(mocks.automationSnapshot).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });
});

describe("PreviewAutomationHosts status", () => {
  /** A status request reads the guest directly, so it needs no overlay wait. */
  const readyStatusTarget = (executeJavaScript?: (code: string) => Promise<unknown>) => {
    const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId);
    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot],
      serverEpoch,
      revision: 1,
    });
    applyPreviewDesktopState(threadRef, snapshot.tabId, desktopOverlay);
    vi.stubGlobal("document", renderingWebviewDocument(runtimeTabId, executeJavaScript));
    return runtimeTabId;
  };

  const respondToStalledStatus = async () => {
    const response = deferred<PreviewAutomationResponse>();
    let respondedAt: number | undefined;
    mocks.respond.mockImplementationOnce(async ({ input }) => {
      respondedAt = Date.now();
      response.resolve(input);
    });

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await act(async () => {
        appAtomRegistry.set(requestsAtom, AsyncResult.success(statusRequestEvent));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      });
      // The broker fails the request at request.timeoutMs, so a host answer
      // that arrives later is dropped and the agent never learns the class.
      expect(respondedAt).toBeDefined();
      expect(respondedAt ?? Number.POSITIVE_INFINITY).toBeLessThan(startedAt + requestTimeoutMs);
    } finally {
      vi.useRealTimers();
    }

    await expect(response.promise).resolves.toMatchObject({
      requestId: "status-request",
      ok: false,
      error: {
        _tag: "PreviewAutomationTimeoutError",
        hostTag: "PreviewAutomationBridgeTimeoutError",
      },
    });
  };

  it("fails a stalled viewport read on the host deadline instead of answering without a viewport", async () => {
    const runtimeTabId = readyStatusTarget(() => new Promise<unknown>(() => {}));
    mocks.automationStatus.mockImplementation(async () => automationStatus);

    await respondToStalledStatus();

    // A page that cannot answer a viewport read cannot report a truthful
    // status either, so the expiry fails the request instead of quietly
    // dropping the viewport from it.
    expect(mocks.automationStatus).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });

  it("fails a stalled bridge status on the host deadline instead of losing to the broker", async () => {
    const executeJavaScript = vi.fn(async () => ({ width: 1440, height: 900 }));
    const runtimeTabId = readyStatusTarget(executeJavaScript);
    mocks.automationStatus.mockImplementation(() => new Promise<PreviewAutomationStatus>(() => {}));

    await respondToStalledStatus();

    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(mocks.automationStatus).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });
});

describe("PreviewAutomationHosts navigate", () => {
  it("fails a stalled bridge navigate on the host deadline instead of losing to the broker", async () => {
    const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId);
    mocks.automationStatus.mockImplementation(async () => automationStatus);
    mocks.navigate.mockImplementation(() => new Promise<void>(() => {}));
    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot],
      serverEpoch,
      revision: 1,
    });
    applyPreviewDesktopState(threadRef, snapshot.tabId, desktopOverlay);
    vi.stubGlobal("document", renderingWebviewDocument(runtimeTabId));
    const response = deferred<PreviewAutomationResponse>();
    let respondedAt: number | undefined;
    mocks.respond.mockImplementationOnce(async ({ input }) => {
      respondedAt = Date.now();
      response.resolve(input);
    });

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await act(async () => {
        appAtomRegistry.set(requestsAtom, AsyncResult.success(navigateRequestEvent));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      });
      // The navigation readiness wait shares this deadline, so an unbounded
      // navigate is the one call that can still outlive the broker.
      expect(respondedAt).toBeDefined();
      expect(respondedAt ?? Number.POSITIVE_INFINITY).toBeLessThan(startedAt + requestTimeoutMs);
    } finally {
      vi.useRealTimers();
    }

    await expect(response.promise).resolves.toMatchObject({
      requestId: "navigate-request",
      ok: false,
      error: {
        _tag: "PreviewAutomationTimeoutError",
        hostTag: "PreviewAutomationBridgeTimeoutError",
      },
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, navigateUrl);
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });

  it("fails a stalled navigate on the host deadline when an open reuses a tab", async () => {
    const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId);
    mocks.automationStatus.mockImplementation(async () => automationStatus);
    mocks.navigate.mockImplementation(() => new Promise<void>(() => {}));
    reconcilePreviewServerSessions(threadRef, {
      sessions: [snapshot],
      serverEpoch,
      revision: 1,
    });
    applyPreviewDesktopState(threadRef, snapshot.tabId, desktopOverlay);
    vi.stubGlobal("document", renderingWebviewDocument(runtimeTabId));
    const response = deferred<PreviewAutomationResponse>();
    let respondedAt: number | undefined;
    mocks.respond.mockImplementationOnce(async ({ input }) => {
      respondedAt = Date.now();
      response.resolve(input);
    });

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await act(async () => {
        appAtomRegistry.set(requestsAtom, AsyncResult.success(reopenRequestEvent));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(requestTimeoutMs);
      });
      expect(respondedAt).toBeDefined();
      expect(respondedAt ?? Number.POSITIVE_INFINITY).toBeLessThan(startedAt + requestTimeoutMs);
    } finally {
      vi.useRealTimers();
    }

    await expect(response.promise).resolves.toMatchObject({
      requestId: "reopen-request",
      ok: false,
      error: {
        _tag: "PreviewAutomationTimeoutError",
        hostTag: "PreviewAutomationBridgeTimeoutError",
      },
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, navigateUrl);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });
});
