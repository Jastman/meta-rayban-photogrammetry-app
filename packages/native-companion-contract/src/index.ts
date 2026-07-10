export type PipelineKind = "gaussian_splats";
export type CaptureRing = "high" | "middle" | "low";
export type ReconstructionStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_mock"
  | "blocked_no_credentials"
  | "failed_live_not_implemented";

export interface CompanionCaptureCommand {
  sessionId: string;
  mode: "burst" | "guided-orbit";
  targetPhotoCount: number;
  stationsPerRing: 12;
  ringOrder: readonly ["high", "middle", "low"];
}

export interface CompanionPhotoEvent {
  sessionId: string;
  fileName: string;
  ring: CaptureRing;
  stationIndex: number;
  angleDeg: number;
  overlapEstimate: number;
  blurScore: number;
  lightingScore: number;
  distanceVariance: number;
  source: "simulated" | "upload" | "device";
  capturedAt?: string;
  mimeType?: "image/jpeg";
}

export interface CompanionPhotoUpload {
  metadata: CompanionPhotoEvent;
  /** Exact JPEG bytes returned by DAT capturePhoto(format: .jpeg). */
  jpeg: ArrayBuffer;
}

export interface CompanionPreviewFrame {
  sessionId: string;
  capturedAt: string;
  mimeType: "image/jpeg" | "image/webp";
  frame: ArrayBuffer;
}

export interface CompanionReconstructionRequest {
  sessionId: string;
  pipeline: PipelineKind;
  mode: "auto" | "mock" | "ion";
  useMockFallback?: boolean;
}

export interface CompanionReconstructionCompletedEvent {
  type: "reconstruction.completed";
  jobId: string;
  sessionId: string;
  completedAt: string;
  resultProvider: "mock" | "ion";
  ionAssetId?: string;
}

export interface CompanionReconstructionNotificationRequest {
  event: CompanionReconstructionCompletedEvent;
  title: string;
  body: string;
  deepLink?: string;
}

export interface CompanionBridge {
  startCapture(command: CompanionCaptureCommand): Promise<void>;
  stopCapture(sessionId: string): Promise<void>;
  subscribePreviewFrames(listener: (frame: CompanionPreviewFrame) => void): () => void;
  uploadPhoto(upload: CompanionPhotoUpload): Promise<void>;
  submitReconstruction(request: CompanionReconstructionRequest): Promise<{ jobId: string }>;
  pollReconstruction(jobId: string): Promise<{
    status: ReconstructionStatus;
    progress: number;
    message: string;
  }>;
  requestReconstructionNotification(request: CompanionReconstructionNotificationRequest): Promise<void>;
}

export const backendRestContract = {
  createSession: "POST /api/capture-sessions",
  addPhoto: "POST /api/capture-sessions/:sessionId/photos",
  uploadDevicePhoto: "POST /api/capture-sessions/:sessionId/photos/upload",
  submitReconstruction: "POST /api/assets/jobs",
  pollJob: "GET /api/assets/jobs/:jobId",
  streamJobEvents: "GET /api/assets/jobs/:jobId/events",
} as const;

export const companionBridgeNotImplemented: CompanionBridge = {
  async startCapture() {
    throw new Error("Native companion bridge not implemented yet.");
  },
  async stopCapture() {
    throw new Error("Native companion bridge not implemented yet.");
  },
  subscribePreviewFrames() {
    throw new Error("Native companion preview bridge not implemented yet.");
  },
  async uploadPhoto() {
    throw new Error("Native companion bridge not implemented yet.");
  },
  async submitReconstruction() {
    throw new Error("Native companion bridge not implemented yet.");
  },
  async pollReconstruction() {
    throw new Error("Native companion bridge not implemented yet.");
  },
  async requestReconstructionNotification() {
    throw new Error("Native companion notification bridge not implemented yet.");
  },
};
