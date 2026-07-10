import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const startServer = async (overrides: Partial<ReturnType<typeof loadConfig>>) => {
  const app = createApp({ ...loadConfig(), ...overrides });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start app server");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const stopServer = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const seedCompleteCapture = async (baseUrl: string, sessionId: string) => {
  const rings = ["high", "middle", "low"] as const;
  for (let index = 0; index < 36; index += 1) {
    const stationIndex = index % 12;
    const photo = await fetch(`${baseUrl}/api/capture-sessions/${sessionId}/photos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "device",
        fileName: `station-${index}.jpg`,
        ring: rings[Math.floor(index / 12)],
        stationIndex,
        angleDeg: stationIndex * 30,
        overlapEstimate: 0.8,
        blurScore: 0.15,
        lightingScore: 0.85,
        distanceVariance: 0.1,
        jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      }),
    });
    assert.equal(photo.status, 201);
  }
};

test("live ion mode submits and maps queued/processing/completed statuses", async () => {
  const statusSequence = ["queued", "processing", "completed"];
  let pollCount = 0;
  let createCalls = 0;

  const ionServer = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/assets")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/assets") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "BadRequest", message: "Missing required asset fields." }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/reality-capture/gaussian-splats/jobs") {
      createCalls += 1;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { photos: unknown[] };
        assert.ok(parsed.photos.length >= 1);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jobId: "ion-job-1",
            assetId: 987654,
            statusPath: "/v1/reality-capture/gaussian-splats/jobs/ion-job-1",
          }),
        );
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/reality-capture/gaussian-splats/jobs/ion-job-1") {
      const status = statusSequence[Math.min(pollCount, statusSequence.length - 1)];
      pollCount += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status,
          progress: status === "queued" ? 10 : status === "processing" ? 62 : 100,
          message:
            status === "completed" ? "Ion complete" : status === "processing" ? "Ion processing" : "Ion queued",
          assetId: 987654,
          viewerUrl: "https://ion.cesium.com/assets/987654",
          thumbnailUrl: "https://ion.cesium.com/assets/987654/thumbnail.png",
          notes: "Live ion result",
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => ionServer.listen(0, resolve));
  const ionAddress = ionServer.address();
  assert.ok(ionAddress && typeof ionAddress !== "string");
  const ionBaseUrl = `http://127.0.0.1:${ionAddress.port}`;

  const { server, baseUrl } = await startServer({
    cesiumIonToken: "test-token",
    enableLiveIonSubmission: true,
    cesiumIonApiUrl: ionBaseUrl,
    allowMockResults: true,
  });

  try {
    const created = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    assert.equal(created.status, 201);
    const { session } = (await created.json()) as { session: { id: string } };
    await seedCompleteCapture(baseUrl, session.id);

    const submit = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        requestedPipeline: "gaussian_splats",
      }),
    });
    assert.equal(submit.status, 202);
    const submitted = (await submit.json()) as { jobId: string; integrationMode: string };
    assert.equal(submitted.integrationMode, "live");
    assert.equal(createCalls, 1);

    let terminalPayload:
      | {
          status: string;
          result?: {
            provider: string;
            ionAssetId?: number;
            splat?: { url?: string; thumbnailUrl?: string };
          };
        }
      | undefined;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/assets/jobs/${submitted.jobId}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        status: string;
        result?: {
          provider: string;
          ionAssetId?: number;
          splat?: { url?: string; thumbnailUrl?: string };
        };
      };
      if (payload.status === "completed") {
        terminalPayload = payload;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert.ok(terminalPayload, "Expected live ion job to reach completed status");
    assert.equal(terminalPayload?.result?.provider, "ion");
    assert.equal(terminalPayload?.result?.ionAssetId, 987654);
    assert.equal(terminalPayload?.result?.splat?.url, "https://ion.cesium.com/assets/987654");
    assert.equal(
      terminalPayload?.result?.splat?.thumbnailUrl,
      "https://ion.cesium.com/assets/987654/thumbnail.png",
    );
  } finally {
    await stopServer(server);
    await stopServer(ionServer);
  }
});

test("live ion 405 submission returns actionable endpoint/scope guidance", async () => {
  const ionServer = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/assets")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/assets") {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "Forbidden", message: "Token lacks write scope." }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/reality-capture/gaussian-splats/jobs") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "MethodNotAllowed", message: "POST is not allowed" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => ionServer.listen(0, resolve));
  const ionAddress = ionServer.address();
  assert.ok(ionAddress && typeof ionAddress !== "string");
  const ionBaseUrl = `http://127.0.0.1:${ionAddress.port}`;

  const { server, baseUrl } = await startServer({
    cesiumIonToken: "test-token",
    enableLiveIonSubmission: true,
    cesiumIonApiUrl: ionBaseUrl,
    allowMockResults: true,
  });
  try {
    const created = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    const { session } = (await created.json()) as { session: { id: string } };
    await seedCompleteCapture(baseUrl, session.id);

    const submit = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        requestedPipeline: "gaussian_splats",
      }),
    });
    assert.equal(submit.status, 502);
    const body = (await submit.json()) as { error: string };
    assert.match(body.error, /405 MethodNotAllowed/);
    assert.match(body.error, /POST is not allowed/);
    assert.match(body.error, /different\/partner endpoint/i);
    assert.match(body.error, /assets:write/i);
    assert.match(body.error, /mock mode/i);
  } finally {
    await stopServer(server);
    await stopServer(ionServer);
  }
});

test("blocked and mock integration paths remain unchanged", async () => {
  const { server, baseUrl } = await startServer({
    cesiumIonToken: null,
    allowMockResults: true,
    enableLiveIonSubmission: false,
  });
  try {
    const created = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    const { session } = (await created.json()) as { session: { id: string } };
    await seedCompleteCapture(baseUrl, session.id);

    const blockedSubmit = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        requestedPipeline: "gaussian_splats",
        mode: "ion",
      }),
    });
    assert.equal(blockedSubmit.status, 202);
    const blocked = (await blockedSubmit.json()) as { jobId: string; integrationMode: string };
    assert.equal(blocked.integrationMode, "blocked");

    const blockedStatus = await fetch(`${baseUrl}/api/assets/jobs/${blocked.jobId}`);
    const blockedBody = (await blockedStatus.json()) as { status: string };
    assert.equal(blockedBody.status, "blocked_no_credentials");

    const mockSubmit = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        requestedPipeline: "gaussian_splats",
        mode: "mock",
      }),
    });
    assert.equal(mockSubmit.status, 202);
    const mock = (await mockSubmit.json()) as { jobId: string; integrationMode: string };
    assert.equal(mock.integrationMode, "mock");
  } finally {
    await stopServer(server);
  }
});
