import { describe, expect, it } from "vitest";
import * as F from "@/features/retro-office/core/furnitureDefaults";

const defaultOffice = () =>
  F.ensureOfficeKanbanBoard(F.ensureOfficeJukebox(F.ensureOfficeQaLab(F.ensureOfficeGymRoom(
    F.ensureOfficeServerRoom(F.ensureOfficePhoneBooth(F.ensureOfficeSmsBooth(F.ensureOfficeAtm(
      F.ensureOfficePingPongTable(F.materializeDefaults("office"))))))))));

describe("built-in room floors follow their walls", () => {
  it("shows gym and QA lab floors in the default layout", () => {
    const items = defaultOffice();
    expect(F.hasGymRoomWalls(items)).toBe(true);
    expect(F.hasQaLabWalls(items)).toBe(true);
  });

  it("hides a room's floor once one of its walls is deleted", () => {
    const items = defaultOffice();
    for (const check of [F.hasGymRoomWalls, F.hasQaLabWalls]) {
      const wallIndex = items.findIndex((item) => item.type === "wall" && !check(items.filter((other) => other !== item)));
      expect(wallIndex).toBeGreaterThanOrEqual(0); // that room has at least one detectable wall
      expect(check(items.filter((_, index) => index !== wallIndex))).toBe(false);
    }
  });

  it("is unaffected by deleting unrelated furniture", () => {
    const items = defaultOffice().filter((item) => item.type !== "plant");
    expect(F.hasGymRoomWalls(items)).toBe(true);
    expect(F.hasQaLabWalls(items)).toBe(true);
  });
});
