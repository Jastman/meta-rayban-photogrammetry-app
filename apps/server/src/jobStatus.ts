import type { ServerConfig } from "./config.js";
import type { AssetJob, CaptureSession, JobStatus } from "./types.js";

const SAMPLE_SPLAT = {
  id: "sample-splat-v1",
  format: "gaussian-splat",
  url: "/mock/sample-room.splat",
  thumbnailUrl: "/mock/sample-splat-preview.svg",
  notes:
    "Mock output used for local prototype. Replace with real Cesium ion result URL / asset ID when credentials and live submission are enabled.",
};

export interface JobStatusPayload {
  status: JobStatus;
  progress: number;
  message: string;
  result?: {
    provider: "mock" | "ion";
    ionAssetId?: string | number;
    splat?: {
      id?: string;
      format?: string;
      url?: string;
      thumbnailUrl?: string;
      notes?: string;
    };
  };
}

const elapsedMs = (job: AssetJob): number => Date.now() - Date.parse(job.createdAt);

export const isTerminalJobStatus = (status: JobStatus): boolean =>
  status === "completed" ||
  status === "completed_mock" ||
  status === "blocked_no_credentials" ||
  status === "failed_live_not_implemented";

export const evaluateJobStatus = (
  job: AssetJob,
  session: CaptureSession,
  config: ServerConfig,
): JobStatusPayload => {
  if (job.integrationMode === "live" && job.status && job.progress != null && job.message) {
    return {
      status: job.status,
      progress: job.progress,
      message: job.message,
      ...(job.result ? { result: job.result } : {}),
    };
  }

  if (job.integrationMode === "blocked") {
    return {
      status: "blocked_no_credentials",
      progress: 0,
      message:
        "Cesium ion credentials are missing. Set CESIUM_ION_TOKEN (and optional CESIUM_ION_API_URL), then resubmit.",
    };
  }

  if (job.integrationMode === "live") {
    return {
      status: "queued",
      progress: 5,
      message: `Submitting ${session.photos.length} photos to Cesium ion for Gaussian Splat processing.`,
    };
  }

  const ms = elapsedMs(job);
  if (ms < 1500) {
    return {
      status: "queued",
      progress: 15,
      message: `Queued ${session.photos.length} photos for mock Gaussian Splat processing.`,
    };
  }
  if (ms < 4500) {
    return {
      status: "processing",
      progress: 70,
      message: "Mock reconstruction is running (simulated Cesium ion Gaussian Splat pipeline).",
    };
  }
  return {
    status: "completed_mock",
    progress: 100,
    message: "Mock reconstruction complete. Review the sample Gaussian Splat output.",
    result: {
      provider: "mock",
      splat: SAMPLE_SPLAT,
    },
  };
};
