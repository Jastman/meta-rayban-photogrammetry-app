import type { CapturePhotoMetrics, CaptureRing, CaptureSession, GuidanceSummary } from "./types.js";

export const CAPTURE_THRESHOLDS = {
  stationsPerRing: 12,
  requiredRings: 3,
  minPhotos: 36,
  minAverageOverlap: 0.6,
  minOrbitCoverageRatio: 1,
  maxAverageBlurScore: 0.45,
  minAverageLightingScore: 0.55,
  maxAverageDistanceVariance: 0.3,
} as const;

export const CAPTURE_RING_ORDER: readonly CaptureRing[] = ["high", "middle", "low"];

const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stationKey = (photo: CapturePhotoMetrics): string => `${photo.ring}:${photo.stationIndex}`;

const completedStations = (photos: CapturePhotoMetrics[]): Set<string> => {
  const stations = new Set<string>();
  for (const photo of photos) {
    if (photo.stationIndex >= 0 && photo.stationIndex < CAPTURE_THRESHOLDS.stationsPerRing) {
      stations.add(stationKey(photo));
    }
  }
  return stations;
};

export const summarizeGuidance = (session: CaptureSession): GuidanceSummary => {
  const overlap = average(session.photos.map((photo) => photo.overlapEstimate));
  const blur = average(session.photos.map((photo) => photo.blurScore));
  const lighting = average(session.photos.map((photo) => photo.lightingScore));
  const distanceVariance = average(session.photos.map((photo) => photo.distanceVariance));
  const stations = completedStations(session.photos);
  const requiredStationCount = CAPTURE_THRESHOLDS.stationsPerRing * CAPTURE_THRESHOLDS.requiredRings;
  const orbitCoverageRatio = stations.size / requiredStationCount;
  const ringProgress = Object.fromEntries(
    CAPTURE_RING_ORDER.map((ring) => [
      ring,
      Array.from({ length: CAPTURE_THRESHOLDS.stationsPerRing }, (_, stationIndex) =>
        stations.has(`${ring}:${stationIndex}`) ? 1 : 0,
      ).filter(Boolean).length,
    ]),
  ) as Record<CaptureRing, number>;
  const nextStation =
    CAPTURE_RING_ORDER.flatMap((ring) =>
      Array.from({ length: CAPTURE_THRESHOLDS.stationsPerRing }, (_, stationIndex) => ({
        ring,
        stationIndex,
        angleDeg: stationIndex * 30,
      })),
    ).find(({ ring, stationIndex }) => !stations.has(`${ring}:${stationIndex}`)) ?? null;

  const checklist = {
    minPhotoCountMet: stations.size >= CAPTURE_THRESHOLDS.minPhotos,
    overlapMet: overlap >= CAPTURE_THRESHOLDS.minAverageOverlap,
    threeOrbitCoverageMet:
      orbitCoverageRatio >= CAPTURE_THRESHOLDS.minOrbitCoverageRatio &&
      CAPTURE_RING_ORDER.every((ring) => ringProgress[ring] === CAPTURE_THRESHOLDS.stationsPerRing),
    blurMet: blur <= CAPTURE_THRESHOLDS.maxAverageBlurScore,
    lightingMet: lighting >= CAPTURE_THRESHOLDS.minAverageLightingScore,
    distanceStabilityMet: distanceVariance <= CAPTURE_THRESHOLDS.maxAverageDistanceVariance,
  };

  const tips: string[] = [];
  if (!checklist.minPhotoCountMet) {
    tips.push("Capture every 30-degree station on the high, middle, and low rings.");
  }
  if (!checklist.overlapMet) {
    tips.push("Increase overlap by moving in smaller increments around the object.");
  }
  if (!checklist.threeOrbitCoverageMet) {
    tips.push("Physically move around the object; do not rotate in place or leave gaps.");
  }
  if (!checklist.blurMet) {
    tips.push("Stabilize and move slowly; if detail stays blurry, move closer and add overlapping viewpoints.");
  }
  if (!checklist.lightingMet) {
    tips.push("Use consistent lighting with low noise; keep people, vehicles, and foliage static.");
  }
  if (!checklist.distanceStabilityMet) {
    tips.push("Maintain a stable distance from the object during capture.");
  }
  if (tips.length === 0) {
    tips.push("Capture quality is solid. You can submit a reconstruction job.");
  }

  return {
    photoCount: session.photos.length,
    orbitCoverageRatio,
    completedStationCount: stations.size,
    requiredStationCount,
    ringProgress,
    nextStation,
    averageOverlap: overlap,
    averageBlurScore: blur,
    averageLightingScore: lighting,
    averageDistanceVariance: distanceVariance,
    checklist,
    tips,
  };
};
