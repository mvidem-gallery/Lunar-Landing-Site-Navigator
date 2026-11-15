import { parseUtcStringToMs } from '../astronomy/trajectoryGenerator.js';

let cachedCatalog = null;

function buildApiError(message, code = 'internal', status = 500, details = null) {
  const err = new Error(message || 'Trajectory service error');
  err.code = code;
  err.status = status;
  if (details !== null) err.details = details;
  return err;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.ok === false) {
    const code = payload?.error?.code || 'http_error';
    const msg =
      payload?.error?.message ||
      `Trajectory service returned HTTP ${res.status} (${res.statusText || 'Error'})`;
    throw buildApiError(msg, code, res.status);
  }

  return payload;
}

function sleepAbortable(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchTrajectoryCatalog({ force = false, signal = null } = {}) {
  if (!force && cachedCatalog) {
    return cachedCatalog;
  }
  const data = await requestJson('/api/trajectory/catalog', { method: 'GET', signal });
  cachedCatalog = data;
  return data;
}

export async function submitTrajectoryJob(payload, { signal = null } = {}) {
  return requestJson('/api/trajectory/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal,
  });
}

export async function fetchTrajectoryJobStatus(jobId, { signal = null } = {}) {
  return requestJson(`/api/trajectory/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    signal,
  });
}

export async function fetchTrajectoryJobResult(jobId, part = 'all', { signal = null } = {}) {
  return requestJson(
    `/api/trajectory/jobs/${encodeURIComponent(jobId)}/result?part=${encodeURIComponent(part)}`,
    {
      method: 'GET',
      signal,
    }
  );
}

/**
 * Submits a trajectory calculation job to `lwp-api/1`, polls until done, and returns
 * the generated `lwp-trajectory/1` document alongside summary & job metadata.
 */
export async function generateMissionTrajectory(
  payload,
  { intervalMs = 600, timeoutMs = null, onProgress = null, signal = null } = {}
) {
  const requestedFlightMode = payload?.advanced?.flightMode ?? payload?.flightMode ?? null;
  const isLongSearch =
    requestedFlightMode === 'economy' ||
    requestedFlightMode === 'launch_window' ||
    payload?.mode === 'economy' ||
    Boolean(payload?.launch_window ?? payload?.advanced?.launch_window);
  const effectiveTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : isLongSearch
        ? 300000
        : 180000;

  onProgress?.({ stage: 'submitting', message: 'Submitting request to trajectory solver...' });
  const submitRes = await submitTrajectoryJob(payload, { signal });
  let job = submitRes.job;
  if (!job?.job_id) {
    throw buildApiError('Trajectory solver did not return a job ID.', 'internal', 500);
  }

  onProgress?.({
    stage: 'running',
    job,
    message: `Job ${job.job_id} ${job.status || 'queued'}...`,
  });

  const startedAt = Date.now();
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() - startedAt > effectiveTimeoutMs) {
      throw buildApiError(
        `Trajectory calculation timed out after ${Math.round(effectiveTimeoutMs / 1000)}s.`,
        'timeout',
        504
      );
    }
    await sleepAbortable(intervalMs, signal);
    const statusRes = await fetchTrajectoryJobStatus(job.job_id, { signal });
    job = statusRes.job || job;
    onProgress?.({
      stage: job.status,
      job,
      message:
        job.status === 'running'
          ? isLongSearch
            ? `Computing ${requestedFlightMode === 'economy' ? 'economy (±3d)' : 'launch window'} (${job.job_id})...`
            : `Computing trajectory (${job.job_id})...`
          : `Job ${job.job_id}: ${job.status}...`,
    });
  }

  if (job.status === 'failed') {
    throw buildApiError(job.error || 'Trajectory calculation failed.', 'job_failed', 500);
  }

  onProgress?.({
    stage: 'fetching',
    job,
    message: 'Downloading generated lwp-trajectory/1...',
  });

  const resultRes = await fetchTrajectoryJobResult(job.job_id, 'all', { signal });
  const summary = resultRes.data?.summary ?? null;
  const trajectory = resultRes.data?.trajectory ?? null;
  const log = resultRes.data?.log ?? null;

  const entries = Array.isArray(trajectory?.trajectories) ? trajectory.trajectories : [];
  const hasNumericalEntry = entries.some(
    (t) => t && t.source !== 'none' && Array.isArray(t.samples) && t.samples.length >= 2
  );

  const summaryBody = summary?.summary || null;
  const hasLaunchWindowSolution = Boolean(
    summaryBody?.launch_window &&
      summaryBody?.status &&
      summaryBody.status !== 'no flight found'
  );

  const isValidTraj =
    trajectory &&
    typeof trajectory === 'object' &&
    entries.length > 0 &&
    hasNumericalEntry;

  if (!isValidTraj && !hasLaunchWindowSolution) {
    const terrainVerdict = summary?.landing_site?.terrain_check?.reason;
    const rawReason =
      summaryBody?.reason ||
      (terrainVerdict ? `landing site unsuitable: ${terrainVerdict}` : null) ||
      summaryBody?.status ||
      job.outcome ||
      'No feasible trajectory produced for these parameters.';
    throw buildApiError(String(rawReason), 'no_trajectory', 422, { summary, job });
  }

  return {
    job,
    request: submitRes.request || null,
    summary,
    trajectory: isValidTraj ? trajectory : null,
    hasTrajectoryPath: isValidTraj,
    log,
  };
}

export function extractScheduleFromGeneratedResult(result) {
  const entries = Array.isArray(result?.trajectory?.trajectories)
    ? result.trajectory.trajectories
    : [];
  const firstTraj =
    entries.find((t) => t && t.source !== 'none' && Array.isArray(t.samples) && t.samples.length >= 2) ||
    entries[0] ||
    null;
  const summarySection = result?.summary?.summary || null;
  const lwOpt = summarySection?.launch_window?.optimum || null;
  const firstSample = firstTraj?.samples?.[0] || null;
  const lastSample = firstTraj?.samples?.[firstTraj.samples.length - 1] || null;

  const launchMs =
    parseUtcStringToMs(firstSample?.t) ??
    parseUtcStringToMs(summarySection?.launch_utc) ??
    parseUtcStringToMs(lwOpt?.launch_utc) ??
    null;
  const touchdownMs =
    parseUtcStringToMs(lastSample?.t) ??
    parseUtcStringToMs(summarySection?.touchdown_utc) ??
    parseUtcStringToMs(lwOpt?.touchdown_utc) ??
    parseUtcStringToMs(summarySection?.lunar_orbit_insertion_utc) ??
    parseUtcStringToMs(lwOpt?.lunar_orbit_insertion_utc) ??
    null;

  let durationSec = Number.isFinite(Number(lastSample?.t_s))
    ? Math.round(Number(lastSample.t_s))
    : null;
  if (durationSec === null && launchMs !== null && touchdownMs !== null && touchdownMs >= launchMs) {
    durationSec = Math.round((touchdownMs - launchMs) / 1000);
  }
  if (durationSec === null && Number.isFinite(Number(lwOpt?.time_of_flight_h))) {
    durationSec = Math.round(Number(lwOpt.time_of_flight_h) * 3600);
  }

  const landingSiteObj = result?.trajectory?.landing_site || null;
  const landingLatDeg = Number.isFinite(Number(landingSiteObj?.lat_deg))
    ? Number(landingSiteObj.lat_deg)
    : null;
  const landingLonDeg = Number.isFinite(Number(landingSiteObj?.lon_deg))
    ? Number(landingSiteObj.lon_deg)
    : null;

  return {
    launchDateIso: launchMs !== null ? new Date(launchMs).toISOString() : null,
    landingDateIso: touchdownMs !== null ? new Date(touchdownMs).toISOString() : null,
    transitDurationSec: durationSec,
    landingLatDeg,
    landingLonDeg,
  };
}
