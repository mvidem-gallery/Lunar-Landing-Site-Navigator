const DEFAULT_REPORT_API_BASE = '/api/mission-report';

export async function fetchMissionReport({
  lat,
  lon,
  landingDate,
  windowDays = 14,
  signal = null,
} = {}) {
  const response = await fetch(DEFAULT_REPORT_API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: Number(lat),
      lon: Number(lon),
      landingDate: String(landingDate || '2026-11-15'),
      windowDays: Number(windowDays) || 14,
    }),
    signal: signal || undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.report) {
    throw new Error(payload?.error || `FAILED_TO_GENERATE_REPORT (HTTP ${response.status})`);
  }
  return payload.report;
}

export async function fetchReportServiceHealth() {
  const response = await fetch(`${DEFAULT_REPORT_API_BASE}/health`, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
