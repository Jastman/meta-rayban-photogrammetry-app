import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createApp } from "../app.js";

const startTestServer = async () => {
  const app = createApp({
    ...loadConfig(),
    cesiumIonToken: null,
    allowMockResults: true,
    enableLiveIonSubmission: false,
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

test("capture flow gates reconstruction until quality thresholds are met", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const createSession = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    assert.equal(createSession.status, 201);
    const createdBody = (await createSession.json()) as {
      session: { id: string };
    };
    const sessionId = createdBody.session.id;

    const jobAttempt = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        requestedPipeline: "gaussian_splats",
      }),
    });

    test("device JPEG upload persists bytes and advances deterministic guidance", async () => {
      const { server, baseUrl } = await startTestServer();
      try {
        const createSession = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
        const createdBody = (await createSession.json()) as { session: { id: string } };
        const response = await fetch(
          `${baseUrl}/api/capture-sessions/${createdBody.session.id}/photos/upload`,
          {
            method: "POST",
            headers: {
              "content-type": "image/jpeg",
              "x-capture-file-name": "high-01.jpg",
              "x-capture-ring": "high",
              "x-capture-station-index": "0",
              "x-capture-overlap-estimate": "0.74",
              "x-capture-blur-score": "0.22",
              "x-capture-lighting-score": "0.75",
              "x-capture-distance-variance": "0.18",
            },
            body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          },
        );
        assert.equal(response.status, 201);
        const body = (await response.json()) as {
          photos: Array<{ source: string; imageFilePath?: string }>;
          guidance: { completedStationCount: number; nextStation: { stationIndex: number } };
        };
        assert.equal(body.photos[0]?.source, "device");
        assert.ok(body.photos[0]?.imageFilePath);
        assert.equal(body.guidance.completedStationCount, 1);
        assert.equal(body.guidance.nextStation.stationIndex, 1);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
    assert.equal(jobAttempt.status, 422);

    const rings = ["high", "middle", "low"] as const;
    for (let index = 0; index < 36; index += 1) {
      const stationIndex = index % 12;
      const payload = {
        source: "simulated",
        fileName: `sim-${index}.jpg`,
        ring: rings[Math.floor(index / 12)],
        stationIndex,
        angleDeg: stationIndex * 30,
        overlapEstimate: 0.74,
        blurScore: 0.22,
        lightingScore: 0.75,
        distanceVariance: 0.18,
      };
      const addPhoto = await fetch(`${baseUrl}/api/capture-sessions/${sessionId}/photos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(addPhoto.status, 201);
      const addPhotoBody = (await addPhoto.json()) as {
        guidance: {
          completedStationCount: number;
          nextStation: { ring: string; stationIndex: number } | null;
        };
      };
      assert.equal(addPhotoBody.guidance.completedStationCount, index + 1);
      if (index < 35) {
        assert.deepEqual(addPhotoBody.guidance.nextStation, {
          ring: rings[Math.floor((index + 1) / 12)],
          stationIndex: (index + 1) % 12,
          angleDeg: ((index + 1) % 12) * 30,
        });
      } else {
        assert.equal(addPhotoBody.guidance.nextStation, null);
      }
      if (index === 11 || index === 23 || index === 34) {
        const incompleteAttempt = await fetch(`${baseUrl}/api/assets/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, requestedPipeline: "gaussian_splats" }),
        });
        assert.equal(incompleteAttempt.status, 422);
      }

      if (index === 23) {
        const twoRingAttempt = await fetch(`${baseUrl}/api/assets/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, requestedPipeline: "gaussian_splats" }),
        });
        assert.equal(twoRingAttempt.status, 422);
        const twoRingBody = (await twoRingAttempt.json()) as { unmetCriteria: string[] };
        assert.ok(twoRingBody.unmetCriteria.includes("minPhotoCountMet"));
        assert.ok(twoRingBody.unmetCriteria.includes("threeOrbitCoverageMet"));
      }
    }

    const submitJob = await fetch(`${baseUrl}/api/assets/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        requestedPipeline: "gaussian_splats",
      }),
    });
    assert.equal(submitJob.status, 202);
    const submitBody = (await submitJob.json()) as { integrationMode: string };
    assert.equal(submitBody.integrationMode, "mock");

    const blockedJob = await fetch(`${baseUrl}/api/reconstruction-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        requestedPipeline: "gaussian_splats",
        mode: "ion",
      }),
    });
    assert.equal(blockedJob.status, 202);
    const blockedSubmission = (await blockedJob.json()) as {
      jobId: string;
      integrationMode: string;
    };
    assert.equal(blockedSubmission.integrationMode, "blocked");
    const blockedEvents = await fetch(
      `${baseUrl}/api/reconstruction-jobs/${blockedSubmission.jobId}/events`,
    );
    const blockedStream = await blockedEvents.text();
    assert.match(blockedStream, /"status":"blocked_no_credentials"/);
    assert.doesNotMatch(blockedStream, /"status":"completed/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("glasses HUD serves a bounded layout with a persistent reconstruction action", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const [pageResponse, stylesResponse, appResponse, logoResponse] = await Promise.all([
      fetch(baseUrl),
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/assets/Cesium_logo_only.svg`),
    ]);
    assert.equal(pageResponse.status, 200);
    assert.equal(stylesResponse.status, 200);
    assert.equal(appResponse.status, 200);
    assert.equal(logoResponse.status, 200);

    const [page, styles, app, logo] = await Promise.all([
      pageResponse.text(),
      stylesResponse.text(),
      appResponse.text(),
      logoResponse.text(),
    ]);
    assert.match(page, /class="camera-preview"/);
    assert.match(page, /id="browser-preview-btn"[^>]*>Use Browser Camera/);
    assert.match(page, /SIMULATED PREVIEW/);
    assert.match(page, /Not the Meta glasses camera/);
    assert.match(page, /class="capture-actions"/);
    assert.match(page, /id="submit-job-btn"[^>]*>Submit Reconstruction/);
    assert.match(page, /assets\/Cesium_logo_only\.svg/);
    assert.match(page, /CESIUM SPLAT CAPTURE/);
    assert.match(page, /PROTOTYPE/);
    assert.match(page, /Powered by Cesium ion/);
    assert.match(page, /id="notification-btn"/);
    assert.match(page, /On-glasses background alerts are unavailable/);
    assert.match(styles, /height:\s*min\(100dvh,\s*600px\)/);
    assert.match(styles, /--accent:\s*#6dabe4/);
    assert.match(styles, /--cesium-green:\s*#709c49/);
    assert.match(styles, /--cesium-dark:\s*#0e1422/);
    assert.match(styles, /\.screen\s*\{[^}]*overflow:\s*hidden/s);
    assert.doesNotMatch(styles, /\.screen\s*\{[^}]*overflow:\s*auto/s);
    assert.match(styles, /#capture-screen\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)[^}]*42px/s);
    assert.match(app, /state\.guidance\?\.nextStation/);
    assert.match(app, /navigator\.mediaDevices\?\.getUserMedia/);
    assert.match(app, /subscribePreviewFrames/);
    assert.match(app, /new EventSource/);
    assert.match(app, /Notification\.requestPermission\(\)/);
    assert.match(app, /requestReconstructionNotification/);
    assert.match(app, /"job-status"/);
    assert.doesNotMatch(app, /serviceWorker|PushManager/);
    assert.doesNotMatch(app, /Math\.random/);
    assert.match(logo, /viewBox="0 0 121\.64 121\.78"/);
    assert.match(logo, /\.st1\{fill:#709C49;\}/);
    assert.match(logo, /\.st2\{fill:#6DABE4;\}/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("job event stream emits each mock transition once through completion", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const createSession = await fetch(`${baseUrl}/api/capture-sessions`, { method: "POST" });
    const createdBody = (await createSession.json()) as { session: { id: string } };
    const rings = ["high", "middle", "low"] as const;
    const photos = rings.flatMap((ring) =>
      Array.from({ length: 12 }, (_, stationIndex) => ({
        source: "simulated",
        fileName: `${ring}-${stationIndex}.jpg`,
        ring,
        stationIndex,
        angleDeg: stationIndex * 30,
        overlapEstimate: 0.78,
        blurScore: 0.18,
        lightingScore: 0.78,
        distanceVariance: 0.12,
      })),
    );
    const addPhotos = await fetch(
      `${baseUrl}/api/capture-sessions/${createdBody.session.id}/photos`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photos }),
      },
    );
    assert.equal(addPhotos.status, 201);

    const submitJob = await fetch(`${baseUrl}/api/reconstruction-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: createdBody.session.id,
        requestedPipeline: "gaussian_splats",
        mode: "mock",
      }),
    });
    const submitted = (await submitJob.json()) as { jobId: string };
    const stream = await fetch(`${baseUrl}/api/reconstruction-jobs/${submitted.jobId}/events`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(stream.body);

    const statuses: string[] = [];
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!statuses.includes("completed_mock")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) {
          statuses.push((JSON.parse(data.slice(6)) as { status: string }).status);
        }
      }
    }

    assert.deepEqual(statuses, ["queued", "processing", "completed_mock"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
