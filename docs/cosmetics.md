# Cosmetics index

Hygiene and cosmetic notes a review seat raised on a verdict that still
passed. A PASS lands as it is and only Changes Requested opens a fix round
([review by risk](../claude-docs/worker-protocol.md)), so the note is
recorded here instead of buying a round for it. The coordinator appends the
row at verdict time, in the same breath as the comment it posts on the ticket.
A grill session sweeps the open rows in one pass and flips them to `swept`;
a lane that touches the file anyway may take one and flip it too.

A row names the sha the note was raised at, so its `file:line` still resolves
after the file moves under it.

A row lives in the repo whose file it names, and the sha is that repo's; a row
written while the file lived in alma says `(alma)` after the sha. One such
index per git repo under `~/Coding`; Substrate's cosmetics reminder counts the
open rows of each.

| Date       | Issue   | File:line                                                                           | Note                                                                                                                                                                                                                                                                                                                                                    | Status |
| ---------- | ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-09-17 | ALM-340 | `docs/internals/preview-automation.md:47-52` @ fb1c728                              | "Every bridge call a request makes spends the request's host deadline" over-claims: `recordingStart`/`recordingStop` bridge calls (`browserRecording.ts:565,542,675,706`) carry their own media settle timeouts, not the request deadline; same over-claim existed at base. Qualify the sentence or name recording as the exception (r1 seat). T3 fork. | open   |
| 2026-09-17 | ALM-340 | `apps/web/src/components/preview/PreviewAutomationHosts.test.tsx:414-497` @ fb1c728 | the two navigate tests are near-duplicates (differ in the request event and the `mocks.open` assertion); a shared helper would halve them (r1 seat). T3 fork.                                                                                                                                                                                           | open   |
| 2026-09-17 | ALM-340 | `apps/web/src/components/preview/PreviewAutomationHosts.tsx:258` @ fb1c728          | the added `tabId &&` only narrows the type for `bounded(tabId, ...)`; a one-word comment would stop the next reader wondering (r1 seat). T3 fork.                                                                                                                                                                                                       | open   |
| 2026-09-17 | ALM-340 | review-seat note @ fb1c728                                                          | a scratch worktree whose `node_modules` are plain symlinks to the main tree resolves `@t3tools/contracts` to the main tree's sources, so a `satisfies` probe passes spuriously; link per-package `node_modules` entries individually (r1 seat). T3 fork.                                                                                                | open   |
