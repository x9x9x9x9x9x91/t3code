import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const estimate = {
  percent: 50,
  summary: "Verification remains.",
  estimatedAt: "2026-01-02T00:00:00.000Z",
  basedOnUpdatedAt: NOW,
};
const command = {
  type: "thread.progress-estimate.set",
  commandId: CommandId.make("cmd-progress"),
  threadId: THREAD_ID,
  estimate,
} as const;

it.layer(NodeServices.layer)("thread progress estimates", (it) => {
  it.effect("sets and clears estimates on archived threads without changing activity", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({ archivedAt: NOW });
      for (const progressEstimate of [estimate, null]) {
        const decided = yield* decideOrchestrationCommand({
          command: { ...command, estimate: progressEstimate },
          readModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.meta-updated",
          payload: { threadId: THREAD_ID, progressEstimate, updatedAt: NOW },
        });
        for (const event of events) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        expect(readModel.threads[0]).toMatchObject({
          progressEstimate,
          updatedAt: NOW,
          archivedAt: NOW,
        });
      }
    }),
  );

  it.effect("rejects missing and deleted threads", () =>
    Effect.gen(function* () {
      for (const readModel of [
        makeReadModel({ deletedAt: NOW }),
        { ...makeReadModel(), threads: [] },
      ]) {
        const error = yield* decideOrchestrationCommand({ command, readModel }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
