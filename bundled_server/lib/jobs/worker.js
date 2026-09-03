// Worker scheduler. Pulls queued jobs off the store and runs each through an
// injected executor — the executor is the business glue (how a task's prompt is
// built and its artifact validated), while this loop stays generic: concurrency,
// status transitions, phase/console bookkeeping, and the post-task persist.

export function startWorker(store, { concurrency = 1, timeoutMs = 15 * 60 * 1000, execute } = {}) {
  if (typeof execute !== 'function') throw new Error('startWorker requires an execute(task, store, onProgress) function');

  let active = 0;
  let scheduled = false;

  async function work(taskId) {
    const task = store.getInternal(taskId);
    if (!task || task.status !== 'queued') return;
    active += 1;
    await store.update(taskId, {
      status: 'running',
      phase: 'starting',
      startedAt: new Date().toISOString(),
      attempt: (task.attempt || 0) + 1,
    });
    try {
      const result = await execute(task, store, async (progress) => {
        const patch = { phase: progress.phase };
        if (progress.sessionId) patch.sessionId = progress.sessionId;
        await store.update(taskId, patch).catch((error) => {
          console.error(`[worker] progress update failed ${taskId}: ${error.message}`);
        });
        await store.appendConsole(taskId, progress).catch((error) => {
          console.error(`[worker] console append failed ${taskId}: ${error.message}`);
        });
      });
      await store.update(taskId, {
        status: 'succeeded',
        phase: 'completed',
        finishedAt: new Date().toISOString(),
        artifactBytes: result.bytes ?? null,
        error: null,
        summary: result.summary ?? null,
      });
    } catch (error) {
      console.error(`[worker] task ${taskId} failed: ${error.message}`);
      await store.update(taskId, {
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: String(error.message).slice(0, 1200),
      });
    } finally {
      active -= 1;
      schedule();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(async () => {
      scheduled = false;
      while (active < concurrency && store.queue.length) {
        const taskId = store.queue.shift();
        if (!taskId || store.getInternal(taskId)?.status !== 'queued') continue;
        work(taskId).catch((error) => console.error(`[worker] error: ${error.message}`));
      }
    });
  }

  store.onJobQueued = schedule;
  schedule();
  return { schedule, active: () => active };
}