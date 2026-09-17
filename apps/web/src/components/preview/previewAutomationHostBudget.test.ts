import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  HOST_DEADLINE_EXPIRED,
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  pollUntilHostDeadline,
  raceBridgeCall,
  remainingHostBudgetMs,
  resolveHostWaitBudgetMs,
  waitForHostReadiness,
} from "./previewAutomationHostBudget";

describe("resolveHostWaitBudgetMs", () => {
  it("reserves the full response margin once the request budget allows it", () => {
    expect(resolveHostWaitBudgetMs(15_000)).toBe(15_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
    expect(resolveHostWaitBudgetMs(60_000)).toBe(60_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
  });

  it("keeps most of a short request budget instead of collapsing it", () => {
    expect(resolveHostWaitBudgetMs(1_000)).toBe(800);
    expect(resolveHostWaitBudgetMs(100)).toBe(80);
  });

  it("returns a non-negative budget for invalid input", () => {
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveHostWaitBudgetMs(invalid)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("waitForHostReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1, 10, 100, 250, 1_000, 15_000])(
    "stops unavailable-overlay polling before a %ims broker timeout",
    async (requestTimeoutMs) => {
      const deadlineMs = Date.now() + resolveHostWaitBudgetMs(requestTimeoutMs);
      let finishedAt: number | undefined;
      const result = waitForHostReadiness(deadlineMs, async () => false).then((ready) => {
        finishedAt = Date.now();
        return ready;
      });

      await vi.advanceTimersByTimeAsync(requestTimeoutMs);

      expect(await result).toBe(false);
      expect(finishedAt).toBeLessThan(requestTimeoutMs);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("includes session setup in the deadline instead of starting a fresh wait budget", async () => {
    const deadlineMs = Date.now() + resolveHostWaitBudgetMs(15_000);
    await vi.advanceTimersByTimeAsync(2_000);
    let finished = false;
    const result = waitForHostReadiness(deadlineMs, async () => false).then((ready) => {
      finished = true;
      return ready;
    });

    await vi.advanceTimersByTimeAsync(11_499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(Date.now()).toBe(deadlineMs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips readiness probes when setup has already exhausted the deadline", async () => {
    const deadlineMs = Date.now() + resolveHostWaitBudgetMs(100);
    await vi.advanceTimersByTimeAsync(100);
    const isReady = vi.fn(async () => false);

    expect(await waitForHostReadiness(deadlineMs, isReady)).toBe(false);
    expect(isReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns as soon as the overlay is ready and clears its timeout", async () => {
    const isReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = waitForHostReadiness(800, isReady);

    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toBe(true);
    expect(isReady).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "keeps a probe result of %s that wins the deadline race",
    async (ready) => {
      const isReady = vi.fn(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(ready), 80)),
      );
      const result = waitForHostReadiness(80, isReady);

      await vi.advanceTimersByTimeAsync(80);

      expect(await result).toBe(ready);
      expect(isReady).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a stalled status probe and ignores a late ready result", async () => {
    let completeProbe!: (ready: boolean) => void;
    const isReady = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          completeProbe = resolve;
        }),
    );
    const result = waitForHostReadiness(80, isReady);

    await vi.advanceTimersByTimeAsync(80);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    completeProbe(true);
    await vi.runAllTimersAsync();
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves probe failures and clears the pending timeout", async () => {
    const error = new Error("Preview target was replaced");
    const isReady = vi.fn().mockRejectedValue(error);

    await expect(waitForHostReadiness(800, isReady)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("pollUntilHostDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a probe that never settles, within the budget", async () => {
    const probe = vi.fn(() => new Promise<string | null>(() => {}));
    let finishedAt: number | undefined;
    const result = pollUntilHostDeadline(80, probe).then((value) => {
      finishedAt = Date.now();
      return value;
    });

    await vi.advanceTimersByTimeAsync(80);

    expect(await result).toBeNull();
    expect(finishedAt).toBeLessThanOrEqual(80);
    expect(probe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a probe it has no budget left to finish", async () => {
    const probe = vi.fn(async () => "rendered");

    expect(await pollUntilHostDeadline(Date.now(), probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the first probe result and stops polling", async () => {
    const probe = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("rendered");
    const result = pollUntilHostDeadline(800, probe);

    await vi.advanceTimersByTimeAsync(50);

    expect(await result).toBe("rendered");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a probe failure instead of polling through it", async () => {
    const error = new Error("Preview target was replaced");

    await expect(pollUntilHostDeadline(800, vi.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("raceBridgeCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a bridge call that never answers, at the deadline the waits left it", async () => {
    const deadlineMs = Date.now() + resolveHostWaitBudgetMs(15_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const call = vi.fn(() => new Promise<string>(() => {}));
    let finishedAt: number | undefined;
    const result = raceBridgeCall(deadlineMs, call).then((value) => {
      finishedAt = Date.now();
      return value;
    });

    await vi.advanceTimersByTimeAsync(11_499);
    expect(finishedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBe(HOST_DEADLINE_EXPIRED);
    expect(finishedAt).toBe(deadlineMs);
    expect(call).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the answer of a call that beats the deadline and clears its timeout", async () => {
    const call = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("snapshot"), 40)),
    );
    const result = raceBridgeCall(800, call);

    await vi.advanceTimersByTimeAsync(40);

    expect(await result).toBe("snapshot");
    expect(call).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Same rule as pollUntilHostDeadline: a budget that is already spent starts
  // no work, because its answer could only arrive after the broker's own.
  it.each([0, -5_000])("starts no call with %ims of budget left", async (remainingMs) => {
    const call = vi.fn(async () => "snapshot");

    expect(await raceBridgeCall(Date.now() + remainingMs, call)).toBe(HOST_DEADLINE_EXPIRED);
    expect(call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a bridge failure instead of reporting a deadline", async () => {
    const error = new Error("Preview guest stopped responding");

    await expect(raceBridgeCall(800, vi.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an answer that arrives after the deadline won", async () => {
    let completeCall!: (value: string) => void;
    const call = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          completeCall = resolve;
        }),
    );
    const result = raceBridgeCall(80, call);

    await vi.advanceTimersByTimeAsync(80);
    expect(await result).toBe(HOST_DEADLINE_EXPIRED);

    completeCall("snapshot");
    await vi.runAllTimersAsync();
    expect(call).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("remainingHostBudgetMs", () => {
  it("spends one request's deadline across its successive waits", () => {
    const deadline = Date.now() + resolveHostWaitBudgetMs(15_000);
    const beforeReadiness = remainingHostBudgetMs(deadline);
    // A wait that restarted the clock at the request timeout would always
    // outlive the broker, which then reports its own generic timeout instead.
    expect(beforeReadiness).toBeLessThan(15_000);
    expect(remainingHostBudgetMs(deadline - 5_000)).toBeLessThan(beforeReadiness);
  });

  it("reports an exhausted budget as zero rather than a negative wait", () => {
    expect(remainingHostBudgetMs(Date.now() - 10_000)).toBe(0);
  });
});
