import assert from "node:assert/strict";
import test from "node:test";
import { JobStatusMonitor, type JobStatusEvent } from "../jobEvents.js";
import type { JobStatusPayload } from "../jobStatus.js";

test("job monitor emits only status transitions and stops after a terminal status", () => {
  let payload: JobStatusPayload = { status: "queued", progress: 15, message: "Queued" };
  const monitor = new JobStatusMonitor(() => payload, 60_000);
  const events: JobStatusEvent[] = [];
  const unsubscribe = monitor.subscribe("job-1", (event) => events.push(event));

  assert.ok(unsubscribe);
  monitor.refresh("job-1");
  payload = { status: "processing", progress: 70, message: "Processing" };
  monitor.refresh("job-1");
  monitor.refresh("job-1");
  payload = { status: "completed_mock", progress: 100, message: "Complete" };
  monitor.refresh("job-1");
  monitor.refresh("job-1");

  assert.deepEqual(events.map((event) => event.payload.status), [
    "queued",
    "processing",
    "completed_mock",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  unsubscribe();
});
