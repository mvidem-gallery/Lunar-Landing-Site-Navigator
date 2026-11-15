import {D, dot, frame} from './math.js?v=orbit-v1';

const day = 86400000;
const j2000 = Date.UTC(2000, 0, 1, 12);
// IAU 2009 lunar orientation, as tabulated in NAIF pck00011.tpc.
const argumentsAtEpoch = [125.045, 250.089, 260.008, 176.625, 357.529, 311.589, 134.963, 276.617, 34.226, 15.134, 119.743, 239.961, 25.053];
const ratesPerCentury = [-1935.5364525, -3871.072905, 475263.3328725, 487269.629985, 35999.0509575, 964468.49931, 477198.869325, 12006.300765, 63863.5132425, -5806.6093575, 131.84064, 6003.1503825, 473327.79642];
const raTerms = [-3.8787, -0.1204, 0.0700, -0.0172, 0, 0.0072, 0, 0, 0, -0.0052, 0, 0, 0.0043];
const decTerms = [1.5419, 0.0239, -0.0278, 0.0068, 0, -0.0029, 0.0009, 0, 0, 0.0008, 0, 0, -0.0009];
const rotationTerms = [3.5610, 0.1208, -0.0642, 0.0158, 0.0252, -0.0066, -0.0047, -0.0046, 0.0028, 0.0052, 0.0040, 0.0019, -0.0044];

export function equatorialVector(ra, dec) {
  const longitude = ra * D, latitude = dec * D;
  return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
}

export function lunarSkyBasis(time, latitude, longitude) {
  // TT approximated from UTC for presentation-scale sky positions.
  const days = (time - j2000 + 69184) / day;
  const centuries = days / 36525;
  let ra = 269.9949 + 0.0031 * centuries;
  let dec = 66.5392 + 0.0130 * centuries;
  let meridian = 38.3213 + 13.17635815 * days - 1.4e-12 * days * days;
  for (let i = 0; i < argumentsAtEpoch.length; i++) {
    const angle = (argumentsAtEpoch[i] + ratesPerCentury[i] * centuries) * D;
    ra += raTerms[i] * Math.sin(angle);
    dec += decTerms[i] * Math.cos(angle);
    meridian += rotationTerms[i] * Math.sin(angle);
  }
  const sinRA = Math.sin(ra * D), cosRA = Math.cos(ra * D);
  const sinDec = Math.sin(dec * D), cosDec = Math.cos(dec * D);
  const node = [-sinRA, cosRA, 0];
  const equator = [-sinDec * cosRA, -sinDec * sinRA, cosDec];
  const pole = [cosDec * cosRA, cosDec * sinRA, sinDec];
  const c = Math.cos(meridian * D), s = Math.sin(meridian * D);
  const x = node.map((v, i) => c * v + s * equator[i]);
  const y = node.map((v, i) => -s * v + c * equator[i]);
  const {east, north, up} = frame(latitude, longitude);
  return [east, up, north.map(v => -v)].map(axis =>
    x.map((v, i) => axis[0] * v + axis[1] * y[i] + axis[2] * pole[i]));
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function earthTextureBasis(viewer, northPole, observerLon, observerLat) {
  let east = cross(northPole, viewer);
  const length = Math.hypot(...east);
  // A pole-on view has no projected north. Use the scene up direction to
  // define the otherwise arbitrary roll at the singularity.
  if (length < 1e-9) east = cross(Math.abs(viewer[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], viewer);
  const norm = Math.hypot(...east);
  east = east.map(v => v / norm);
  const north = cross(viewer, east);
  const geo = frame(observerLat, observerLon);
  return geo.up.map((v, i) => viewer.map((w, j) => v * w + geo.east[i] * east[j] + geo.north[i] * north[j]));
}
