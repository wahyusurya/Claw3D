import { describe, expect, it } from "vitest";
import * as F from "@/features/retro-office/core/furnitureDefaults";
import {
  astar,
  buildNavGrid,
  getMeetingSeatLocations,
  nearestReachablePoint,
} from "@/features/retro-office/core/navigation";

const defaultOffice = () =>
  F.ensureOfficeKanbanBoard(F.ensureOfficeJukebox(F.ensureOfficeQaLab(F.ensureOfficeGymRoom(
    F.ensureOfficeServerRoom(F.ensureOfficePhoneBooth(F.ensureOfficeSmsBooth(F.ensureOfficeAtm(
      F.ensureOfficePingPongTable(F.materializeDefaults("office"))))))))));

describe("nearestReachablePoint", () => {
  it("returns the target's own cell when it is reachable", () => {
    const grid = buildNavGrid([]);
    expect(nearestReachablePoint(500, 500, 612, 612, grid)).toEqual({ x: 612.5, y: 612.5 });
  });

  it("stops at the closest reachable cell outside a sealed room", () => {
    // 4 walls enclosing x/y 300..500 with no gap.
    const walls = [
      { _uid: "t", type: "wall", x: 300, y: 300, w: 200, h: 8 },
      { _uid: "b", type: "wall", x: 300, y: 492, w: 200, h: 8 },
      { _uid: "l", type: "wall", x: 300, y: 300, w: 8, h: 200 },
      { _uid: "r", type: "wall", x: 492, y: 300, w: 8, h: 200 },
    ] as unknown as Parameters<typeof buildNavGrid>[0];
    const grid = buildNavGrid(walls);
    expect(astar(900, 400, 400, 400, grid)).toEqual([]); // sealed: no path to the inside
    const point = nearestReachablePoint(900, 400, 400, 400, grid)!;
    expect(point.x).toBeGreaterThan(500); // stays outside the room, on the near side
    expect(astar(900, 400, point.x, point.y, grid).length).toBeGreaterThan(0);
  });
});

describe("default office meeting seats", () => {
  it("every seat yields a walkable meeting target from the main floor", () => {
    const furniture = defaultOffice();
    const grid = buildNavGrid(furniture);
    const seats = getMeetingSeatLocations(furniture);
    expect(seats.length).toBeGreaterThan(1);
    for (const seat of seats) {
      const direct = astar(900, 500, seat.x, seat.y, grid);
      const target = direct.length > 0 ? seat : nearestReachablePoint(900, 500, seat.x, seat.y, grid)!;
      const path = astar(900, 500, target.x, target.y, grid);
      expect(path.length).toBeGreaterThan(0);
      const end = path[path.length - 1];
      expect(Math.hypot(end.x - target.x, end.y - target.y)).toBeLessThan(18); // counts as "arrived"
    }
  });
});
