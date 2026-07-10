import assert from "node:assert/strict";
import test from "node:test";
import { movementForStation, stationAt } from "./capture-sequence.js";

test("capture sequence advances deterministically through three 12-station rings", () => {
  assert.deepEqual(stationAt(0), { ring: "high", stationIndex: 0, angleDeg: 0 });
  assert.deepEqual(stationAt(11), { ring: "high", stationIndex: 11, angleDeg: 330 });
  assert.deepEqual(stationAt(12), { ring: "middle", stationIndex: 0, angleDeg: 0 });
  assert.deepEqual(stationAt(24), { ring: "low", stationIndex: 0, angleDeg: 0 });
  assert.deepEqual(stationAt(35), { ring: "low", stationIndex: 11, angleDeg: 330 });
  assert.equal(stationAt(36), null);
});

test("movement guidance changes from ring setup to physical orbit movement", () => {
  assert.equal(movementForStation(stationAt(0)).instruction, "HOLD STEADY · CAPTURE");
  assert.equal(movementForStation(stationAt(1)).instruction, "MOVE RIGHT 30°");
  assert.equal(movementForStation(stationAt(12)).instruction, "LOWER TO MID LEVEL");
  assert.equal(movementForStation(stationAt(24)).instruction, "LOWER CAMERA");
  assert.equal(movementForStation(stationAt(36)).instruction, "ALL ORBITS COMPLETE");
});
