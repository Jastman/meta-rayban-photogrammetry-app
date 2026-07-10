export const SUCCESS_STATUSES = new Set(["completed", "completed_mock"]);
export const TERMINAL_STATUSES = new Set([
  ...SUCCESS_STATUSES,
  "blocked_no_credentials",
  "failed_live_not_implemented",
]);

export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(status);

export const createTerminalTransitionTracker = () => {
  const handledJobs = new Set();
  return {
    shouldHandle(job) {
      if (!job?.jobId || !isTerminalStatus(job.status) || handledJobs.has(job.jobId)) {
        return false;
      }
      handledJobs.add(job.jobId);
      return true;
    },
    reset(jobId) {
      handledJobs.delete(jobId);
    },
  };
};
