/**
 * Background jobs the page polls (a bug replay, a chaos run, a build) are kept in a map by id. This keeps
 * the map small: past `max`, the oldest finished jobs go, never one that is still running.
 */
export function trimJobs<T>(jobs: Map<string, T>, max: number, finished: (job: T) => boolean): void {
  for (const [id, job] of jobs) {
    if (jobs.size <= max) return;
    if (finished(job)) jobs.delete(id);
  }
}
