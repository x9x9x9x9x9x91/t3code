import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  TextGeneration,
  type ProgressEstimateGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadProgressReactor from "./ThreadProgressReactor.ts";

const NOW = "2026-09-01T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("progress-project");
const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const ESTIMATE = { percent: 50, summary: "Verification remains." };
const ENABLED_SETTINGS = {
  ...DEFAULT_SERVER_SETTINGS,
  progressEstimateModelSelection: MODEL_SELECTION,
};
// The fork defaults the estimator on; the disabled case is explicit.
const DISABLED_SETTINGS = {
  ...DEFAULT_SERVER_SETTINGS,
  progressEstimateModelSelection: null,
};

type ProgressCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.progress-estimate.set" }
>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: NOW,
      },
    ],
    threads,
    updatedAt: NOW,
  };
}

function makeDetail(thread: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...thread,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make(`message-${thread.id}`),
        role: "user",
        text: `Finish ${thread.id}`,
        turnId: null,
        streaming: false,
        createdAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly settings?: ServerSettings;
  readonly generate?: TextGeneration["Service"]["generateProgressEstimate"];
  readonly detail?: (thread: OrchestrationThreadShell) => OrchestrationThread;
}

const makeHarness = Effect.fn("makeThreadProgressHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const settings = yield* Ref.make(options.settings ?? ENABLED_SETTINGS);
  const settingsReads = yield* Queue.unbounded<ServerSettings>();
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const commands = yield* Ref.make<ReadonlyArray<ProgressCommand>>([]);
  const generationCalls = yield* Ref.make<ReadonlyArray<ProgressEstimateGenerationInput>>([]);

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.progress-estimate.set") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(
        Ref.update(snapshots, (snapshot) => ({
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === command.threadId
              ? { ...thread, progressEstimate: command.estimate }
              : thread,
          ),
        })),
      ),
      Effect.as({ sequence: 1 }),
    );
  };
  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings).pipe(Effect.tap((value) => Queue.offer(settingsReads, value))),
    updateSettings,
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => Ref.get(snapshots),
      getThreadDetailById: (threadId, query) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) => {
            assert.deepStrictEqual(query, { activityKinds: [] });
            return Option.fromNullishOr(
              snapshot.threads.find((thread) => thread.id === threadId),
            ).pipe(Option.map(options.detail ?? makeDetail));
          }),
        ),
      getThreadShellById: (threadId) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) =>
            Option.fromNullishOr(snapshot.threads.find((thread) => thread.id === threadId)),
          ),
        ),
    }),
    Layer.mock(TextGeneration)({
      generateProgressEstimate: (input) =>
        Ref.update(generationCalls, (calls) => [...calls, input]).pipe(
          Effect.andThen(options.generate?.(input) ?? Effect.succeed(ESTIMATE)),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({ dispatch }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  return {
    activation,
    snapshots,
    settingsReads,
    commands,
    generationCalls,
    updateSettings,
    layer: ThreadProgressReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadProgressHarness")(function* (
  reactor: ThreadProgressReactor.ThreadProgressReactor["Service"],
  fixture: Effect.Success<ReturnType<typeof makeHarness>>,
) {
  yield* reactor.start();
  yield* Queue.take(fixture.settingsReads);
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.settingsReads);
  yield* reactor.drain;
});

describe("ThreadProgressReactor", () => {
  it.effect("does no generation while disabled and sweeps when enabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("active")]),
          settings: DISABLED_SETTINGS,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* startHarness(reactor, fixture);
          yield* TestClock.adjust("10 minutes");
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.generationCalls), []);

          yield* fixture.updateSettings({ progressEstimateModelSelection: MODEL_SELECTION });
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.generationCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips current estimates and re-estimates only after activity changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const current = makeThread("current");
        const active = makeThread("active", { worktreePath: "/workspace/worktree" });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            {
              ...current,
              progressEstimate: {
                ...ESTIMATE,
                estimatedAt: NOW,
                basedOnUpdatedAt: current.updatedAt,
              },
            },
            active,
          ]),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* startHarness(reactor, fixture);
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 1);
          assert.strictEqual(commands[0]?.threadId, active.id);
          assert.deepStrictEqual(commands[0]?.estimate, {
            ...ESTIMATE,
            estimatedAt: NOW,
            basedOnUpdatedAt: active.updatedAt,
          });
          assert.deepStrictEqual(yield* Ref.get(fixture.generationCalls), [
            {
              cwd: "/workspace/worktree",
              context: "USER:\nFinish active",
              modelSelection: MODEL_SELECTION,
            },
          ]);

          yield* TestClock.adjust("10 minutes");
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 1);
          yield* Ref.update(fixture.snapshots, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) =>
              thread.id === active.id ? { ...thread, updatedAt: NOW } : thread,
            ),
          }));
          yield* TestClock.adjust("10 minutes");
          yield* Queue.take(fixture.settingsReads);
          yield* reactor.drain;
          const updated = yield* Ref.get(fixture.commands);
          assert.strictEqual(updated.length, 2);
          assert.strictEqual(updated[1]?.estimate?.basedOnUpdatedAt, NOW);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips a failed generation without aborting other threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("failed"), makeThread("success")]),
          generate: ({ context }) =>
            context.includes("failed")
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateProgressEstimate",
                    detail: "Generation failed",
                  }),
                )
              : Effect.succeed(ESTIMATE),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* startHarness(reactor, fixture);
          assert.strictEqual((yield* Ref.get(fixture.generationCalls)).length, 2);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("success")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("stamps the estimate with the activity it was built from", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generationStarted = yield* Deferred.make<void>();
        const finishGeneration = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("active")]),
          generate: () =>
            Deferred.succeed(generationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishGeneration)),
              Effect.as(ESTIMATE),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Deferred.await(generationStarted);
          yield* Ref.update(fixture.snapshots, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) => ({ ...thread, updatedAt: NOW })),
          }));
          yield* Deferred.succeed(finishGeneration, undefined);
          yield* reactor.drain;
          // Activity during generation must leave the stamp behind updatedAt so
          // the next sweep re-estimates.
          assert.notStrictEqual(
            (yield* Ref.get(fixture.commands))[0]?.estimate?.basedOnUpdatedAt,
            NOW,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("times out a stuck generation while other threads finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generationStarted = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("stuck"), makeThread("success")]),
          generate: ({ context }) =>
            context.includes("stuck")
              ? Deferred.succeed(generationStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(ESTIMATE),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Deferred.await(generationStarted);
          yield* TestClock.adjust("3 minutes");
          yield* reactor.drain;
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("success")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("caps each sweep at the 25 newest candidates and two simultaneous generations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bothStarted = yield* Deferred.make<void>();
        const finishGeneration = yield* Deferred.make<void>();
        const inFlight = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            Array.from({ length: 30 }, (_, index) =>
              makeThread(`thread-${index}`, {
                updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
              }),
            ),
          ),
          generate: () =>
            Effect.gen(function* () {
              const active = yield* Ref.updateAndGet(inFlight, (count) => count + 1);
              yield* Ref.update(peak, (count) => Math.max(count, active));
              if (active === 2) {
                yield* Deferred.succeed(bothStarted, undefined);
              }
              yield* Deferred.await(finishGeneration);
              yield* Ref.update(inFlight, (count) => count - 1);
              return ESTIMATE;
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Deferred.await(bothStarted);
          assert.strictEqual((yield* Ref.get(fixture.generationCalls)).length, 2);
          yield* Deferred.succeed(finishGeneration, undefined);
          yield* reactor.drain;
          assert.strictEqual(yield* Ref.get(peak), 2);
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 25);
          assert.deepStrictEqual(
            new Set(commands.map((command) => command.threadId)),
            new Set(Array.from({ length: 25 }, (_, index) => ThreadId.make(`thread-${index + 5}`))),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips settled, archived, snoozed and empty threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("settled", { settledOverride: "settled" }),
            makeThread("auto-settled", { settledAt: NOW }),
            makeThread("archived", { archivedAt: NOW }),
            makeThread("snoozed", { snoozedUntil: NOW }),
            makeThread("empty"),
          ]),
          detail: (thread) => ({ ...makeDetail(thread), messages: [] }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadProgressReactor.ThreadProgressReactor;
          yield* startHarness(reactor, fixture);
          assert.deepStrictEqual(yield* Ref.get(fixture.generationCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
