import './celestialTooltip.css';

const CELESTIAL_PROFILES = {
  SUN: {
    name: 'Сонце',
    badge: 'ЗОРЯ · G2V',
    description: 'Центральна зоря Сонячної системи (жовтий карлик), головне джерело світла та теплового випромінювання.',
    radius: '696 340 км (400× R☽)',
    physicalSpecLabel: 'Фотосфера:',
    physicalSpecValue: '5 778 K',
    lightDelay: '~8 хв 19 с',
    angularSize: '~0.53°',
  },
  EARTH: {
    name: 'Земля',
    badge: 'ПЛАНЕТА',
    description: 'Третя планета від Сонця, єдине відоме астрономічне тіло з біосферою та рідкою гідросферою.',
    radius: '6 371 км (3.67× R☽)',
    physicalSpecLabel: 'Орбіт. період:',
    physicalSpecValue: '365.25 діб',
    lightDelay: '~1.28 с (радіосигнал)',
    angularSize: '~1.9° з орбіти Місяця',
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
        ? `${ephemData.sunDistanceAu.toFixed(4)} а.о.`
        : '~1.000 а.о. (149.6 млн км)';

      this.specsEl.innerHTML = this._renderRows([
        ['Радіус:', profile.radius],
        [profile.physicalSpecLabel, profile.physicalSpecValue],
        ['Кутовий діаметр:', profile.angularSize],
        ['Відстань:', distStr],
        ['Затримка світла:', profile.lightDelay],
        ['Зеніт на Місяці:', subSolar],
      ]);
    } else if (type === 'EARTH') {
      const subEarth = ephemData
        ? this._formatCoord(ephemData.subEarthLat, ephemData.subEarthLon)
        : '—';
      const distStr = ephemData?.earthDistanceKm
        ? `${Math.round(ephemData.earthDistanceKm).toLocaleString('uk-UA')} км`
        : '~384 400 км';

      this.specsEl.innerHTML = this._renderRows([
        ['Радіус:', profile.radius],
        [profile.physicalSpecLabel, profile.physicalSpecValue],
        ['Кутовий діаметр:', profile.angularSize],
        ['Відстань до Місяця:', distStr],
        ['Затримка сигналу:', profile.lightDelay],
        ['Субземна точка:', subEarth],
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