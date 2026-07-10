import { randomUUID } from "node:crypto";
import type { AssetJob, CaptureSession } from "./types.js";

const captureSessions = new Map<string, CaptureSession>();
const assetJobs = new Map<string, AssetJob>();
const capturePhotoData = new Map<string, Uint8Array>();

export const createCaptureSession = (): CaptureSession => {
  const session: CaptureSession = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    photos: [],
  };
  captureSessions.set(session.id, session);
  return session;
};

export const getCaptureSession = (sessionId: string): CaptureSession | undefined =>
  captureSessions.get(sessionId);

export const saveCaptureSession = (session: CaptureSession): void => {
  captureSessions.set(session.id, session);
};

export const saveCapturePhotoData = (photoId: string, data: Uint8Array): void => {
  capturePhotoData.set(photoId, data);
};

export const getCapturePhotoData = (photoId: string): Uint8Array | undefined =>
  capturePhotoData.get(photoId);

export const createAssetJob = (job: Omit<AssetJob, "id" | "createdAt">): AssetJob => {
  const created: AssetJob = {
    ...job,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  assetJobs.set(created.id, created);
  return created;
};

export const getAssetJob = (jobId: string): AssetJob | undefined => assetJobs.get(jobId);

export const saveAssetJob = (job: AssetJob): void => {
  assetJobs.set(job.id, job);
};

export const updateAssetJob = (
  jobId: string,
  updater: (job: AssetJob) => AssetJob,
): AssetJob | undefined => {
  const existing = assetJobs.get(jobId);
  if (!existing) {
    return undefined;
  }
  const updated = updater(existing);
  assetJobs.set(jobId, updated);
  return updated;
};
