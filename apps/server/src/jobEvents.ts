import { isTerminalJobStatus, type JobStatusPayload } from "./jobStatus.js";

export interface JobStatusEvent {
  sequence: number;
  jobId: string;
  emittedAt: string;
  payload: JobStatusPayload;
}

type StatusResolver = (jobId: string) => JobStatusPayload | undefined;
type StatusListener = (event: JobStatusEvent) => void;

interface MonitoredJob {
  listeners: Set<StatusListener>;
  lastStatus?: JobStatusPayload["status"];
  sequence: number;
  timer?: NodeJS.Timeout;
}

export class JobStatusMonitor {
  readonly #jobs = new Map<string, MonitoredJob>();

  constructor(
    private readonly resolveStatus: StatusResolver,
    private readonly intervalMs = 500,
  ) {}

  subscribe(jobId: string, listener: StatusListener): (() => void) | undefined {
    if (!this.resolveStatus(jobId)) {
      return undefined;
    }

    const monitored = this.#jobs.get(jobId) ?? {
      listeners: new Set<StatusListener>(),
      sequence: 0,
    };
    monitored.listeners.add(listener);
    this.#jobs.set(jobId, monitored);
    this.refresh(jobId, listener);

    if (!monitored.timer && !isTerminalJobStatus(monitored.lastStatus!)) {
      monitored.timer = setInterval(() => this.refresh(jobId), this.intervalMs);
    }

    return () => {
      monitored.listeners.delete(listener);
      if (monitored.listeners.size === 0) {
        this.#stop(jobId, monitored);
      }
    };
  }

  refresh(jobId: string, initialListener?: StatusListener): void {
    const monitored = this.#jobs.get(jobId);
    const payload = this.resolveStatus(jobId);
    if (!monitored || !payload) {
      return;
    }

    if (!initialListener && monitored.lastStatus === payload.status) {
      return;
    }

    monitored.lastStatus = payload.status;
    monitored.sequence += 1;
    const event: JobStatusEvent = {
      sequence: monitored.sequence,
      jobId,
      emittedAt: new Date().toISOString(),
      payload,
    };

    if (initialListener) {
      initialListener(event);
    } else {
      for (const listener of monitored.listeners) {
        listener(event);
      }
    }

    if (isTerminalJobStatus(payload.status)) {
      this.#stop(jobId, monitored);
    }
  }

  #stop(jobId: string, monitored: MonitoredJob): void {
    if (monitored.timer) {
      clearInterval(monitored.timer);
    }
    this.#jobs.delete(jobId);
  }
}
