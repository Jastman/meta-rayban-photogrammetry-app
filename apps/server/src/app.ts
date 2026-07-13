import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import cors from "cors";
import express from "express";
import { z } from "zod";
import type { CompanionReconstructionRequest } from "@prototype/native-companion-contract";
import type { ServerConfig } from "./config.js";
import { CAPTURE_THRESHOLDS, summarizeGuidance } from "./guidance.js";
import { JobStatusMonitor } from "./jobEvents.js";
import { evaluateJobStatus, isTerminalJobStatus } from "./jobStatus.js";
import { initializeIonLiveJob, refreshIonLiveJob, checkIonReadiness } from "./ionLive.js";
import type { IonReadinessStatus } from "./ionLive.js";
import {
  createAssetJob,
  createCaptureSession,
  getAssetJob,
  getCaptureSession,
  updateAssetJob,
  saveCapturePhotoData,
  saveCaptureSession,
} from "./store.js";
import type { CapturePhotoMetrics } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "../../glasses-web");

const addPhotoSchema = z.object({
  source: z.enum(["simulated", "upload", "browser", "device"]).default("simulated"),
  fileName: z.string().min(1),
  ring: z.enum(["high", "middle", "low"]),
  stationIndex: z.number().int().min(0).max(11),
  angleDeg: z.number().min(0).max(359),
  overlapEstimate: z.number().min(0).max(1),
  blurScore: z.number().min(0).max(1),
  lightingScore: z.number().min(0).max(1),
  distanceVariance: z.number().min(0).max(1),
  jpegBase64: z
    .string()
    .max(12_000_000)
    .refine((value) => {
      const bytes = Buffer.from(value, "base64");
      return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
    }, "jpegBase64 must contain JPEG image data")
    .optional(),
});

const addPhotosSchema = z.object({
  photos: z.array(addPhotoSchema).min(1).max(128),
});

const uploadHeadersSchema = z.object({
  fileName: z.string().min(1),
  ring: z.enum(["high", "middle", "low"]),
  stationIndex: z.coerce.number().int().min(0).max(11),
  overlapEstimate: z.coerce.number().min(0).max(1),
  blurScore: z.coerce.number().min(0).max(1),
  lightingScore: z.coerce.number().min(0).max(1),
  distanceVariance: z.coerce.number().min(0).max(1),
});

const createJobSchema = z.object({
  sessionId: z.string().uuid(),
  requestedPipeline: z.literal("gaussian_splats").default("gaussian_splats"),
  mode: z.enum(["auto", "mock", "ion"]).default("auto"),
  useMockFallback: z.boolean().default(true),
});

const parsePhotoInput = (input: z.infer<typeof addPhotoSchema>): CapturePhotoMetrics => {
  const id = randomUUID();
  const image = input.jpegBase64 ? Buffer.from(input.jpegBase64, "base64") : undefined;
  if (image) {
    saveCapturePhotoData(id, image);
  }
  return {
    id,
    source: input.source,
    fileName: input.fileName,
    ring: input.ring,
    stationIndex: input.stationIndex,
    angleDeg: input.stationIndex * 30,
    overlapEstimate: input.overlapEstimate,
    blurScore: input.blurScore,
    lightingScore: input.lightingScore,
    distanceVariance: input.distanceVariance,
    capturedAt: new Date().toISOString(),
    ...(image
      ? {
          fileSizeBytes: image.byteLength,
          sha256: createHash("sha256").update(image).digest("hex"),
        }
      : {}),
  };
};

const pickIntegrationMode = (
  config: ServerConfig,
  mode: z.infer<typeof createJobSchema>["mode"],
  useMockFallback: boolean,
): { ok: true; integrationMode: "mock" | "live" | "blocked"; warnings: string[] } | { ok: false; code: number; message: string } => {
  const hasCredentials = Boolean(config.cesiumIonToken);
  if (mode === "mock") {
    if (!config.allowMockResults) {
      return {
        ok: false,
        code: 409,
        message: "Mock mode is disabled. Enable ALLOW_MOCK_RESULTS or request mode=ion with valid credentials.",
      };
    }
    return { ok: true, integrationMode: "mock", warnings: ["Using mock reconstruction output."] };
  }
  if (mode === "ion") {
    if (!hasCredentials) {
      return {
        ok: true,
        integrationMode: "blocked",
        warnings: ["Ion mode is blocked because CESIUM_ION_TOKEN is missing."],
      };
    }
    return { ok: true, integrationMode: "live", warnings: [] };
  }
  if (hasCredentials) {
    return { ok: true, integrationMode: "live", warnings: [] };
  }
  if (useMockFallback && config.allowMockResults) {
    return {
      ok: true,
      integrationMode: "mock",
      warnings: ["No Cesium credentials found, falling back to explicit mock mode."],
    };
  }
  return {
    ok: true,
    integrationMode: "blocked",
    warnings: ["Reconstruction is blocked: no Cesium credentials are configured and mock fallback is disabled."],
  };
};

export const createApp = (config: ServerConfig): express.Express => {
  const app = express();
  const livePollers = new Map<string, NodeJS.Timeout>();

  let ionReadinessCache: { result: IonReadinessStatus; expiresAt: number } | null = null;

  const getIonReadiness = async (): Promise<IonReadinessStatus> => {
    if (ionReadinessCache && Date.now() < ionReadinessCache.expiresAt) {
      return ionReadinessCache.result;
    }
    const result = await checkIonReadiness(config);
    ionReadinessCache = { result, expiresAt: Date.now() + 60_000 };
    return result;
  };

  // Warm the readiness cache in the background at startup.
  void getIonReadiness();

  const stopLivePoller = (jobId: string): void => {
    const timer = livePollers.get(jobId);
    if (timer) {
      clearInterval(timer);
      livePollers.delete(jobId);
    }
  };

  const refreshLiveJob = async (jobId: string): Promise<void> => {
    const current = getAssetJob(jobId);
    if (!current || current.integrationMode !== "live") {
      stopLivePoller(jobId);
      return;
    }
    try {
      const patch = await refreshIonLiveJob(current, config);
      const updated = updateAssetJob(jobId, (job) => ({ ...job, ...patch }));
      if (updated && isTerminalJobStatus(updated.status ?? "processing")) {
        stopLivePoller(jobId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown ion polling error";
      updateAssetJob(jobId, (job) => ({
        ...job,
        status: "failed_live_not_implemented",
        progress: 100,
        message: `Cesium ion status polling failed: ${message}`,
        ion: {
          ...(job.ion ?? { jobId: "unavailable", submittedAt: new Date().toISOString() }),
          errorMessage: message,
          lastPolledAt: new Date().toISOString(),
        },
      }));
      stopLivePoller(jobId);
    }
  };

  const ensureLivePoller = (jobId: string): void => {
    if (livePollers.has(jobId)) {
      return;
    }
    const timer = setInterval(() => {
      void refreshLiveJob(jobId);
    }, 2_000);
    timer.unref();
    livePollers.set(jobId, timer);
  };

  const getJobPayload = (jobId: string) => {
    const job = getAssetJob(jobId);
    if (!job) {
      return undefined;
    }
    const session = getCaptureSession(job.sessionId);
    if (!session) {
      return undefined;
    }
    if (job.integrationMode === "live") {
      const lastPolledMs = job.ion?.lastPolledAt ? Date.parse(job.ion.lastPolledAt) : 0;
      if (!Number.isNaN(lastPolledMs) && Date.now() - lastPolledMs > 2_000) {
        void refreshLiveJob(job.id);
      } else if (!job.ion?.lastPolledAt) {
        void refreshLiveJob(job.id);
      }
      ensureLivePoller(job.id);
    }
    return {
      jobId: job.id,
      sessionId: job.sessionId,
      requestedPipeline: job.requestedPipeline,
      integrationMode: job.integrationMode,
      ...evaluateJobStatus(job, session, config),
    };
  };
  const jobStatusMonitor = new JobStatusMonitor((jobId) => getJobPayload(jobId));
  app.use(cors());
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: {
        allowMockResults: config.allowMockResults,
        hasCesiumCredentials: Boolean(config.cesiumIonToken),
        enableLiveIonSubmission: config.enableLiveIonSubmission,
      },
    });
  });

  app.get("/api/config", async (_req, res) => {
    let ionReadiness: IonReadinessStatus | null = null;
    try {
      ionReadiness = await getIonReadiness();
    } catch {
      // Non-fatal; return null readiness rather than failing the config endpoint.
    }
    res.json({
      captureThresholds: CAPTURE_THRESHOLDS,
      cesium: {
        apiUrl: config.cesiumIonApiUrl,
        hasToken: Boolean(config.cesiumIonToken),
        allowMockResults: config.allowMockResults,
        enableLiveIonSubmission: config.enableLiveIonSubmission,
        ionReadiness,
      },
    });
  });

  app.post("/api/capture-sessions", (_req, res) => {
    const session = createCaptureSession();
    res.status(201).json({
      session,
      guidance: summarizeGuidance(session),
      thresholds: CAPTURE_THRESHOLDS,
    });
  });

  app.get("/api/capture-sessions/:sessionId", (req, res) => {
    const session = getCaptureSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Capture session not found" });
      return;
    }
    res.json({
      session,
      guidance: summarizeGuidance(session),
    });
  });

  app.post(
    "/api/capture-sessions/:sessionId/photos/upload",
    express.raw({ type: "image/jpeg", limit: "15mb" }),
    async (req, res) => {
      const session = getCaptureSession(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: "Capture session not found" });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "A non-empty image/jpeg body is required" });
        return;
      }

      const parsed = uploadHeadersSchema.safeParse({
        fileName: req.header("x-capture-file-name"),
        ring: req.header("x-capture-ring"),
        stationIndex: req.header("x-capture-station-index"),
        overlapEstimate: req.header("x-capture-overlap-estimate"),
        blurScore: req.header("x-capture-blur-score"),
        lightingScore: req.header("x-capture-lighting-score"),
        distanceVariance: req.header("x-capture-distance-variance"),
      });
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid capture metadata headers",
          details: parsed.error.flatten(),
        });
        return;
      }

      const duplicate = session.photos.some(
        (photo) =>
          photo.ring === parsed.data.ring &&
          photo.stationIndex === parsed.data.stationIndex,
      );
      if (duplicate) {
        res.status(409).json({ error: "That capture station is already complete" });
        return;
      }

      const safeFileName = parsed.data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const relativePath = path.join(session.id, `${randomUUID()}-${safeFileName}`);
      const absolutePath = path.resolve(config.captureUploadDir, relativePath);
      try {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, req.body);
      } catch (error) {
        res.status(500).json({
          error: `Unable to persist captured JPEG: ${error instanceof Error ? error.message : "unknown error"}`,
        });
        return;
      }

      const photo = parsePhotoInput({
        source: "device",
        fileName: safeFileName,
        ring: parsed.data.ring,
        stationIndex: parsed.data.stationIndex,
        angleDeg: parsed.data.stationIndex * 30,
        overlapEstimate: parsed.data.overlapEstimate,
        blurScore: parsed.data.blurScore,
        lightingScore: parsed.data.lightingScore,
        distanceVariance: parsed.data.distanceVariance,
      });
      photo.imageFilePath = relativePath;
      photo.fileSizeBytes = req.body.byteLength;
      photo.sha256 = createHash("sha256").update(req.body).digest("hex");
      saveCapturePhotoData(photo.id, req.body);
      session.photos.push(photo);
      saveCaptureSession(session);
      res.status(201).json({
        added: 1,
        photos: [photo],
        guidance: summarizeGuidance(session),
      });
    },
  );

  app.post("/api/capture-sessions/:sessionId/photos", (req, res) => {
    const session = getCaptureSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Capture session not found" });
      return;
    }

    const singlePhoto = addPhotoSchema.safeParse(req.body);
    if (singlePhoto.success) {
      const duplicate = session.photos.some(
        (photo) =>
          photo.ring === singlePhoto.data.ring &&
          photo.stationIndex === singlePhoto.data.stationIndex,
      );
      if (duplicate) {
        res.status(409).json({ error: "That capture station is already complete" });
        return;
      }
      const photo = parsePhotoInput(singlePhoto.data);
      session.photos.push(photo);
      saveCaptureSession(session);
      res.status(201).json({
        added: 1,
        photos: [photo],
        guidance: summarizeGuidance(session),
      });
      return;
    }

    const multiPhoto = addPhotosSchema.safeParse(req.body);
    if (!multiPhoto.success) {
      res.status(400).json({
        error: "Invalid photo payload",
        details: multiPhoto.error.flatten(),
      });
      return;
    }

    const existingStations = new Set(
      session.photos.map((photo) => `${photo.ring}:${photo.stationIndex}`),
    );
    const requestedStations = multiPhoto.data.photos.map(
      (photo) => `${photo.ring}:${photo.stationIndex}`,
    );
    if (
      new Set(requestedStations).size !== requestedStations.length ||
      requestedStations.some((station) => existingStations.has(station))
    ) {
      res.status(409).json({ error: "Photo batch contains an already completed capture station" });
      return;
    }

    const photos = multiPhoto.data.photos.map((photo) => parsePhotoInput(photo));
    session.photos.push(...photos);
    saveCaptureSession(session);
    res.status(201).json({
      added: photos.length,
      photos,
      guidance: summarizeGuidance(session),
    });
  });

  const submitJobHandler: express.RequestHandler = (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid job payload",
        details: parsed.error.flatten(),
      });
      return;
    }

    const session = getCaptureSession(parsed.data.sessionId);
    if (!session) {
      res.status(404).json({ error: "Capture session not found" });
      return;
    }

    const guidance = summarizeGuidance(session);
    const unmetCriteria = Object.entries(guidance.checklist)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (unmetCriteria.length > 0) {
      res.status(422).json({
        error: "Capture quality gates not met",
        unmetCriteria,
        guidance,
      });
      return;
    }

    const companionRequest: CompanionReconstructionRequest = {
      sessionId: parsed.data.sessionId,
      pipeline: parsed.data.requestedPipeline,
      mode: parsed.data.mode,
      useMockFallback: parsed.data.useMockFallback,
    };
    const modeDecision = pickIntegrationMode(config, companionRequest.mode, Boolean(companionRequest.useMockFallback));
    if (!modeDecision.ok) {
      res.status(modeDecision.code).json({ error: modeDecision.message });
      return;
    }

    const baseJob = createAssetJob({
      sessionId: session.id,
      requestedPipeline: parsed.data.requestedPipeline,
      integrationMode: modeDecision.integrationMode,
      ...(modeDecision.integrationMode === "blocked"
        ? {
            status: "blocked_no_credentials",
            progress: 0,
            message:
              "Cesium ion credentials are missing. Set CESIUM_ION_TOKEN (and optional CESIUM_ION_API_URL), then resubmit.",
          }
        : modeDecision.integrationMode === "live"
          ? {
              status: "queued",
              progress: 5,
              message: "Preparing live Cesium ion submission.",
            }
          : {}),
    });
    const finalizeResponse = (jobId: string): void => {
      res.status(202).json({
        jobId,
        integrationMode: modeDecision.integrationMode,
        warnings: modeDecision.warnings,
        message:
          modeDecision.integrationMode === "mock"
            ? "Submitted in explicit mock mode. Configure CESIUM_ION_TOKEN for a real job."
            : modeDecision.integrationMode === "blocked"
              ? "Reconstruction created in a blocked state. Review the credential requirements."
              : "Submitted to Cesium ion for live Gaussian Splat processing.",
      });
    };

    if (modeDecision.integrationMode !== "live") {
      finalizeResponse(baseJob.id);
      return;
    }

    void (async () => {
      try {
        const livePatch = await initializeIonLiveJob(baseJob, session, config);
        updateAssetJob(baseJob.id, (job) => ({ ...job, ...livePatch }));
        ensureLivePoller(baseJob.id);
        finalizeResponse(baseJob.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown ion submission error";
        updateAssetJob(baseJob.id, (job) => ({
          ...job,
          status: "failed_live_not_implemented",
          progress: 100,
          message: `Cesium ion live submission failed: ${message}`,
          ion: {
            ...(job.ion ?? {
              jobId: "unavailable",
              submittedAt: new Date().toISOString(),
            }),
            errorMessage: message,
            lastPolledAt: new Date().toISOString(),
          },
        }));
        res.status(502).json({
          error: `Cesium ion live submission failed: ${message}`,
        });
      }
    })();
  };

  app.post("/api/assets/jobs", submitJobHandler);
  app.post("/api/reconstruction-jobs", submitJobHandler);

  const getJobHandler: express.RequestHandler = (req, res) => {
    const payload = getJobPayload(req.params.jobId);
    if (!payload) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(payload);
  };

  app.get("/api/assets/jobs/:jobId", getJobHandler);
  app.get("/api/reconstruction-jobs/:jobId", getJobHandler);

  const streamJobHandler: express.RequestHandler = (req, res) => {
    if (!getJobPayload(req.params.jobId)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 2000\n\n");

    let terminalSent = false;
    const unsubscribe = jobStatusMonitor.subscribe(req.params.jobId, (event) => {
      res.write(`id: ${event.sequence}\nevent: job-status\ndata: ${JSON.stringify(event.payload)}\n\n`);
      if (isTerminalJobStatus(event.payload.status)) {
        terminalSent = true;
        res.end();
      }
    });
    if (!unsubscribe) {
      res.end();
      return;
    }

    const heartbeat = terminalSent
      ? undefined
      : setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    req.on("close", () => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      unsubscribe();
    });
  };

  app.get("/api/assets/jobs/:jobId/events", streamJobHandler);
  app.get("/api/reconstruction-jobs/:jobId/events", streamJobHandler);

  app.use("/", express.static(webRoot, { index: "index.html" }));
  return app;
};
