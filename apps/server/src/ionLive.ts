import path from "node:path";
import { readFile } from "node:fs/promises";
import { getCapturePhotoData } from "./store.js";
import type { ServerConfig } from "./config.js";
import type { AssetJob, CaptureSession, JobStatus } from "./types.js";

interface IonCreateJobResponse {
  jobId?: string;
  id?: string;
  assetId?: string | number;
  statusPath?: string;
  statusUrl?: string;
  url?: string;
  thumbnailUrl?: string;
}

interface IonStatusResponse {
  status?: string;
  progress?: number;
  message?: string;
  assetId?: string | number;
  url?: string;
  viewerUrl?: string;
  thumbnailUrl?: string;
  notes?: string;
}

interface IonErrorPayload {
  code?: string;
  message?: string;
}

const toAbsoluteUrl = (baseUrl: string, rawPath: string): string =>
  new URL(rawPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const resolvePhotoBytes = async (
  session: CaptureSession,
  config: ServerConfig,
): Promise<Array<{ fileName: string; bytes: Buffer }>> => {
  const resolved: Array<{ fileName: string; bytes: Buffer }> = [];
  for (const photo of session.photos) {
    let bytes = getCapturePhotoData(photo.id);
    if (!bytes && photo.imageFilePath) {
      const fullPath = path.resolve(config.captureUploadDir, photo.imageFilePath);
      bytes = await readFile(fullPath);
    }
    if (!bytes || bytes.length === 0) {
      throw new Error(
        `Missing JPEG bytes for ${photo.fileName} (${photo.ring}:${photo.stationIndex}). Upload all station photos as JPEG before live ion submission.`,
      );
    }
    resolved.push({ fileName: photo.fileName, bytes: Buffer.from(bytes) });
  }
  return resolved;
};

const ionHeaders = (config: ServerConfig): HeadersInit => ({
  authorization: `Bearer ${config.cesiumIonToken}`,
  "content-type": "application/json",
});

const readIonError = async (response: Response): Promise<{ code?: string; message: string }> => {
  const text = await response.text();
  if (!text) {
    return { message: "empty response body" };
  }
  try {
    const parsed = JSON.parse(text) as IonErrorPayload;
    return {
      code: parsed.code,
      message: parsed.message ?? text,
    };
  } catch {
    return { message: text };
  }
};

const assertOk = async (response: Response, context: string): Promise<void> => {
  if (response.ok) {
    return;
  }
  const error = await readIonError(response);
  throw new Error(
    `${context} failed (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.message}`,
  );
};

const verifyIonReadAccess = async (config: ServerConfig): Promise<void> => {
  const readResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"), {
    method: "GET",
    headers: ionHeaders(config),
  });
  if (readResponse.ok) {
    return;
  }
  const error = await readIonError(readResponse);
  if (readResponse.status === 401 || readResponse.status === 403) {
    throw new Error(
      `Cesium ion token failed read-access preflight (${readResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). Verify the token is valid for this account and has asset read access.`,
    );
  }
  throw new Error(
    `Cesium ion read-access preflight failed (${readResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}).`,
  );
};

const probeIonWriteScope = async (config: ServerConfig): Promise<string | undefined> => {
  const probeResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"), {
    method: "POST",
    headers: ionHeaders(config),
    body: JSON.stringify({}),
  });
  if (probeResponse.status === 401 || probeResponse.status === 403) {
    const error = await readIonError(probeResponse);
    return `Write-scope probe was denied (${probeResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). Create/use a Cesium ion token with assets:write permission.`;
  }
  return undefined;
};

const mapIonStatus = (status: string): JobStatus => {
  const normalized = status.trim().toLowerCase();
  if (["queued", "submitted", "pending", "waiting"].includes(normalized)) {
    return "queued";
  }
  if (["processing", "running", "in_progress", "active"].includes(normalized)) {
    return "processing";
  }
  if (["completed", "complete", "succeeded", "done", "success"].includes(normalized)) {
    return "completed";
  }
  return "failed_live_not_implemented";
};

export const initializeIonLiveJob = async (
  job: AssetJob,
  session: CaptureSession,
  config: ServerConfig,
): Promise<Pick<AssetJob, "status" | "progress" | "message" | "ion" | "result">> => {
  if (!config.cesiumIonToken) {
    throw new Error("Live ion submission requires CESIUM_ION_TOKEN.");
  }
  if (!config.enableLiveIonSubmission) {
    throw new Error(
      "ENABLE_LIVE_ION_SUBMISSION must be true before requesting mode=ion or auto live mode.",
    );
  }

  await verifyIonReadAccess(config);
  const writeScopeGuidance = await probeIonWriteScope(config);

  const photos = await resolvePhotoBytes(session, config);
  const body = {
    sessionId: session.id,
    pipeline: "gaussian_splats",
    photos: photos.map((photo) => ({
      fileName: photo.fileName,
      contentType: "image/jpeg",
      dataBase64: photo.bytes.toString("base64"),
    })),
  };

  const createResponse = await fetch(
    toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/reality-capture/gaussian-splats/jobs"),
    {
      method: "POST",
      headers: ionHeaders(config),
      body: JSON.stringify(body),
    },
  );
  if (!createResponse.ok) {
    const error = await readIonError(createResponse);
    if (createResponse.status === 405) {
      throw new Error(
        `Cesium ion live submission endpoint returned 405 MethodNotAllowed (${error.code ?? "MethodNotAllowed"}: ${error.message}). This public API path may not support direct photo Gaussian Splat reconstruction for this account/token and may require a different/partner endpoint plus write-scoped credentials. ${writeScopeGuidance ?? ""} Until a supported endpoint is provided, run reconstruction in explicit mock mode.`,
      );
    }
    if (createResponse.status === 401 || createResponse.status === 403) {
      throw new Error(
        `Cesium ion live reconstruction submission was denied (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). ${writeScopeGuidance ?? "Create/use a Cesium ion token with assets:write permission."}`,
      );
    }
    throw new Error(
      `Cesium ion live reconstruction submission failed (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message})`,
    );
  }

  const createPayload = (await createResponse.json()) as IonCreateJobResponse;
  const ionJobId = createPayload.jobId ?? createPayload.id;
  if (!ionJobId) {
    throw new Error("Cesium ion response did not include a reconstruction job identifier.");
  }
  const statusPath =
    createPayload.statusPath ??
    createPayload.statusUrl ??
    `/v1/reality-capture/gaussian-splats/jobs/${encodeURIComponent(ionJobId)}`;

  return {
    status: "queued",
    progress: 5,
    message: `Submitted ${photos.length} photos to Cesium ion.`,
    ion: {
      jobId: ionJobId,
      assetId: createPayload.assetId,
      statusPath,
      submittedAt: new Date().toISOString(),
      lastPolledAt: undefined,
    },
    ...(createPayload.url || createPayload.thumbnailUrl
      ? {
          result: {
            provider: "ion",
            ionAssetId: createPayload.assetId,
            splat: {
              id: createPayload.assetId == null ? undefined : String(createPayload.assetId),
              format: "gaussian-splat",
              url: createPayload.url,
              thumbnailUrl: createPayload.thumbnailUrl,
              notes: "Cesium ion reconstruction job accepted.",
            },
          },
        }
      : {}),
  };
};

export const refreshIonLiveJob = async (
  job: AssetJob,
  config: ServerConfig,
): Promise<Pick<AssetJob, "status" | "progress" | "message" | "result" | "ion">> => {
  if (!job.ion?.statusPath) {
    throw new Error("Missing ion status path for live reconstruction job.");
  }
  if (!config.cesiumIonToken) {
    throw new Error("CESIUM_ION_TOKEN is required to poll live reconstruction status.");
  }

  const statusResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, job.ion.statusPath), {
    method: "GET",
    headers: ionHeaders(config),
  });
  await assertOk(statusResponse, "Cesium ion live reconstruction status poll");
  const statusPayload = (await statusResponse.json()) as IonStatusResponse;

  const mappedStatus = mapIonStatus(statusPayload.status ?? "processing");
  const progress =
    statusPayload.progress == null || Number.isNaN(statusPayload.progress)
      ? mappedStatus === "queued"
        ? 10
        : mappedStatus === "processing"
          ? 60
          : 100
      : Math.max(0, Math.min(100, Math.round(statusPayload.progress * 100) / 100));
  const defaultMessage =
    mappedStatus === "queued"
      ? "Queued in Cesium ion."
      : mappedStatus === "processing"
        ? "Cesium ion is processing the Gaussian Splat reconstruction."
        : mappedStatus === "completed"
          ? "Cesium ion reconstruction complete."
          : "Cesium ion reconstruction failed.";
  const message = statusPayload.message?.trim() || defaultMessage;
  const ionAssetId = statusPayload.assetId ?? job.ion.assetId;
  const openUrl = statusPayload.viewerUrl ?? statusPayload.url;

  return {
    status: mappedStatus,
    progress,
    message,
    ion: {
      ...job.ion,
      assetId: ionAssetId,
      lastPolledAt: new Date().toISOString(),
      ...(mappedStatus === "failed_live_not_implemented" ? { errorMessage: message } : {}),
    },
    ...(mappedStatus === "completed" || openUrl || statusPayload.thumbnailUrl
      ? {
          result: {
            provider: "ion",
            ionAssetId,
            splat: {
              id: ionAssetId == null ? undefined : String(ionAssetId),
              format: "gaussian-splat",
              url: openUrl,
              thumbnailUrl: statusPayload.thumbnailUrl,
              notes: statusPayload.notes ?? "Cesium ion Gaussian Splat result.",
            },
          },
        }
      : {}),
  };
};
