import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalTransitionTracker,
  isTerminalStatus,
  SUCCESS_STATUSES,
} from "./reconstruction-notifications.js";

test("terminal status classification separates success from blocked and failed outcomes", () => {
  assert.equal(isTerminalStatus("queued"), false);
  assert.equal(isTerminalStatus("processing"), false);
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("completed_mock"), true);
  assert.equal(isTerminalStatus("blocked_no_credentials"), true);
  assert.equal(isTerminalStatus("failed_live_not_implemented"), true);
  assert.equal(SUCCESS_STATUSES.has("failed_live_not_implemented"), false);
});

test("terminal transition handling is idempotent across repeated events and reconnects", () => {
  const tracker = createTerminalTransitionTracker();
  const completion = { jobId: "job-1", status: "completed_mock" };
  assert.equal(tracker.shouldHandle({ jobId: "job-1", status: "processing" }), false);
  assert.equal(tracker.shouldHandle(completion), true);
  assert.equal(tracker.shouldHandle(completion), false);
  assert.equal(tracker.shouldHandle({ jobId: "job-1", status: "failed_live_not_implemented" }), false);
  assert.equal(tracker.shouldHandle({ jobId: "job-2", status: "blocked_no_credentials" }), true);
});
