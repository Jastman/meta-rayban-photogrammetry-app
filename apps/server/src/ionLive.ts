import path from "node:path";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getCapturePhotoData } from "./store.js";
import type { ServerConfig } from "./config.js";
import type { AssetJob, CaptureSession, JobStatus } from "./types.js";

interface IonUploadLocation {
  bucket?: string;
  prefix?: string;
  accessKey?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
}

interface IonOnComplete {
  url?: string;
  method?: string;
  fields?: Record<string, unknown>;
}

interface IonCreateAssetResponse {
  assetMetadata?: {
    id?: string | number;
  };
  id?: string | number;
  assetId?: string | number;
  uploadLocation?: IonUploadLocation;
  onComplete?: IonOnComplete;
}

interface IonAssetStatusResponse {
  id?: string | number;
  assetId?: string | number;
  status?: string;
  percentComplete?: number;
  message?: string;
  thumbnailUrl?: string;
  viewerUrl?: string;
  url?: string;
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
  const normalized = status.trim().toUpperCase();
  if (["AWAITING_FILES", "NOT_STARTED", "QUEUED", "SUBMITTED", "PENDING", "WAITING"].includes(normalized)) {
    return "queued";
  }
  if (["IN_PROGRESS", "PROCESSING", "RUNNING", "ACTIVE"].includes(normalized)) {
    return "processing";
  }
  if (["COMPLETE", "COMPLETED", "SUCCEEDED", "DONE", "SUCCESS"].includes(normalized)) {
    return "completed";
  }
  if (["DATA_ERROR", "ERROR", "ARCHIVED", "FAILED"].includes(normalized)) {
    return "failed_live_not_implemented";
  }
  return "failed_live_not_implemented";
};

const resolveS3ObjectKey = (prefix: string | undefined, fileName: string): string => {
  if (!prefix) {
    return fileName;
  }
  return prefix.endsWith("/") ? `${prefix}${fileName}` : `${prefix}/${fileName}`;
};

const uploadPhotosToIonS3 = async (
  uploadLocation: IonUploadLocation,
  photos: Array<{ fileName: string; bytes: Buffer }>,
): Promise<void> => {
  if (
    !uploadLocation.bucket ||
    !uploadLocation.accessKey ||
    !uploadLocation.secretAccessKey ||
    !uploadLocation.sessionToken ||
    !uploadLocation.endpoint
  ) {
    throw new Error("Cesium ion create-asset response is missing upload credentials.");
  }

  const s3Client = new S3Client({
    region: "us-east-1",
    endpoint: uploadLocation.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: uploadLocation.accessKey,
      secretAccessKey: uploadLocation.secretAccessKey,
      sessionToken: uploadLocation.sessionToken,
    },
  });

  await Promise.all(
    photos.map((photo) =>
      s3Client.send(
        new PutObjectCommand({
          Bucket: uploadLocation.bucket,
          Key: resolveS3ObjectKey(uploadLocation.prefix, photo.fileName),
          Body: photo.bytes,
          ContentType: "image/jpeg",
        }),
      ),
    ),
  );
};

const signalIonUploadComplete = async (
  onComplete: IonOnComplete | undefined,
  config: ServerConfig,
): Promise<void> => {
  if (!onComplete?.url) {
    throw new Error("Cesium ion create-asset response is missing onComplete.url.");
  }

  const response = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, onComplete.url), {
    method: (onComplete.method ?? "POST").toUpperCase(),
    headers: ionHeaders(config),
    body: JSON.stringify(onComplete.fields ?? {}),
  });
  await assertOk(response, "Cesium ion upload completion");
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
  const createResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"), {
    method: "POST",
    headers: ionHeaders(config),
    body: JSON.stringify({
      name: `Splat Capture ${session.id}`,
      description: "Gaussian Splat captured via Meta Ray-Ban companion app",
      type: "3DTILES",
      options: {
        sourceType: "3D_CAPTURE",
        gaussianSplats: true,
      },
    }),
  });
  if (!createResponse.ok) {
    const error = await readIonError(createResponse);
    if (createResponse.status === 401 || createResponse.status === 403) {
      throw new Error(
        `Cesium ion asset creation was denied (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). ${writeScopeGuidance ?? "Create/use a Cesium ion token with assets:write permission."}`,
      );
    }
    throw new Error(
      `Cesium ion asset creation failed (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message})`,
    );
  }

  const createPayload = (await createResponse.json()) as IonCreateAssetResponse;
  const assetId = createPayload.assetMetadata?.id ?? createPayload.assetId ?? createPayload.id;
  if (assetId == null) {
    throw new Error("Cesium ion create-asset response did not include an asset identifier.");
  }

  await uploadPhotosToIonS3(createPayload.uploadLocation ?? {}, photos);
  await signalIonUploadComplete(createPayload.onComplete, config);

  return {
    status: "queued",
    progress: 5,
    message: `Uploaded ${photos.length} photos to Cesium ion. Asset processing is queued.`,
    ion: {
      jobId: String(job.id ?? assetId),
      assetId,
      statusPath: `/v1/assets/${encodeURIComponent(String(assetId))}`,
      submittedAt: new Date().toISOString(),
      lastPolledAt: undefined,
      uploadComplete: true,
    },
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
  const statusPayload = (await statusResponse.json()) as IonAssetStatusResponse;

  const mappedStatus = mapIonStatus(statusPayload.status ?? "IN_PROGRESS");
  const progress =
    statusPayload.percentComplete == null || Number.isNaN(statusPayload.percentComplete)
      ? mappedStatus === "queued"
        ? 10
        : mappedStatus === "processing"
          ? 60
          : 100
      : Math.max(0, Math.min(100, Math.round(statusPayload.percentComplete * 100) / 100));
  const defaultMessage =
    mappedStatus === "queued"
      ? "Queued in Cesium ion."
      : mappedStatus === "processing"
        ? "Cesium ion is processing the Gaussian Splat reconstruction."
        : mappedStatus === "completed"
          ? "Cesium ion reconstruction complete."
          : "Cesium ion reconstruction failed.";
  const message = statusPayload.message?.trim() || defaultMessage;
  const ionAssetId = statusPayload.id ?? statusPayload.assetId ?? job.ion.assetId;
  const viewerUrl = ionAssetId == null ? undefined : `https://ion.cesium.com/assets/${ionAssetId}`;

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
    ...(mappedStatus === "completed"
      ? {
          result: {
            provider: "ion",
            ionAssetId,
            splat: {
              id: ionAssetId == null ? undefined : String(ionAssetId),
              format: "gaussian-splat",
              url: viewerUrl,
              thumbnailUrl: statusPayload.thumbnailUrl,
              notes: statusPayload.notes ?? "Cesium ion Gaussian Splat result.",
            },
          },
        }
      : {}),
  };
};
