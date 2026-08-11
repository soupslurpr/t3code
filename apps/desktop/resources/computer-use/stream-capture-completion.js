/**
 * Creates an exact-once completion callback for one portal stream capture.
 *
 * Cleanup always attempts to stop the GStreamer pipeline before closing the
 * duplicated PipeWire remote descriptor. The first capture or cleanup failure
 * wins, while later cleanup steps still run.
 */
export function createStreamCaptureCompletion({
  clearPoll,
  unregister,
  stopPipeline,
  closeRemote,
  resolve,
  reject,
}) {
  let completed = false;

  return (error, data = null) => {
    if (completed) return false;
    completed = true;

    let completionError = error;
    for (const cleanup of [clearPoll, unregister, stopPipeline, closeRemote]) {
      try {
        cleanup();
      } catch (cleanupError) {
        if (completionError === null) completionError = cleanupError;
      }
    }

    if (completionError === null) {
      resolve(data);
    } else {
      reject(completionError);
    }
    return true;
  };
}

/** Creates a completion counter that coalesces periodic work onto one idle task. */
export function createBatchedIdleCollector({ interval, schedule, collect }) {
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new RangeError("idle collection interval must be a positive integer");
  }
  let completions = 0;
  let scheduled = false;

  return () => {
    completions += 1;
    if (completions < interval || scheduled) return;
    scheduled = true;
    try {
      schedule(() => {
        completions = 0;
        scheduled = false;
        collect();
      });
    } catch {
      completions = 0;
      scheduled = false;
    }
  };
}
