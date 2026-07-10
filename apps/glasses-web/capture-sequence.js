export const RINGS = ["high", "middle", "low"];
export const STATIONS_PER_RING = 12;

export const stationAt = (completedStationCount) => {
  if (completedStationCount < 0 || completedStationCount >= RINGS.length * STATIONS_PER_RING) {
    return null;
  }
  const ringIndex = Math.floor(completedStationCount / STATIONS_PER_RING);
  const stationIndex = completedStationCount % STATIONS_PER_RING;
  return {
    ring: RINGS[ringIndex],
    stationIndex,
    angleDeg: stationIndex * (360 / STATIONS_PER_RING),
  };
};

export const movementForStation = (station) => {
  if (!station) {
    return {
      instruction: "ALL ORBITS COMPLETE",
      arrow: "✓",
      detail: "Review quality, then submit reconstruction",
    };
  }
  if (station.stationIndex > 0) {
    return {
      instruction: "MOVE RIGHT 30°",
      arrow: "→",
      detail: `${station.ring.toUpperCase()} ring · station ${station.stationIndex + 1}/12 · ${station.angleDeg}°`,
    };
  }
  const ringGuidance = {
    high: {
      instruction: "HOLD STEADY · CAPTURE",
      arrow: "◎",
      detail: "HIGH ring · above object · point down",
    },
    middle: {
      instruction: "LOWER TO MID LEVEL",
      arrow: "↓",
      detail: "Face forward · keep distance and lens fixed",
    },
    low: {
      instruction: "LOWER CAMERA",
      arrow: "↓",
      detail: "Point up · keep the full object framed",
    },
  };
  return ringGuidance[station.ring];
};
