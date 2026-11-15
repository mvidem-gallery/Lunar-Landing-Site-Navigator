import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const REPORT_ROOT = process.env.REPORT_ROOT_DIR || process.cwd();
const PROJECT_ROOT = process.env.NASA_PROJECT_ROOT || path.resolve(REPORT_ROOT, '../..');
const CACHE_DIR = path.join(PROJECT_ROOT, 'cache', 'report-bridge');
const BUNDLED_MODULE_PATH = path.join(CACHE_DIR, 'report-core.mjs');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_SYNTHESIS_MODEL = 'google/gemini-2.5-flash';
const SYNTHESIS_TIMEOUT_MS = 60_000;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // Ignore unreadable .env files
  }
}

loadEnvFile(path.join(REPORT_ROOT, '.env.local'));
loadEnvFile(path.join(REPORT_ROOT, '.env'));
loadEnvFile(path.join(PROJECT_ROOT, '.env.local'));
loadEnvFile(path.join(PROJECT_ROOT, '.env'));

let reportCorePromise = null;

async function getReportCore() {
  if (!reportCorePromise) {
    reportCorePromise = (async () => {
      const esbuildPath = require.resolve('esbuild', {
        paths: [PROJECT_ROOT, path.join(REPORT_ROOT, 'node_modules')],
      });
      const esbuild = await import(pathToFileURL(esbuildPath).href);

      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const entrySource = `
        export { extractLunarTelemetryAndSources } from './src/lib/lunarTelemetryExtractor.ts';
        export {
          composeFullMissionReport,
          makeFallbackReport,
          reportJsonSchema,
          validateGeneratedReport,
        } from './src/lib/lunarMissionReport.ts';
      `;

      await esbuild.build({
        stdin: {
          contents: entrySource,
          resolveDir: REPORT_ROOT,
          loader: 'ts',
          sourcefile: '__report_bridge_entry.ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        nodePaths: [
          path.join(REPORT_ROOT, 'node_modules'),
          path.join(PROJECT_ROOT, 'node_modules'),
        ],
        outfile: BUNDLED_MODULE_PATH,
        logLevel: 'silent',
      });

      const mod = await import(`${pathToFileURL(BUNDLED_MODULE_PATH).href}?v=${Date.now()}`);
      return mod;
    })();
  }
  return reportCorePromise;
}

function messageText(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .filter(
      (part) =>
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        typeof part.text === 'string'
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function callOpenRouterSynthesis(apiKey, body) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lunar-report-dss.local',
      'X-Title': 'Lunar Global Mission Report Engine',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!response.ok) {
    const detail =
      typeof data?.error?.message === 'string'
        ? data.error.message
        : `HTTP ${response.status}`;
    throw new Error(`OPENROUTER_SYNTHESIS_FAILED: ${detail}`);
  }
  return data;
}

async function generateMissionReport(body) {
  const lat = typeof body?.lat === 'number' ? body.lat : Number(body?.lat);
  const lon = typeof body?.lon === 'number' ? body.lon : Number(body?.lon);
  const landingDate =
    typeof body?.landingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.landingDate.trim())
      ? body.landingDate.trim()
      : '2026-11-15';
  const parsedWindow =
    typeof body?.windowDays === 'number' ? body.windowDays : Number(body?.windowDays);
  const windowDays =
    Number.isInteger(parsedWindow) && parsedWindow >= 1 && parsedWindow <= 30 ? parsedWindow : 14;

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { statusCode: 400, payload: { error: 'INVALID_LATITUDE_GLOBAL_RANGE' } };
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { statusCode: 400, payload: { error: 'INVALID_LONGITUDE_RANGE' } };
  }

  const core = await getReportCore();
  const { telemetry, sources, ephemerisMode } = await core.extractLunarTelemetryAndSources({
    lat,
    lon,
    landingDate,
    windowDays,
    profile: 'clps',
  });

  const synthesisModel = process.env.OPENROUTER_SYNTHESIS_MODEL || DEFAULT_SYNTHESIS_MODEL;
  const models = { extraction: ephemerisMode, synthesis: synthesisModel };
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 200,
      payload: {
        report: core.makeFallbackReport(telemetry, sources, {
          extraction: ephemerisMode,
          synthesis: 'deterministic-telemetry-fallback',
        }),
      },
    };
  }

  try {
    const frozenSources = sources.map((s) => ({
      id: s.id,
      name: s.name,
      publisher: s.publisher,
      domain: s.domain,
      usage: s.usage,
    }));

    const synthesis = await callOpenRouterSynthesis(apiKey, {
      model: synthesisModel,
      max_completion_tokens: 2048,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'lunar_mission_report',
          strict: true,
          schema: core.reportJsonSchema,
        },
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a Lunar Global CLPS Lander Mission Planning Analyst writing clear, plain-English engineering reports.',
            'Return ONLY valid JSON matching the exact schema.',
            'STRICT ANTI-HALLUCINATION RULE: Use ONLY the exact numbers provided in the user JSON payload. NEVER output JSON field names or camelCase code identifiers.',
            "THRESHOLD COMPARISON RULE: Compare like with like ONLY. Compare 'maxEclipseHours' against 'eclipseBatteryLimitHours'. Compare 'sunlightPercent' against 'targetSunlightPercent'. Compare 'maxBlackoutHours' against 'blackoutBufferLimitHours'.",
            "FAVORABLE FACTORS RULE: 'favorable' can have 0 to 3 items. ONLY include metrics that genuinely passed their threshold with margin (status PASS in criteriaTable). Never invent favorable items.",
            "RELAY RULE: Follow 'relayRequired' strictly.",
            'SUMMARY INSTRUCTIONS (4 to 5 clear sentences):',
            '1. State the site name, coordinates, verdict (GO, CONDITIONAL, or NO-GO) for CLPS Lander, elevation, and whether ground slope meets the 8° tilt limit.',
            '2. Explain solar power: sunlight hours and percentage, peak solar elevation, and compare maximum continuous eclipse duration against the 36-hour battery survival limit.',
            '3. Explain Earth communications: Direct-to-Earth uptime percentage, maximum continuous blackout against the 24-hour autonomous buffer limit, and whether an orbital relay is required.',
            '4. State the distance to Permanently Shadowed Regions (or polar distance) and conclude with the primary engineering takeaway.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            missionProfile: telemetry.meta.profile,
            siteName: telemetry.siteName,
            coordinates: {
              latitude: `${Math.abs(telemetry.lat).toFixed(2)}° ${telemetry.lat >= 0 ? 'N' : 'S'}`,
              longitude: `${Math.abs(telemetry.lon).toFixed(2)}° ${telemetry.lon >= 0 ? 'E' : 'W'}`,
            },
            verdict: telemetry.verdict,
            relayRequired: telemetry.relayRequired,
            insidePermanentlyShadowedRegion: telemetry.isInsidePsr,
            criteriaTable: telemetry.scoreBreakdown,
            measurements: {
              elevationMeters: telemetry.rawNumbers.elevationM,
              slopeDegrees: telemetry.rawNumbers.slopeDeg,
              slopeLimitDegrees: telemetry.rawNumbers.maxSlopeLimitDeg,
              horizonObstructionDegrees: telemetry.rawNumbers.horizonBlockDeg,
              minHorizonDegrees: telemetry.rawNumbers.minHorizonDeg,
              distanceToPsrKm: telemetry.rawNumbers.psrDistKm,
              sunlightHours: telemetry.rawNumbers.sunlightHours,
              sunlightPercent: telemetry.rawNumbers.sunlightPct,
              targetSunlightPercent: telemetry.rawNumbers.targetSunPct,
              peakSunElevationDegrees: telemetry.rawNumbers.peakSolarElevDeg,
              maxEclipseHours: telemetry.rawNumbers.maxEclipseHours,
              eclipseBatteryLimitHours: telemetry.rawNumbers.maxEclipseSafeHrs,
              dteUptimePercent: telemetry.rawNumbers.dteUptimePct,
              maxBlackoutHours: telemetry.rawNumbers.maxBlackoutHours,
              blackoutBufferLimitHours: telemetry.rawNumbers.maxBlackoutLimitHrs,
            },
            frozenSources,
          }),
        },
      ],
    });

    const synthesisText = messageText(synthesis.choices?.[0]?.message?.content);
    if (!synthesisText) {
      return {
        statusCode: 200,
        payload: { report: core.makeFallbackReport(telemetry, sources, models) },
      };
    }

    const validatedSynthesis = core.validateGeneratedReport(
      JSON.parse(synthesisText),
      sources,
      telemetry
    );
    const fullReport = core.composeFullMissionReport(telemetry, validatedSynthesis, sources, models);
    return { statusCode: 200, payload: { report: fullReport } };
  } catch (error) {
    console.error('OpenRouter global lunar synthesis failed, using telemetry-backed fallback:', error);
    return {
      statusCode: 200,
      payload: { report: core.makeFallbackReport(telemetry, sources, models) },
    };
  }
}

function getHealthInfo() {
  const dataDir = path.join(REPORT_ROOT, 'src', 'data');
  return {
    ok: true,
    reportRoot: REPORT_ROOT,
    hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    synthesisModel: process.env.OPENROUTER_API_KEY
      ? process.env.OPENROUTER_SYNTHESIS_MODEL || DEFAULT_SYNTHESIS_MODEL
      : 'deterministic-telemetry-fallback',
    hasGlobalDemBin: fs.existsSync(path.join(dataDir, 'lunar-global-dem.bin')),
    hasPolarLolaBin: fs.existsSync(path.join(dataDir, 'lola-80s-100m.bin')),
  };
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, type, body } = msg;
  try {
    if (type === 'health') {
      process.send?.({ id, statusCode: 200, payload: getHealthInfo() });
      return;
    }
    if (type === 'generate') {
      const result = await generateMissionReport(body);
      process.send?.({ id, statusCode: result.statusCode, payload: result.payload });
      return;
    }
    process.send?.({ id, statusCode: 400, payload: { error: 'UNKNOWN_WORKER_COMMAND' } });
  } catch (err) {
    process.send?.({
      id,
      statusCode: 500,
      payload: { error: err?.message || 'REPORT_WORKER_FAILURE' },
    });
  }
});

// Signal parent ready
process.send?.({ type: 'ready' });
