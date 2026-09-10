import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { formatThreadProgressContext } from "./ThreadProgressContext.ts";

export class ThreadProgressReactor extends Context.Service<
  ThreadProgressReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadProgressReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("ThreadProgressReactor.sweep")(function* () {
    const { progressEstimateModelSelection: modelSelection } = yield* settingsService.getSettings;
    if (modelSelection === null) {
      return;
    }
    const snapshot = yield* snapshots.getShellSnapshot();
    const candidates = snapshot.threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.settledOverride !== "settled" &&
          thread.settledAt === null &&
          thread.snoozedUntil == null &&
          thread.progressEstimate?.basedOnUpdatedAt !== thread.updatedAt,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 25);

    yield* Effect.forEach(
      candidates,
      (thread) =>
        Effect.gen(function* () {
          const detail = yield* snapshots.getThreadDetailById(thread.id, { activityKinds: [] });
          if (Option.isNone(detail)) {
            return;
          }
          const context = formatThreadProgressContext(detail.value.messages);
          if (context.length === 0) {
            return;
          }
          const cwd =
            resolveThreadWorkspaceCwd({ thread: detail.value, projects: snapshot.projects }) ??
            process.cwd();
          const generated = yield* textGeneration
            .generateProgressEstimate({ cwd, context, modelSelection })
            .pipe(Effect.timeout("3 minutes"));
          const uuid = yield* crypto.randomUUIDv4;
          const estimatedAt = DateTime.formatIso(yield* DateTime.now);
          // Stamp the estimate with the activity it was computed from. Activity
          // that lands during generation leaves the stamps mismatched, so the
          // next sweep re-estimates instead of trusting a stale number.
          yield* engine.dispatch({
            type: "thread.progress-estimate.set",
            commandId: CommandId.make(`server:progress-estimate:${thread.id}:${uuid}`),
            threadId: thread.id,
            estimate: {
              ...generated,
              estimatedAt,
              basedOnUpdatedAt: detail.value.updatedAt,
            },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("thread progress estimate skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      // Fork: one estimate at a time so a sweep never fans out into a burst
      // of parallel model calls; the 5-minute spacing starts after the sweep
      // ends, so a long sweep simply pushes the next one back.
      { concurrency: 1, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread progress estimate sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: ThreadProgressReactor["Service"]["start"] = Effect.fn("ThreadProgressReactor.start")(
    function* () {
      const settingsChanges = yield* settingsService.subscribeChanges;
      const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
      let lastSelection = initialSettings.progressEstimateModelSelection;
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.asVoid),
      );
      yield* forkParked(
        Stream.runForEach(settingsChanges, (settings) => {
          const enabled =
            lastSelection === null && settings.progressEstimateModelSelection !== null;
          lastSelection = settings.progressEstimateModelSelection;
          return enabled ? worker.enqueue(undefined) : Effect.void;
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies ThreadProgressReactor["Service"];
});

export const layer = Layer.effect(ThreadProgressReactor, make);
