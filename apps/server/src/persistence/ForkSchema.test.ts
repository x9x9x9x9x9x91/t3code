import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { applyForkSchema } from "./ForkSchema.ts";

it.layer(NodeSqliteClient.layerMemory())("ForkSchema", (it) => {
  it.effect("adds nullable estimates without changing activity and can run again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* applyForkSchema;
      const migrated = yield* sql<{ readonly estimate: string | null; readonly updatedAt: string }>`
        SELECT progress_estimate AS estimate, updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ estimate: null, updatedAt: now }]);
      const estimate =
        '{"percent":50,"summary":"Tests remain.","estimatedAt":"2026-01-01T00:00:00.000Z","basedOnUpdatedAt":"2026-01-01T00:00:00.000Z"}';
      yield* sql`UPDATE projection_threads SET progress_estimate = ${estimate} WHERE thread_id = 'thread-1'`;
      yield* applyForkSchema;
      const rows = yield* sql<{ readonly estimate: string; readonly updatedAt: string }>`
        SELECT progress_estimate AS estimate, updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ estimate, updatedAt: now }]);
    }),
  );
});
