export interface ServerConfig {
  port: number;
  cesiumIonToken: string | null;
  cesiumIonApiUrl: string;
  ionDebugLogs: boolean;
  allowMockResults: boolean;
  enableLiveIonSubmission: boolean;
  publicBaseUrl: string;
  captureUploadDir: string;
}

const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value == null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

export const loadConfig = (): ServerConfig => ({
  port: Number(process.env.PORT ?? 8787),
  cesiumIonToken: process.env.CESIUM_ION_TOKEN ?? null,
  cesiumIonApiUrl: process.env.CESIUM_ION_API_URL ?? "https://api.cesium.com",
  ionDebugLogs: parseBoolean(process.env.ION_DEBUG_LOGS, false),
  allowMockResults: parseBoolean(process.env.ALLOW_MOCK_RESULTS, true),
  enableLiveIonSubmission: parseBoolean(process.env.ENABLE_LIVE_ION_SUBMISSION, false),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8787",
  captureUploadDir: process.env.CAPTURE_UPLOAD_DIR ?? "var/captures",
});
