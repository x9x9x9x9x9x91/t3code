/** Allow time to deliver an overlay failure before the broker times out. */
export const PREVIEW_HOST_RESPONSE_MARGIN_MS = 1_500;

const HOST_RESPONSE_MARGIN_FRACTION = 0.2;

export function resolveHostWaitBudgetMs(requestTimeoutMs: number): number {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return 0;
  }
  const reservedMs = Math.min(
    PREVIEW_HOST_RESPONSE_MARGIN_MS,
    Math.ceil(requestTimeoutMs * HOST_RESPONSE_MARGIN_FRACTION),
  );
  return Math.max(0, requestTimeoutMs - reservedMs);
}

/**
 * What is left of the request's host budget.
 *
 * Every wait inside one request shares the deadline the budget set, so a later
 * wait cannot restart the clock: the broker fails the request at its own
 * timeout, and the agent then sees a generic "timed out" instead of the host
 * error that names which wait ran out.
 */
export function remainingHostBudgetMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/** How long a probe that has not answered yet keeps the loop waiting. */
const HOST_POLL_INTERVAL_MS = 50;

/** What a bounded wait returns when the request deadline arrived before the answer did. */
export const HOST_DEADLINE_EXPIRED = Symbol("previewAutomationHostDeadlineExpired");

/**
 * Bounds one probe by the request's host deadline.
 *
 * A guest that stopped answering leaves its probe pending forever, so without
 * this race the host outlives the broker timeout and the agent gets the
 * broker's generic "timed out" instead of the host error that names the wait.
 */
async function raceHostDeadline<T>(
  deadlineMs: number,
  probe: () => Promise<T>,
): Promise<T | typeof HOST_DEADLINE_EXPIRED> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<typeof HOST_DEADLINE_EXPIRED>((resolve) => {
        timeout = setTimeout(
          () => resolve(HOST_DEADLINE_EXPIRED),
          remainingHostBudgetMs(deadlineMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bounds one bridge call by the request's host deadline.
 *
 * Readiness waits already share the deadline, so an unbounded operation is the
 * last way one request can outlive the broker: the guest keeps working, the
 * broker answers the agent with its own generic timeout, and the late host
 * response is dropped with the class that would have explained it. An
 * exhausted budget starts no call at all, the rule `pollUntilHostDeadline`
 * follows for probes. `HOST_DEADLINE_EXPIRED` means the deadline won; the
 * caller owns the host error that says which operation ran out.
 */
export async function raceBridgeCall<T>(
  deadlineMs: number,
  call: () => Promise<T>,
): Promise<T | typeof HOST_DEADLINE_EXPIRED> {
  if (remainingHostBudgetMs(deadlineMs) <= 0) return HOST_DEADLINE_EXPIRED;
  return await raceHostDeadline(deadlineMs, call);
}

/**
 * Polls until the probe answers with a value or the host deadline passes.
 *
 * Both the probes and the delays between them spend the same deadline, and an
 * exhausted budget starts no further probe. `null` means the deadline won; the
 * caller owns the host error that says which wait ran out.
 */
export async function pollUntilHostDeadline<T>(
  deadlineMs: number,
  probe: () => Promise<T | null>,
): Promise<T | null> {
  while (Date.now() < deadlineMs) {
    const result = await raceHostDeadline(deadlineMs, probe);
    if (result === HOST_DEADLINE_EXPIRED) return null;
    if (result !== null) return result;
    if (Date.now() >= deadlineMs) return null;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(HOST_POLL_INTERVAL_MS, deadlineMs - Date.now())),
    );
  }
  return null;
}

/** Both readiness probes and polling delays share the request's host deadline. */
export async function waitForHostReadiness(
  deadlineMs: number,
  isReady: () => Promise<boolean>,
): Promise<boolean> {
  const ready = await pollUntilHostDeadline(deadlineMs, async () =>
    (await isReady()) ? true : null,
  );
  return ready === true;
}
