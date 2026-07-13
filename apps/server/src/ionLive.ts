import path from "node:path";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ZipFile } from "yazl";
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
  assets?: Array<{
    id?: string | number;
    outputType?: string;
  }>;
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

interface ParsedIonBody {
  code?: string;
  message: string;
  rawBody: string;
  parsedBody?: unknown;
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

const debugLog = (config: ServerConfig, context: string, details?: unknown): void => {
  if (!config.ionDebugLogs) {
    return;
  }
  if (details === undefined) {
    console.log(`[ion-live] ${context}`);
    return;
  }
  console.log(`[ion-live] ${context}`, details);
};

const debugError = (config: ServerConfig, context: string, details?: unknown): void => {
  if (!config.ionDebugLogs) {
    return;
  }
  if (details === undefined) {
    console.error(`[ion-live] ${context}`);
    return;
  }
  console.error(`[ion-live] ${context}`, details);
};

const readIonBody = async (response: Response): Promise<ParsedIonBody> => {
  const text = await response.text();
  if (!text) {
    return { message: "empty response body", rawBody: "" };
  }
  try {
    const parsed = JSON.parse(text) as IonErrorPayload & Record<string, unknown>;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : text;
    return {
      code: parsed.code,
      message,
      rawBody: text,
      parsedBody: parsed,
    };
  } catch {
    return { message: text, rawBody: text };
  }
};

const formatIonErrorDetails = (body: ParsedIonBody): string => {
  if (body.parsedBody != null) {
    return JSON.stringify(body.parsedBody);
  }
  return body.rawBody || body.message;
};

const assertOk = async (response: Response, context: string): Promise<void> => {
  if (response.ok) {
    return;
  }
  const error = await readIonBody(response);
  const details = formatIonErrorDetails(error);
  throw new Error(
    `${context} failed (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.message}${details ? ` | body: ${details}` : ""}`,
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
  const error = await readIonBody(readResponse);
  const details = formatIonErrorDetails(error);
  if (readResponse.status === 401 || readResponse.status === 403) {
    throw new Error(
      `Cesium ion token failed read-access preflight (${readResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). Verify the token is valid for this account and has asset read access.${details ? ` Response body: ${details}` : ""}`,
    );
  }
  throw new Error(
    `Cesium ion read-access preflight failed (${readResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}).${details ? ` Response body: ${details}` : ""}`,
  );
};

const probeIonWriteScope = async (config: ServerConfig): Promise<string | undefined> => {
  const probeResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"), {
    method: "POST",
    headers: ionHeaders(config),
    body: JSON.stringify({}),
  });
  if (probeResponse.status === 401 || probeResponse.status === 403) {
    const error = await readIonBody(probeResponse);
    const details = formatIonErrorDetails(error);
    return `Write-scope probe was denied (${probeResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}). Create/use a Cesium ion token with assets:write permission.${details ? ` Response body: ${details}` : ""}`;
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

const deriveRegionFromS3Endpoint = (endpoint: string | undefined): string | undefined => {
  if (!endpoint) {
    return undefined;
  }
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    const match = host.match(/s3[.-]([a-z0-9-]+)\./);
    return match?.[1];
  } catch {
    return undefined;
  }
};

const sanitizePathPart = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "capture";

const isJpegFileName = (fileName: string): boolean => /\.(jpe?g)$/i.test(fileName);

const buildJpegArchive = async (
  sessionId: string,
  photos: Array<{ fileName: string; bytes: Buffer }>,
): Promise<{ archiveName: string; bytes: Buffer; photoCount: number }> => {
  const archiveBaseName = `splat-capture-${sanitizePathPart(sessionId)}`;
  const zip = new ZipFile();
  let photoCount = 0;
  for (const photo of photos) {
    if (!isJpegFileName(photo.fileName)) {
      continue;
    }
    photoCount += 1;
    const safeName = sanitizePathPart(photo.fileName);
    zip.addBuffer(photo.bytes, `${archiveBaseName}/${safeName}`);
  }
  if (photoCount === 0) {
    throw new Error("No JPEG photos were available to package for Cesium ion upload.");
  }

  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });

  return {
    archiveName: `${archiveBaseName}.zip`,
    bytes,
    photoCount,
  };
};

const uploadArchiveToIonS3 = async (
  uploadLocation: IonUploadLocation,
  archive: { archiveName: string; bytes: Buffer },
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

  const uploadRegion = deriveRegionFromS3Endpoint(uploadLocation.endpoint);
  const s3Client = new S3Client({
    region: uploadRegion ?? "auto",
    endpoint: uploadLocation.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: uploadLocation.accessKey,
      secretAccessKey: uploadLocation.secretAccessKey,
      sessionToken: uploadLocation.sessionToken,
    },
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: uploadLocation.bucket,
      Key: resolveS3ObjectKey(uploadLocation.prefix, archive.archiveName),
      Body: archive.bytes,
      ContentType: "application/zip",
    }),
  );
};

const signalIonUploadComplete = async (
  onComplete: IonOnComplete | undefined,
  config: ServerConfig,
): Promise<void> => {
  if (!onComplete?.url) {
    throw new Error("Cesium ion create-asset response is missing onComplete.url.");
  }

  const uploadCompleteUrl = toAbsoluteUrl(config.cesiumIonApiUrl, onComplete.url);
  const response = await fetch(uploadCompleteUrl, {
    method: (onComplete.method ?? "POST").toUpperCase(),
    headers: ionHeaders(config),
    body: JSON.stringify(onComplete.fields ?? {}),
  });
  if (!response.ok) {
    const error = await readIonBody(response);
    debugError(config, "uploadComplete failed", {
      url: uploadCompleteUrl,
      status: response.status,
      body: error.parsedBody ?? error.rawBody,
    });
    const details = formatIonErrorDetails(error);
    throw new Error(
      `Cesium ion upload completion failed (${response.status}${error.code ? ` ${error.code}` : ""}): ${error.message}${details ? ` | body: ${details}` : ""}`,
    );
  }
  debugLog(config, "uploadComplete succeeded", {
    url: uploadCompleteUrl,
    status: response.status,
  });
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
  const captureName = `Meta Ray-Ban Companion ${session.id}`;
  const createAssetPayload = {
    name: captureName,
    description:
      "Captured via the Meta Ray-Ban companion app for Cesium photogrammetry/gaussian splat processing.",
    attribution: "",
    type: "3DTILES",
    options: {
      sourceType: "RASTER_IMAGERY",
      outputs: [
        {
          outputType: "3DTILES",
          name: `${captureName} mesh`,
        },
        {
          outputType: "SPLATS_3DTILES",
          name: `${captureName} splats`,
        },
        {
          outputType: "LAS",
          name: `${captureName} point cloud`,
        },
      ],
    },
  } as const;
  debugLog(config, "create asset request", {
    url: toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"),
    payload: createAssetPayload,
  });
  const createResponse = await fetch(toAbsoluteUrl(config.cesiumIonApiUrl, "/v1/assets"), {
    method: "POST",
    headers: ionHeaders(config),
    body: JSON.stringify(createAssetPayload),
  });
  const createResponseHeaders = {
    contentType: createResponse.headers.get("content-type"),
    xRequestId: createResponse.headers.get("x-request-id"),
    xCesiumTraceId: createResponse.headers.get("x-cesium-trace-id"),
  };
  debugLog(config, "create asset response", {
    status: createResponse.status,
    headers: createResponseHeaders,
  });
  if (!createResponse.ok) {
    const error = await readIonBody(createResponse);
    debugError(config, "create asset failed", {
      status: createResponse.status,
      headers: createResponseHeaders,
      body: error.parsedBody ?? error.rawBody,
    });
    const details = formatIonErrorDetails(error);
    if (createResponse.status === 401 || createResponse.status === 403) {
      throw new Error(
        `Cesium ion asset creation was denied (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}${details ? ` | body: ${details}` : ""}). ${writeScopeGuidance ?? "Create/use a Cesium ion token with assets:write permission."}`,
      );
    }
    throw new Error(
      `Cesium ion asset creation failed (${createResponse.status}${error.code ? ` ${error.code}` : ""}: ${error.message}${details ? ` | body: ${details}` : ""})`,
    );
  }

  const createPayload = (await createResponse.json()) as IonCreateAssetResponse;
  debugLog(config, "create asset payload summary", {
    assetMetadata: createPayload.assetMetadata,
    assets: createPayload.assets,
    hasUploadLocation: Boolean(createPayload.uploadLocation),
    hasOnComplete: Boolean(createPayload.onComplete),
  });
  const splatAssetId = createPayload.assets?.find((asset) => asset.outputType === "SPLATS_3DTILES")?.id;
  const assetId =
    splatAssetId ?? createPayload.assetMetadata?.id ?? createPayload.assetId ?? createPayload.id;
  if (assetId == null) {
    throw new Error("Cesium ion create-asset response did not include an asset identifier.");
  }

  const archive = await buildJpegArchive(session.id, photos);
  debugLog(config, "s3 upload starting", {
    archiveName: archive.archiveName,
    archiveBytes: archive.bytes.byteLength,
    photoCount: archive.photoCount,
    bucket: createPayload.uploadLocation?.bucket,
    prefix: createPayload.uploadLocation?.prefix,
    endpoint: createPayload.uploadLocation?.endpoint,
  });
  await uploadArchiveToIonS3(createPayload.uploadLocation ?? {}, archive);
  debugLog(config, "s3 upload completed", {
    archiveName: archive.archiveName,
  });
  await signalIonUploadComplete(createPayload.onComplete, config);

  return {
    status: "queued",
    progress: 5,
    message: `Uploaded ${archive.photoCount} photos to Cesium ion. Asset processing is queued.`,
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
  if (!statusResponse.ok) {
    const error = await readIonBody(statusResponse);
    debugError(config, "status poll failed", {
      statusPath: job.ion.statusPath,
      status: statusResponse.status,
      body: error.parsedBody ?? error.rawBody,
    });
    const details = formatIonErrorDetails(error);
    throw new Error(
      `Cesium ion live reconstruction status poll failed (${statusResponse.status}${error.code ? ` ${error.code}` : ""}): ${error.message}${details ? ` | body: ${details}` : ""}`,
    );
  }
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
