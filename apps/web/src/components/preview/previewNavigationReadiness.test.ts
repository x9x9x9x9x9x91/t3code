import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
  evaluate: vi.fn(),
  status: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: mocks.evaluate,
      status: mocks.status,
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });

  describe("with a probe that never answers", () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      mocks.status.mockReset();
      mocks.evaluate.mockReset();
      mocks.readThreadPreviewState.mockReturnValue({
        serverEpoch: "epoch-1",
        sessions: { [tabId]: { tabId } },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports the navigation timeout within the budget instead of waiting on it", async () => {
      mocks.status.mockReturnValue(new Promise(() => {}));
      let settledAt: number | undefined;
      const result = waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        runtimeTabId,
        "navigate",
        "load",
        100,
      ).catch((error: unknown) => {
        settledAt = Date.now();
        return error;
      });

      await vi.advanceTimersByTimeAsync(100);

      expect(await result).toBeInstanceOf(PreviewAutomationNavigationTimeoutError);
      expect(settledAt).toBeLessThanOrEqual(100);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not start a probe once the request budget is spent", async () => {
      mocks.evaluate.mockReturnValue(new Promise(() => {}));

      await expect(
        waitForNavigationReadiness(
          threadRef,
          "request-2",
          tabId,
          runtimeTabId,
          "navigate",
          "domContentLoaded",
          0,
        ),
      ).rejects.toBeInstanceOf(PreviewAutomationNavigationTimeoutError);
      expect(mocks.evaluate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
