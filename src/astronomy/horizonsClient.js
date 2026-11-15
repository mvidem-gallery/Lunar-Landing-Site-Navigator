import { HORIZONS_CONFIG } from '../config/constants.js';

const ephemCache = new Map();

export class HorizonsClient {
  static async fetchEphemerisData(dateObj) {
    const startTime = this.formatDateForJPL(dateObj);
    if (ephemCache.has(startTime)) {
      return ephemCache.get(startTime);
    }

    const stopTime = this.formatDateForJPL(new Date(dateObj.getTime() + 60000));

    const params = new URLSearchParams({
      format: 'json',
      COMMAND: HORIZONS_CONFIG.COMMAND,
      OBJ_DATA: 'NO',
      MAKE_EPHEM: 'YES',
      EPHEM_TYPE: 'OBSERVER',
      CENTER: HORIZONS_CONFIG.CENTER,
      START_TIME: `'${startTime}'`,
      STOP_TIME: `'${stopTime}'`,
      STEP_SIZE: "'1m'",
      QUANTITIES: HORIZONS_CONFIG.QUANTITIES,
    });

    try {
      const response = await fetch(`${HORIZONS_CONFIG.PROXY_ENDPOINT}?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const data = await response.json();
      if (!data.result) throw new Error('Missing result field in JPL response');

      const parsed = this.parseHorizonsResponse(data.result);
      const result = { ...parsed, source: 'NASA JPL Horizons' };
      if (ephemCache.size > 200) {
        const oldestKey = ephemCache.keys().next().value;
        ephemCache.delete(oldestKey);
      }
      ephemCache.set(startTime, result);
      return result;
    } catch (error) {
      console.warn('Using analytical fallback due to API error:', error.message);
      const fallback = this.calculateAnalyticalFallback(dateObj);
      return { ...fallback, source: 'Analytical Model (Offline)' };
    }
  }

  static formatDateForJPL(date) {
    return date.toISOString().replace('T', ' ').substring(0, 16);
  }

  static parseHorizonsResponse(rawText) {
    const soeIndex = rawText.indexOf('$$SOE');
    const eoeIndex = rawText.indexOf('$$EOE');
    if (soeIndex === -1 || eoeIndex === -1) {
      throw new Error('Ephemeris markers $$SOE/$$EOE not found');
    }

    const ephemBlock = rawText.substring(soeIndex + 5, eoeIndex).trim();
    const firstLine = ephemBlock.split('\n')[0].trim();
    const parts = firstLine.split(/\s+/);

    const len = parts.length;
    const subObsLon = parseFloat(parts[len - 4]);
    const subObsLat = parseFloat(parts[len - 3]);
    const subSolarLon = parseFloat(parts[len - 2]);
    const subSolarLat = parseFloat(parts[len - 1]);

    if ([subObsLon, subObsLat, subSolarLon, subSolarLat].some(Number.isNaN)) {
      throw new Error('Failed to parse coordinates from line: ' + firstLine);
    }

    return {
      subEarthLon: subObsLon,
      subEarthLat: subObsLat,
      subSolarLon,
      subSolarLat,
      distanceAU: 1.0,
    };
  }

  static calculateAnalyticalFallback(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const d = jd - 2451545.0;
    const D = (297.8501921 + 12.19074912 * d) % 360;
    let subSolarLon = (((180 - D) % 360) + 540) % 360 - 180;
    const subSolarLat = 1.54 * Math.sin(((D * Math.PI) / 180) * 0.99);

    const subEarthLon = 6.0 * Math.sin(d * 0.228);
    const subEarthLat = 6.5 * Math.cos(d * 0.23);

    return {
      subEarthLon,
      subEarthLat,
      subSolarLon,
      subSolarLat,
      distanceAU: 1.0,
    };
  }
}
