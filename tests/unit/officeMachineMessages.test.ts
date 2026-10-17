import { describe, expect, it } from "vitest";
import { resolveOfficeIntentSnapshot } from "@/lib/office/deskDirectives";

const active = (text: string) =>
  Object.entries(resolveOfficeIntentSnapshot(text))
    .filter(([key, value]) => key !== "normalized" && value)
    .map(([key]) => key);

describe("machine messages never drive character movement", () => {
  it("ignores heartbeat prompts and team briefs", () => {
    expect(active("[Heartbeat 2026-10-17T12:58:03Z]\nReview the Kanban board (task-manager skill). If needed, tell the CTO in one short message.")).toEqual([]);
    expect(active("[Team] CTO here, meeting: plan the gym booking API, then call QA")).toEqual([]);
  });

  it("still reacts to what a person types", () => {
    expect(active("go to the gym and train your skills").length).toBeGreaterThan(0);
  });
});
