export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_mock"
  | "blocked_no_credentials"
  | "failed_live_not_implemented";

export type CaptureRing = "high" | "middle" | "low";

export interface CapturePhotoMetrics {
  id: string;
  source: "simulated" | "upload" | "browser" | "device";
  fileName: string;
  ring: CaptureRing;
  stationIndex: number;
  angleDeg: number;
  overlapEstimate: number;
  blurScore: number;
  lightingScore: number;
  distanceVariance: number;
  capturedAt: string;
  fileSizeBytes?: number;
  sha256?: string;
  imageFilePath?: string;
}

export interface CaptureSession {
  id: string;
  createdAt: string;
  photos: CapturePhotoMetrics[];
}

export interface GuidanceChecklist {
  minPhotoCountMet: boolean;
  overlapMet: boolean;
  threeOrbitCoverageMet: boolean;
  blurMet: boolean;
  lightingMet: boolean;
  distanceStabilityMet: boolean;
}

export interface GuidanceSummary {
  photoCount: number;
  orbitCoverageRatio: number;
  completedStationCount: number;
  requiredStationCount: number;
  ringProgress: Record<CaptureRing, number>;
  nextStation: {
    ring: CaptureRing;
    stationIndex: number;
    angleDeg: number;
  } | null;
  averageOverlap: number;
  averageBlurScore: number;
  averageLightingScore: number;
  averageDistanceVariance: number;
  checklist: GuidanceChecklist;
  tips: string[];
}

export interface AssetJob {
  id: string;
  sessionId: string;
  createdAt: string;
  requestedPipeline: "gaussian_splats";
  integrationMode: "mock" | "blocked" | "live";
  status?: JobStatus;
  progress?: number;
  message?: string;
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
  ion?: {
    jobId: string;
    statusPath?: string;
    assetId?: string | number;
    uploadComplete?: boolean;
    lastPolledAt?: string;
    submittedAt: string;
    errorMessage?: string;
  };
}
