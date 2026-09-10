import type { OrchestrationMessage } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

const CONTEXT_BUDGET = 40_000;
const USER_LIMIT = 4_000;
const ASSISTANT_LIMIT = 6_000;
const USER_TRUNCATION_MARKER = "[truncated]";
const ASSISTANT_TRUNCATION_MARKER = "[Earlier content truncated]\n";
const OMITTED_MARKER = "[Earlier assistant content omitted]";

export function formatThreadProgressContext(messages: ReadonlyArray<OrchestrationMessage>): string {
  const entries = messages.flatMap<{ role: "user" | "assistant"; formatted: string }>((message) => {
    if (message.role === "system") {
      return [];
    }
    const text =
      message.role === "assistant" ? assistantCitationsToPlainText(message.text) : message.text;
    if (text.trim().length === 0) {
      return [];
    }
    if (message.role === "user") {
      const content =
        text.length > USER_LIMIT
          ? `${text.slice(0, USER_LIMIT - USER_TRUNCATION_MARKER.length)}${USER_TRUNCATION_MARKER}`
          : text;
      return [{ role: message.role, formatted: `USER:\n${content}` }];
    }
    const content =
      text.length > ASSISTANT_LIMIT
        ? `${ASSISTANT_TRUNCATION_MARKER}${text.slice(-(ASSISTANT_LIMIT - ASSISTANT_TRUNCATION_MARKER.length))}`
        : text;
    return [{ role: message.role, formatted: `ASSISTANT:\n${content}` }];
  });

  const kept = new Set<number>();
  let remaining = CONTEXT_BUDGET + 2;
  const totalLength = entries.reduce((total, entry) => total + entry.formatted.length + 2, -2);
  if (totalLength > CONTEXT_BUDGET) {
    remaining -= OMITTED_MARKER.length + 2;
  }
  // Requests take priority even when they alone exceed the context budget.
  for (const [index, entry] of entries.entries()) {
    if (entry.role === "user") {
      kept.add(index);
      remaining -= entry.formatted.length + 2;
    }
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.role === "assistant" && entry.formatted.length + 2 <= remaining) {
      kept.add(index);
      remaining -= entry.formatted.length + 2;
    }
  }

  const context: string[] = [];
  let omissionMarked = false;
  for (const [index, entry] of entries.entries()) {
    if (kept.has(index)) {
      context.push(entry.formatted);
    } else if (!omissionMarked) {
      context.push(OMITTED_MARKER);
      omissionMarked = true;
    }
  }
  return context.join("\n\n");
}
