import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatThreadProgressContext } from "./ThreadProgressContext.ts";

function message(role: OrchestrationMessage["role"], text: string): OrchestrationMessage {
  return {
    id: MessageId.make("message"),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("formatThreadProgressContext", () => {
  it("preserves chronological order, including later user requests", () => {
    expect(
      formatThreadProgressContext([
        message("user", "Build it"),
        message("assistant", "Built it"),
        message("user", "Now test it"),
        message("assistant", "Tests pending"),
      ]),
    ).toBe(
      "USER:\nBuild it\n\nASSISTANT:\nBuilt it\n\nUSER:\nNow test it\n\nASSISTANT:\nTests pending",
    );
  });

  it("keeps the end of a long assistant message within its cap", () => {
    const context = formatThreadProgressContext([
      message("assistant", `START${"x".repeat(6_000)}Tests still failing`),
    ]);
    expect(context.startsWith("ASSISTANT:\n[Earlier content truncated]\n")).toBe(true);
    expect(context.endsWith("Tests still failing")).toBe(true);
    expect(context).not.toContain("START");
    expect(context.length).toBe("ASSISTANT:\n".length + 6_000);
  });

  it("keeps every user request when assistant content overflows the budget", () => {
    const messages = Array.from({ length: 12 }, (_, index) => [
      message("user", `Request ${index}`),
      message("assistant", `Answer ${index}: ${"x".repeat(6_000)}`),
    ]).flat();
    const context = formatThreadProgressContext(messages);
    for (let index = 0; index < 12; index++) {
      expect(context).toContain(`USER:\nRequest ${index}`);
    }
    expect(context.length).toBeLessThanOrEqual(40_000);
  });

  it("marks the first dropped assistant position exactly once", () => {
    const context = formatThreadProgressContext([
      message("user", "Original request"),
      ...Array.from({ length: 12 }, () => message("assistant", "x".repeat(6_000))),
      message("user", "Follow-up request"),
      message("assistant", "Latest status"),
    ]);
    expect(context.match(/\[Earlier assistant content omitted\]/g)).toHaveLength(1);
    expect(
      context.startsWith("USER:\nOriginal request\n\n[Earlier assistant content omitted]"),
    ).toBe(true);
    expect(context.endsWith("USER:\nFollow-up request\n\nASSISTANT:\nLatest status")).toBe(true);
  });

  it("ignores system messages and empty text", () => {
    expect(formatThreadProgressContext([message("system", "Internal"), message("user", "")])).toBe(
      "",
    );
    expect(
      formatThreadProgressContext([message("system", "Internal"), message("user", "Request")]),
    ).toBe("USER:\nRequest");
    expect(formatThreadProgressContext([])).toBe("");
  });

  it("keeps the start of long user messages with a truncation marker", () => {
    const context = formatThreadProgressContext([
      message("user", `Request${"x".repeat(4_000)}END`),
    ]);
    expect(context.startsWith("USER:\nRequest")).toBe(true);
    expect(context.endsWith("[truncated]")).toBe(true);
    expect(context).not.toContain("END");
    expect(context.length).toBe("USER:\n".length + 4_000);
  });
});
