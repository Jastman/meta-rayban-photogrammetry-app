import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { getCapturePhotoData } from "../store.js";

test("native JSON upload retains DAT JPEG bytes and integrity metadata", async () => {
  const server = createServer(createApp(loadConfig()));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    const { session } = (await created.json()) as { session: { id: string } };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const uploaded = await fetch(`${baseUrl}/api/capture-sessions/${session.id}/photos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "device",
        fileName: "high-0.jpg",
        ring: "high",
        stationIndex: 0,
        angleDeg: 0,
        overlapEstimate: 0.85,
        blurScore: 0.1,
        lightingScore: 0.9,
        distanceVariance: 0.08,
        jpegBase64: jpeg.toString("base64"),
      }),
    });
    assert.equal(uploaded.status, 201);
    const body = (await uploaded.json()) as {
      photos: Array<{ id: string; fileSizeBytes: number; sha256: string }>;
    };
    assert.equal(body.photos[0]?.fileSizeBytes, jpeg.byteLength);
    assert.equal(body.photos[0]?.sha256.length, 64);
    assert.deepEqual(getCapturePhotoData(body.photos[0]!.id), jpeg);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
