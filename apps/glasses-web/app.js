import { movementForStation, RINGS, STATIONS_PER_RING } from "./capture-sequence.js";
import {
  createTerminalTransitionTracker,
  isTerminalStatus,
  SUCCESS_STATUSES,
} from "./reconstruction-notifications.js";

const state = {
  sessionId: null,
  guidance: null,
  jobId: null,
  selectedTabIndex: 0,
  selectedMode: "auto",
  previewSource: "simulated",
  mediaStream: null,
  nativeFrameUrl: null,
  jobEventSource: null,
  notificationsEnabled: false,
};

const tabs = ["capture", "review", "settings"];
const terminalTracker = createTerminalTransitionTracker();

const elements = {
  sessionState: document.getElementById("session-state"),
  navButtons: Array.from(document.querySelectorAll(".nav-btn")),
  screens: {
    capture: document.getElementById("capture-screen"),
    review: document.getElementById("review-screen"),
    settings: document.getElementById("settings-screen"),
  },
  createSessionBtn: document.getElementById("create-session-btn"),
  browserPreviewBtn: document.getElementById("browser-preview-btn"),
  browserPreview: document.getElementById("browser-preview"),
  nativePreview: document.getElementById("native-preview"),
  simulatedFeed: document.getElementById("simulated-feed"),
  previewSource: document.getElementById("preview-source"),
  qualityStatus: document.getElementById("quality-status"),
  simulatePhotoBtn: document.getElementById("simulate-photo-btn"),
  fileInput: document.getElementById("file-input"),
  ringStack: document.getElementById("ring-stack"),
  orbitMap: document.getElementById("orbit-map"),
  movementArrow: document.getElementById("movement-arrow"),
  immediateInstruction: document.getElementById("immediate-instruction"),
  positionDetail: document.getElementById("position-detail"),
  submitJobBtn: document.getElementById("submit-job-btn"),
  captureMessage: document.getElementById("capture-message"),
  pollJobBtn: document.getElementById("poll-job-btn"),
  jobStatus: document.getElementById("job-status"),
  modelCard: document.getElementById("model-card"),
  modelThumbnail: document.getElementById("model-thumbnail"),
  modelNotes: document.getElementById("model-notes"),
  modelUrl: document.getElementById("model-url"),
  configCard: document.getElementById("config-card"),
  submitMode: document.getElementById("submit-mode"),
  streamStatus: document.getElementById("stream-status"),
  terminalBanner: document.getElementById("terminal-banner"),
  notificationBtn: document.getElementById("notification-btn"),
  notificationStatus: document.getElementById("notification-status"),
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
};

const setCaptureStatus = (message, tone = "warn") => {
  elements.captureMessage.className = `message ${tone}`;
  elements.captureMessage.textContent = message;
};

const closeJobStream = () => {
  state.jobEventSource?.close();
  state.jobEventSource = null;
};

const setNotificationStatus = (message) => {
  elements.notificationStatus.textContent = message;
};

const initializeNotificationControl = () => {
  if (!("Notification" in window)) {
    elements.notificationBtn.disabled = true;
    elements.notificationBtn.textContent = "Browser alerts unavailable";
    setNotificationStatus("This browser does not support desktop notifications. In-app alerts remain active.");
    return;
  }
  if (Notification.permission === "denied") {
    elements.notificationBtn.disabled = true;
    elements.notificationBtn.textContent = "Browser alerts blocked";
    setNotificationStatus("Permission is denied. Change this site's browser settings to enable desktop alerts.");
    return;
  }
  setNotificationStatus(
    Notification.permission === "granted"
      ? "Permission granted; alerts are off until enabled here."
      : "Optional desktop alerts. Permission is requested only when you enable them.",
  );
};

const toggleNotifications = async () => {
  if (!("Notification" in window)) {
    setNotificationStatus("Browser notifications are unsupported; in-app alerts remain active.");
    return;
  }
  if (state.notificationsEnabled) {
    state.notificationsEnabled = false;
    elements.notificationBtn.textContent = "Enable completion alerts";
    elements.notificationBtn.setAttribute("aria-pressed", "false");
    setNotificationStatus("Desktop alerts off. In-app terminal alerts remain active.");
    return;
  }
  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== "granted") {
    elements.notificationBtn.disabled = permission === "denied";
    elements.notificationBtn.textContent = permission === "denied"
      ? "Browser alerts blocked"
      : "Enable completion alerts";
    setNotificationStatus(
      permission === "denied"
        ? "Permission denied. In-app alerts remain active; browser settings control future access."
        : "Permission was not granted. In-app alerts remain active.",
    );
    return;
  }
  state.notificationsEnabled = true;
  elements.notificationBtn.textContent = "Disable completion alerts";
  elements.notificationBtn.setAttribute("aria-pressed", "true");
  setNotificationStatus("Desktop terminal-state alerts enabled while this page is running.");
};

const showBrowserNotification = (title, body, jobId) => {
  if (!state.notificationsEnabled || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  try {
    const notification = new Notification(title, {
      body,
      tag: `reconstruction-${jobId}`,
      renotify: false,
      icon: "./assets/Cesium_logo_only.svg",
    });
    notification.onclick = () => {
      window.focus();
      switchScreen(1);
      notification.close();
    };
  } catch (error) {
    setNotificationStatus(`Desktop alert failed: ${error.message}`);
  }
};

const handleTerminalTransition = (result) => {
  if (!terminalTracker.shouldHandle(result)) {
    return;
  }
  closeJobStream();
  const succeeded = SUCCESS_STATUSES.has(result.status);
  const title = succeeded
    ? result.status === "completed_mock"
      ? "Mock reconstruction complete"
      : "Cesium ion reconstruction complete"
    : "Reconstruction needs attention";
  elements.terminalBanner.textContent = `${title}. ${result.message}`;
  elements.terminalBanner.classList.remove("hidden");
  elements.terminalBanner.classList.toggle("error", !succeeded);
  elements.streamStatus.classList.toggle("error", !succeeded);
  elements.streamStatus.textContent = succeeded
    ? "Terminal completion received. Review is ready."
    : "Terminal blocked/failed state received. Review the details below.";
  switchScreen(1);
  elements.jobStatus.focus();
  showBrowserNotification(title, result.message, result.jobId);

  if (succeeded && window.nativeCompanionBridge?.requestReconstructionNotification) {
    window.nativeCompanionBridge.requestReconstructionNotification({
      event: {
        type: "reconstruction.completed",
        jobId: result.jobId,
        sessionId: result.sessionId,
        completedAt: new Date().toISOString(),
        resultProvider: result.result?.provider ?? (result.status === "completed_mock" ? "mock" : "ion"),
        ionAssetId: result.result?.ionAssetId,
      },
      title,
      body: result.message,
      deepLink: `reconstruction://${result.jobId}/review`,
    }).catch((error) => {
      setNotificationStatus(`Native companion notification request failed: ${error.message}`);
    });
  }
};

const renderJobStatus = (result) => {
  elements.jobStatus.textContent = `${result.status} · ${result.progress}% · ${result.message}`;
  elements.jobStatus.classList.toggle("terminal-success", SUCCESS_STATUSES.has(result.status));
  elements.jobStatus.classList.toggle(
    "terminal-error",
    isTerminalStatus(result.status) && !SUCCESS_STATUSES.has(result.status),
  );
  if (result.result?.splat) {
    elements.modelCard.classList.remove("hidden");
    elements.modelThumbnail.src = result.result.splat.thumbnailUrl;
    elements.modelNotes.textContent = result.result.splat.notes;
    elements.modelUrl.textContent = `Splat URL: ${result.result.splat.url}`;
  }
  handleTerminalTransition(result);
};

const connectJobStream = () => {
  closeJobStream();
  if (!state.jobId) {
    return;
  }
  if (!("EventSource" in window)) {
    elements.streamStatus.classList.add("error");
    elements.streamStatus.textContent = "Live updates unsupported. Use Refresh Job Status.";
    return;
  }
  elements.streamStatus.classList.remove("error");
  elements.streamStatus.textContent = "Connecting to live reconstruction updates…";
  const source = new EventSource(`/api/reconstruction-jobs/${state.jobId}/events`);
  state.jobEventSource = source;
  source.addEventListener("open", () => {
    elements.streamStatus.classList.remove("error");
    elements.streamStatus.textContent = "Live reconstruction updates connected.";
  });
  source.addEventListener("job-status", (event) => {
    try {
      renderJobStatus(JSON.parse(event.data));
    } catch (error) {
      elements.streamStatus.classList.add("error");
      elements.streamStatus.textContent = `Invalid live status event: ${error.message}. Use Refresh Job Status.`;
    }
  });
  source.addEventListener("error", () => {
    if (state.jobEventSource === source) {
      elements.streamStatus.classList.add("error");
      elements.streamStatus.textContent = "Live updates interrupted; reconnecting automatically. Refresh remains available.";
    }
  });
};

const renderOrbitMap = (nextStation) => {
  elements.orbitMap.querySelectorAll(".station-dot").forEach((dot) => dot.remove());
  const currentRing = nextStation?.ring ?? "low";
  const completed = state.guidance?.ringProgress?.[currentRing] ?? STATIONS_PER_RING;
  for (let stationIndex = 0; stationIndex < STATIONS_PER_RING; stationIndex += 1) {
    const dot = document.createElement("span");
    dot.className = "station-dot";
    dot.style.setProperty("--angle", `${stationIndex * 30}deg`);
    if (stationIndex < completed) {
      dot.classList.add("done");
    }
    if (nextStation?.stationIndex === stationIndex) {
      dot.classList.add("next");
    }
    elements.orbitMap.append(dot);
  }
  elements.orbitMap.setAttribute(
    "aria-label",
    nextStation
      ? `Top-down orbit. Next position ${nextStation.angleDeg} degrees on the ${nextStation.ring} ring.`
      : "All high, middle, and low orbit stations complete.",
  );
};

const renderGuidance = () => {
  const nextStation = state.guidance?.nextStation ?? null;
  const cue = state.guidance ? movementForStation(nextStation) : {
    instruction: "START A CAPTURE SESSION",
    arrow: "◎",
    detail: "Keep the object centered and fully visible",
  };
  elements.immediateInstruction.textContent = cue.instruction;
  elements.movementArrow.textContent = cue.arrow;
  elements.positionDetail.textContent = cue.detail;

  elements.ringStack.replaceChildren(
    ...RINGS.map((ring) => {
      const completed = state.guidance?.ringProgress?.[ring] ?? 0;
      const pill = document.createElement("span");
      pill.className = "ring-pill";
      pill.textContent = `${ring === "middle" ? "MID" : ring.toUpperCase()} ${completed}/12`;
      pill.classList.toggle("current", nextStation?.ring === ring);
      pill.classList.toggle("complete", completed === STATIONS_PER_RING);
      return pill;
    }),
  );
  renderOrbitMap(nextStation);

  if (!state.guidance || state.guidance.photoCount === 0) {
    elements.qualityStatus.textContent = "FIXED LENS · MOVE SLOWLY";
  } else {
    const overlap = Math.round(state.guidance.averageOverlap * 100);
    const sharp = state.guidance.checklist.blurMet ? "SHARP" : "HOLD STEADY";
    const light = state.guidance.checklist.lightingMet ? "LIGHT OK" : "CHECK LIGHT";
    elements.qualityStatus.textContent = `OVERLAP ${overlap}% · ${sharp} · ${light}`;
  }
  elements.simulatePhotoBtn.disabled = !state.sessionId || !nextStation;
  elements.submitJobBtn.disabled =
    !state.guidance || !Object.values(state.guidance.checklist).every(Boolean);
};

const switchScreen = (index) => {
  state.selectedTabIndex = index;
  const activeTab = tabs[index];
  for (const button of elements.navButtons) {
    const isActive = button.dataset.screen === activeTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  }
  for (const [screenName, screenEl] of Object.entries(elements.screens)) {
    screenEl.classList.toggle("active", screenName === activeTab);
  }
  document.querySelector(
    ".screen.active button:not([disabled]), .screen.active input:not([disabled]), .screen.active select:not([disabled])",
  )?.focus();
};

const captureMetrics = (fileName, source, station) => ({
  source,
  fileName,
  ring: station.ring,
  stationIndex: station.stationIndex,
  angleDeg: station.angleDeg,
  overlapEstimate: 0.78,
  blurScore: 0.18,
  lightingScore: 0.78,
  distanceVariance: 0.12,
});

const addPhoto = async (payload) => {
  if (!state.sessionId) {
    throw new Error("Start a capture session first.");
  }
  const result = await api(`/api/capture-sessions/${state.sessionId}/photos`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.guidance = result.guidance;
  renderGuidance();
};

const createSession = async () => {
  const result = await api("/api/capture-sessions", { method: "POST" });
  state.sessionId = result.session.id;
  state.guidance = result.guidance;
  state.jobId = null;
  closeJobStream();
  elements.sessionState.textContent = `Session ${state.sessionId.slice(0, 8)}`;
  elements.fileInput.disabled = false;
  elements.pollJobBtn.disabled = true;
  elements.modelCard.classList.add("hidden");
  elements.terminalBanner.classList.add("hidden");
  elements.jobStatus.textContent = "No reconstruction submitted.";
  elements.streamStatus.textContent = "Live job updates start after submission.";
  if (window.nativeCompanionBridge?.startCapture) {
    await window.nativeCompanionBridge.startCapture({
      sessionId: state.sessionId,
      mode: "guided-orbit",
      targetPhotoCount: RINGS.length * STATIONS_PER_RING,
      stationsPerRing: STATIONS_PER_RING,
      ringOrder: RINGS,
    });
  }
  setCaptureStatus("Use one fixed lens/resolution. Do not zoom or switch cameras.", "ok");
  renderGuidance();
};

const setPreviewSource = (source) => {
  state.previewSource = source;
  elements.browserPreview.classList.toggle("active", source === "browser");
  elements.nativePreview.classList.toggle("active", source === "device");
  elements.simulatedFeed.classList.toggle("hidden", source !== "simulated");
  elements.previewSource.textContent =
    source === "browser" ? "BROWSER CAMERA" : source === "device" ? "DAT COMPANION" : "SIM FEED";
};

const toggleBrowserPreview = async () => {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    elements.browserPreview.srcObject = null;
    elements.browserPreviewBtn.textContent = "Use Browser Camera";
    elements.browserPreviewBtn.setAttribute("aria-pressed", "false");
    setPreviewSource("simulated");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Browser camera preview is unavailable.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
  state.mediaStream = stream;
  elements.browserPreview.srcObject = stream;
  await elements.browserPreview.play();
  elements.browserPreviewBtn.textContent = "Stop Browser Camera";
  elements.browserPreviewBtn.setAttribute("aria-pressed", "true");
  setPreviewSource("browser");
  setCaptureStatus("Browser preview only; this is not the Meta DAT camera.", "ok");
};

const connectNativePreview = () => {
  const bridge = window.nativeCompanionBridge;
  if (!bridge?.subscribePreviewFrames) {
    return;
  }
  bridge.subscribePreviewFrames((frame) => {
    if (frame.sessionId !== state.sessionId) {
      return;
    }
    if (state.nativeFrameUrl) {
      URL.revokeObjectURL(state.nativeFrameUrl);
    }
    state.nativeFrameUrl = URL.createObjectURL(new Blob([frame.frame], { type: frame.mimeType }));
    elements.nativePreview.src = state.nativeFrameUrl;
    setPreviewSource("device");
  });
};

const submitReconstruction = async () => {
  if (!state.sessionId) {
    return;
  }
  const response = await api("/api/reconstruction-jobs", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.sessionId,
      requestedPipeline: "gaussian_splats",
      mode: state.selectedMode,
      useMockFallback: true,
    }),
  });
  state.jobId = response.jobId;
  terminalTracker.reset(state.jobId);
  elements.pollJobBtn.disabled = false;
  elements.terminalBanner.classList.add("hidden");
  elements.jobStatus.classList.remove("terminal-success", "terminal-error");
  const warnings = Array.isArray(response.warnings) && response.warnings.length > 0
    ? ` (${response.warnings.join(" ")})`
    : "";
  elements.jobStatus.textContent = `${response.message}${warnings}`;
  switchScreen(1);
  connectJobStream();
};

const pollJobStatus = async () => {
  if (!state.jobId) {
    return;
  }
  const result = await api(`/api/reconstruction-jobs/${state.jobId}`);
  renderJobStatus(result);
};

const loadConfig = async () => {
  try {
    const config = await api("/api/config");
    elements.configCard.textContent =
      `Backend mode · Cesium token: ${config.cesium.hasToken ? "detected" : "not set"} · ` +
      `Mock results: ${config.cesium.allowMockResults ? "enabled" : "disabled"} · ` +
      `Live ion: ${config.cesium.enableLiveIonSubmission ? "enabled" : "not implemented"} · ` +
      `Required capture: ${config.captureThresholds.requiredRings} rings × ` +
      `${config.captureThresholds.stationsPerRing} stations`;
  } catch (error) {
    elements.configCard.textContent = `Config load failed: ${error.message}`;
  }
};

elements.navButtons.forEach((button, index) => {
  button.addEventListener("click", () => switchScreen(index));
});

elements.createSessionBtn.addEventListener("click", async () => {
  try {
    await createSession();
  } catch (error) {
    setCaptureStatus(error.message, "bad");
  }
});

elements.browserPreviewBtn.addEventListener("click", async () => {
  try {
    await toggleBrowserPreview();
  } catch (error) {
    setCaptureStatus(error.message, "bad");
  }
});

elements.simulatePhotoBtn.addEventListener("click", async () => {
  const station = state.guidance?.nextStation;
  if (!station) {
    return;
  }
  try {
    const source = state.previewSource === "device" ? "device" : state.previewSource;
    await addPhoto(captureMetrics(`${source}-${station.ring}-${station.stationIndex}.jpg`, source, station));
    setCaptureStatus(
      source === "simulated"
        ? "Simulated station recorded. Move physically; keep the scene and lighting static."
        : `${source === "browser" ? "Browser" : "Companion"} station recorded.`,
      "ok",
    );
  } catch (error) {
    setCaptureStatus(error.message, "bad");
  }
});

elements.fileInput.addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const files = Array.from(input.files || []);
  try {
    let added = 0;
    for (const file of files) {
      const station = state.guidance?.nextStation;
      if (!station) {
        break;
      }
      await addPhoto(captureMetrics(file.name, "upload", station));
      added += 1;
    }
    setCaptureStatus(`${added} file${added === 1 ? "" : "s"} assigned to consecutive guided stations.`, "ok");
  } catch (error) {
    setCaptureStatus(error.message, "bad");
  } finally {
    input.value = "";
  }
});

elements.submitJobBtn.addEventListener("click", async () => {
  try {
    await submitReconstruction();
  } catch (error) {
    setCaptureStatus(error.message, "bad");
  }
});

elements.pollJobBtn.addEventListener("click", async () => {
  try {
    await pollJobStatus();
  } catch (error) {
    elements.jobStatus.textContent = error.message;
  }
});

elements.notificationBtn.addEventListener("click", async () => {
  try {
    await toggleNotifications();
  } catch (error) {
    setNotificationStatus(`Notification permission request failed: ${error.message}`);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const delta = event.key === "ArrowRight" ? 1 : -1;
    switchScreen((state.selectedTabIndex + delta + tabs.length) % tabs.length);
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const focusables = Array.from(document.querySelectorAll(
      ".screen.active button:not([disabled]), .screen.active input:not([disabled]), .screen.active select:not([disabled])",
    ));
    const currentIndex = focusables.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
    event.preventDefault();
  }
});

elements.submitMode.addEventListener("change", (event) => {
  state.selectedMode = event.currentTarget.value;
});

window.addEventListener("beforeunload", () => {
  closeJobStream();
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  if (state.nativeFrameUrl) {
    URL.revokeObjectURL(state.nativeFrameUrl);
  }
});

renderGuidance();
switchScreen(0);
connectNativePreview();
initializeNotificationControl();
await loadConfig();
