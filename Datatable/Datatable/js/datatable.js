/**
 * Универсальные утилиты сортировки, рендеринга таблиц и экспорта в CSV.
 */

(() => {
'use strict';

window.LWP = window.LWP || {};

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNum(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatUtc(isoLike) {
  if (!isoLike) return '—';
  return String(isoLike).replace(' UTC', '');
}

function sortRows(rows, sortKey, sortDir = 'asc') {
  if (!sortKey) return rows;
  const dir = sortDir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];

    const aNull = va === null || va === undefined || va === '';
    const bNull = vb === null || vb === undefined || vb === '';
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;

    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * dir;
    }
    if (typeof va === 'boolean' && typeof vb === 'boolean') {
      return (Number(va) - Number(vb)) * dir;
    }
    return String(va).localeCompare(String(vb), 'en', { numeric: true }) * dir;
  });
}

/**
 * Рендерит таблицу в переданный элемент <table>.
 */
function renderTable({
  tableEl,
  columns,
  rows,
  sortState,
  onSort,
  onRowClick,
  selectedId = null,
  getRowId = (r) => r.id,
  getRowClass = null,
  expandedIds = null,
  renderExpandedRow = null,
}) {
  const thead = tableEl.querySelector('thead');
  const tbody = tableEl.querySelector('tbody');

  // Заголовок
  const headerCells = columns
    .map((col) => {
      const sortable = col.sortable !== false;
      const isSorted = sortState && sortState.key === col.key;
      const indicator = isSorted ? (sortState.dir === 'asc' ? '▲' : '▼') : '⇅';
      const cls = [sortable ? 'sortable' : '', col.align === 'right' ? 'num' : '']
        .filter(Boolean)
        .join(' ');
      return `<th class="${cls}" data-col="${escapeHtml(col.key)}">
        ${escapeHtml(col.label)}
        ${sortable ? `<span class="sort-indicator">${indicator}</span>` : ''}
      </th>`;
    })
    .join('');

  thead.innerHTML = `<tr>${headerCells}</tr>`;

  if (onSort) {
    thead.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => onSort(th.dataset.col));
    });
  }

  // Строки
  const rowHtmlParts = [];
  for (const row of rows) {
    const rowId = getRowId(row);
    const isSelected = selectedId !== null && rowId === selectedId;
    const extraClass = getRowClass ? getRowClass(row) : '';
    const trClass = [isSelected ? 'selected-row' : '', extraClass]
      .filter(Boolean)
      .join(' ');

    const cells = columns
      .map((col) => {
        const rawVal = row[col.key];
        const content = col.render ? col.render(rawVal, row) : escapeHtml(rawVal ?? '—');
        const tdClasses = [
          col.align === 'right' ? 'num' : '',
          col.mono ? 'mono' : '',
          col.wrap ? 'wrap-cell' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<td class="${tdClasses}">${content}</td>`;
      })
      .join('');

    rowHtmlParts.push(
      `<tr data-row-id="${escapeHtml(rowId)}" class="${trClass}">${cells}</tr>`
    );

    if (expandedIds && expandedIds.has(rowId) && renderExpandedRow) {
      rowHtmlParts.push(
        `<tr class="log-json-row"><td colspan="${columns.length}">${renderExpandedRow(row)}</td></tr>`
      );
    }
  }

  tbody.innerHTML = rowHtmlParts.join('');

  if (onRowClick) {
    tbody.querySelectorAll('tr[data-row-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input')) return;
        const id = tr.dataset.rowId;
        const row = rows.find((r) => String(getRowId(r)) === id);
        if (row) onRowClick(row, e);
      });
    });
  }
}

function formatCsvNumber(num, decimals) {
  const fixed =
    typeof decimals === 'number' ? num.toFixed(decimals) : String(num);
  return fixed.replace('.', ',');
}

function exportRowsToCsv(filename, columns, rows, options = {}) {
  const delimiter = options.delimiter ?? ';';
  const exportCols = columns.filter((c) => !c.noExport);
  const header = exportCols.map((c) => csvCell(c.label)).join(delimiter);

  const lines = rows.map((row) =>
    exportCols
      .map((c) => {
        let val = c.exportValue ? c.exportValue(row) : row[c.key];
        if (typeof val === 'number' && Number.isFinite(val)) {
          val =
            delimiter === ';'
              ? formatCsvNumber(val, c.decimals)
              : typeof c.decimals === 'number'
              ? val.toFixed(c.decimals)
              : val;
        } else if (typeof val === 'boolean') {
          val = val ? 'Yes' : 'No';
        }
        return csvCell(val);
      })
      .join(delimiter)
  );

  const csvContent = '\uFEFF' + [header, ...lines].join('\r\n');
  triggerDownload(filename, csvContent, 'text/csv;charset=utf-8;');
}

function exportJsonFile(filename, data) {
  const jsonContent = JSON.stringify(data, null, 2);
  triggerDownload(filename, jsonContent, 'application/json;charset=utf-8;');
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(val) {
  if (val === null || val === undefined) return '""';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return `"${str.replaceAll('"', '""')}"`;
}

window.LWP.datatable = {
  escapeHtml,
  formatNum,
  formatUtc,
  sortRows,
  renderTable,
  exportRowsToCsv,
  exportJsonFile,
};
})();
