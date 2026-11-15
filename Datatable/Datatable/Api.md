# LWP Mission Datatable — API Reference

This document describes the JavaScript integration API exposed by the Mission Datatable application (`js/store.js`, `js/parser.js`).

All APIs work both in standard browser windows and inside embedded WebViews / Electron / Tauri / iframe hosts without requiring a backend server.

---

## 1. Global JavaScript API (`window.MissionDatatable`)

When the application initializes, it attaches `window.MissionDatatable` to the global `window` object.

### `ingest(json, meta?)`

Parses and adds (or updates) a single mission log in the table, sets it as the active mission, persists it to `IndexedDB`, and re-renders the UI.

- **Parameters:**
  - `json` (`object`, required): Parsed `lwp-flight/2` JSON object.
  - `meta` (`object`, optional):
    - `filename` (`string`): Original filename (falls back to `json.files.flight_log` or a generated timestamp name).
    - `source` (`string`): Source label (defaults to `'api'`).
    - `receivedAt` (`string`): ISO timestamp (defaults to current time).
- **Returns:** `string` — Unique mission ID (`"<filename>::<run.started_utc>"`).

```js
const missionId = window.MissionDatatable.ingest(flightJsonObject, {
  filename: 'flight-2026-11-15T163612Z.json',
  source: 'external-app',
});
```

---

### `ingestBatch(items)`

Ingests multiple mission logs in sequence.

- **Parameters:**
  - `items` (`Array<object | { json: object, meta?: object }>`): Either raw JSON objects or `{ json, meta }` wrappers.
- **Returns:** `string[]` — Array of ingested mission IDs.

```js
const ids = window.MissionDatatable.ingestBatch([
  { json: missionA, meta: { filename: 'mission-a.json' } },
  { json: missionB, meta: { filename: 'mission-b.json' } },
]);
```

---

### `getMissions()`

Returns an array of normalized summary rows for all currently loaded missions.

- **Returns:** `Array<MissionRow>`

```js
const rows = window.MissionDatatable.getMissions();
console.log(rows.map((m) => ({ num: m.num, dv: m.dv_total_m_s, status: m.status })));
```

---

### `getActiveMission()`

Returns the full normalized object for the currently selected mission (including `mission`, `timeline`, `economyDays`, `spaceportsCompared`, `logEntries`, and `rawMeta`), or `null` if no missions are loaded.

- **Returns:** `ParsedMission | null`

---

### `removeMission(id)`

Removes a mission by its ID and updates `IndexedDB`.

- **Parameters:**
  - `id` (`string`): Mission ID returned by `ingest(...)` or `getMissions()[i].id`.

---

### `clear()`

Clears all missions from memory and `IndexedDB`, resetting mission numbering back to `1`.

---

### `subscribe(listener)`

Subscribes to store state changes (ingestion, selection, removal, clearing).

- **Parameters:**
  - `listener` (`(store) => void`): Callback invoked whenever the store updates.
- **Returns:** `() => void` — Unsubscribe function.

```js
const unsubscribe = window.MissionDatatable.subscribe((store) => {
  console.log('Total missions:', store.missions.length);
});
```

---

## 2. Cross-Window Messaging (`window.postMessage`)

If the datatable is hosted inside an `<iframe>` or WebView where direct access to `window.MissionDatatable` is inconvenient, you can push mission logs via `postMessage`.

### Message Format

```js
targetWindow.postMessage(
  {
    type: 'LWP_INGEST_LOG',
    filename: 'flight-2026-11-15T163612Z.json', // optional
    payload: flightJsonObject,                   // required lwp-flight/2 JSON object
  },
  '*'
);
```

- When received, the app calls `window.MissionDatatable.ingest(msg.payload, { filename: msg.filename, source: 'postMessage' })`.
- If `payload` is invalid, an error banner is displayed in the UI.

---

## 3. Expected Input Schema (`lwp-flight/2`)

The parser (`window.LWP.parseFlightJson` in `js/parser.js`) expects an object matching the `lwp-flight/2` format produced by `launch-window-prediction`:

| Top-level key | Used fields |
| --- | --- |
| `format` | Format identifier (e.g. `"lwp-flight/2"`). |
| `run` | `program`, `version`, `args`, `started_utc`, `ok`, `outcome`, `elapsed_s`. |
| `summary` | `status`, `trajectory`, `mode`, `values_from`, `spaceport`, `rocket`, `spacecraft`, `landing_site`, `launch_utc`, `lunar_orbit_insertion_utc`, `touchdown_utc`, `durations`, `delta_v`, `moon_distance_at_arrival_km`, `economy.chosen_shift_days`, `economy.days[]`, `timeline[]`, `spaceports_compared[]`. |
| `launch_site` | `id`, `name`. |
| `landing_site` | `landing.orbit_pass`, `landing.wait_in_lunar_orbit`, `landing.lunar_orbit`, `landing.descent`, `conditions_at_touchdown.sun`, `conditions_at_touchdown.earth`. |
| `files` | `flight_log`, `trajectory_log`. |
| `log` | Array of `{ seq, wall_time_utc, event, data }` entries. |

Missing or `null` nested fields are handled gracefully and normalized to `null` or `'—'`.

---

## 4. Persistence (`IndexedDB`)

- Database name: `lwp_mission_datatable_v1`
- Object store: `state`
- Snapshot key: `missions_snapshot`
- All ingested missions (via file drop, file picker, `MissionDatatable.ingest`, or `postMessage`) are automatically persisted to `IndexedDB` and restored on page reload.
