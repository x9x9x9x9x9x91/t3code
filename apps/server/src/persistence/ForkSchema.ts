import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork-only schema additions, applied after the numbered migrations on every
 * start. They stay out of the migration ledger on purpose: the ledger only
 * records the highest id, so a fork-numbered migration would make upstream's
 * next migration with the same number look already applied, and a database
 * touched by the fork must stay openable by the stock app and by next week's
 * rebase. Every step here is idempotent.
 */
export const applyForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "progress_estimate")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN progress_estimate TEXT
    `;
  }
});
