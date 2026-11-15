import './celestialTooltip.css';

const CELESTIAL_PROFILES = {
  SUN: {
    name: 'Sun',
    badge: 'STAR · G2V',
    description: 'Central star of the Solar System (yellow dwarf), primary source of light and thermal radiation.',
    radius: '696,340 km (400× R☽)',
    physicalSpecLabel: 'Photosphere:',
    physicalSpecValue: '5,778 K',
    lightDelay: '~8m 19s',
    angularSize: '~0.53°',
  },
  EARTH: {
    name: 'Earth',
    badge: 'PLANET',
    description: 'Third planet from the Sun, the only known astronomical body with a biosphere and liquid hydrosphere.',
    radius: '6,371 km (3.67× R☽)',
    physicalSpecLabel: 'Orbital Period:',
    physicalSpecValue: '365.25 days',
    lightDelay: '~1.28 s (radio signal)',
    angularSize: '~1.9° from lunar orbit',
  },
};

export class CelestialTooltip {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'celestial-cursor-tooltip';
    this.el.innerHTML = `
      <div class="celestial-tooltip-header">
        <span class="celestial-tooltip-title" data-field="name"></span>
        <span class="celestial-tooltip-badge" data-field="badge"></span>
      </div>
      <div class="celestial-tooltip-desc" data-field="desc"></div>
      <div class="celestial-tooltip-specs" data-field="specs"></div>
    `;

    this.nameEl = this.el.querySelector('[data-field="name"]');
    this.badgeEl = this.el.querySelector('[data-field="badge"]');
    this.descEl = this.el.querySelector('[data-field="desc"]');
    this.specsEl = this.el.querySelector('[data-field="specs"]');

    document.body.appendChild(this.el);
  }

  _formatCoord(lat, lon) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lon).toFixed(2)}°${lonDir} ${Math.abs(lat).toFixed(2)}°${latDir}`;
  }

  _renderRows(rows) {
    return rows
      .map(
        ([label, value]) => `
          <div class="celestial-spec-row">
            <span class="celestial-spec-label">${label}</span>
            <span class="celestial-spec-val">${value}</span>
          </div>
        `
      )
      .join('');
  }

  /**
   * @param {Object|null} hoverBody - { type: 'SUN'|'EARTH', clientX, clientY, ephemData }
   */
  update(hoverBody) {
    if (!hoverBody || !CELESTIAL_PROFILES[hoverBody.type]) {
      this.hide();
      return;
    }

    const { type, clientX, clientY, ephemData } = hoverBody;
    const profile = CELESTIAL_PROFILES[type];

    this.el.classList.remove('is-sun', 'is-earth');
    this.el.classList.add(type === 'SUN' ? 'is-sun' : 'is-earth');

    this.nameEl.textContent = profile.name;
    this.badgeEl.textContent = profile.badge;
    this.descEl.textContent = profile.description;

    if (type === 'SUN') {
      const subSolar = ephemData
        ? this._formatCoord(ephemData.subSolarLat, ephemData.subSolarLon)
        : '—';
      const distStr = ephemData?.sunDistanceAu
        ? `${ephemData.sunDistanceAu.toFixed(4)} AU`
        : '~1.000 AU (149.6M km)';

      this.specsEl.innerHTML = this._renderRows([
        ['Radius:', profile.radius],
        [profile.physicalSpecLabel, profile.physicalSpecValue],
        ['Angular Diameter:', profile.angularSize],
        ['Distance:', distStr],
        ['Light Delay:', profile.lightDelay],
        ['Subsolar Point:', subSolar],
      ]);
    } else if (type === 'EARTH') {
      const subEarth = ephemData
        ? this._formatCoord(ephemData.subEarthLat, ephemData.subEarthLon)
        : '—';
      const distStr = ephemData?.earthDistanceKm
        ? `${Math.round(ephemData.earthDistanceKm).toLocaleString('en-US')} km`
        : '~384,400 km';

      this.specsEl.innerHTML = this._renderRows([
        ['Radius:', profile.radius],
        [profile.physicalSpecLabel, profile.physicalSpecValue],
        ['Angular Diameter:', profile.angularSize],
        ['Distance to Moon:', distStr],
        ['Signal Delay:', profile.lightDelay],
        ['Sub-Earth Point:', subEarth],
      ]);
    }

    this.el.classList.add('visible');

    const offset = 16;
    const rect = this.el.getBoundingClientRect();
    let x = clientX + offset;
    let y = clientY + offset;

    if (x + rect.width > window.innerWidth - 8) {
      x = clientX - rect.width - offset;
    }
    if (y + rect.height > window.innerHeight - 8) {
      y = clientY - rect.height - offset;
    }

    this.el.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  hide() {
    this.el.classList.remove('visible');
  }

  dispose() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
