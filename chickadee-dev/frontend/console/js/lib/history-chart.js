/* ============================================================
   HistoryChart — reusable SVG line-chart for HA entity history.

   Replaces iframing HA's /history panel (which can't escape
   the HA sidebar without the kiosk-mode HACS integration) with
   a self-contained chart that fetches via the add-on's
   /api/ha/history proxy.

   Usage:
       HistoryChart.render(hostEl, {
           entityId: 'sensor.lerch_32_ram_usage',
           hours: 24,         // optional preset, default 24
           color: '#2563eb',  // optional, default Console blue
       });
       // later:
       HistoryChart.dispose(hostEl);

   The chart owns its own range picker (1h/3h/6h/12h/24h/3d/1w/2w/1m/custom)
   in the toolbar — caller just opens the modal. State is held on
   hostEl._chart so range changes only re-fetch + re-render the body,
   not the whole shell (avoids button-flash on every change).
   ============================================================ */

const HistoryChart = {
    // --------------------------------------------------------
    // Range presets
    // --------------------------------------------------------

    PRESETS: [
        { hours: 1, label: '1h' },
        { hours: 3, label: '3h' },
        { hours: 6, label: '6h' },
        { hours: 12, label: '12h' },
        { hours: 24, label: '24h' },
        { hours: 72, label: '3d' },
        { hours: 168, label: '1w' },
        { hours: 336, label: '2w' },
        { hours: 720, label: '1m' },
    ],

    // --------------------------------------------------------
    // Public API
    // --------------------------------------------------------

    async render(host, opts) {
        if (!host) return;
        const {
            entityId,
            hours = 24,
            color = '#2563eb',
        } = opts || {};
        if (!entityId) {
            host.innerHTML = this._errorMarkup('No entity to chart');
            return;
        }

        // Dispose any prior chart on this host (entityId switch).
        if (host._chart?.abortController) host._chart.abortController.abort();
        host._chart = {
            entityId,
            color,
            mode: 'preset',
            hours,
            customStart: null,
            customEnd: null,
            abortController: null,
            data: null,
        };

        // Mark the host itself with data-history-root so buttons inside
        // the shell can find it via this.closest('[data-history-root]').
        // The _chart state lives on the host, not on the inner shell div
        // — without this attribute the buttons would walk up only as far
        // as the (state-less) shell div and setRange/showCustom would
        // bail at the !host?._chart guard.
        host.setAttribute('data-history-root', '');
        host.innerHTML = this._shellMarkup();
        this._updateActiveButton(host);
        return this._doFetch(host);
    },

    dispose(host) {
        if (!host) return;
        if (host._chart?.abortController) host._chart.abortController.abort();
        host._chart = null;
        host.innerHTML = '';
    },

    // --------------------------------------------------------
    // Range picker actions (called from button onclicks)
    // --------------------------------------------------------

    setRange(host, hours) {
        if (!host?._chart) return;
        host._chart.mode = 'preset';
        host._chart.hours = hours;
        const customRow = host.querySelector('[data-history-custom]');
        if (customRow) customRow.style.display = 'none';
        this._updateActiveButton(host);
        this._doFetch(host);
    },

    showCustom(host) {
        if (!host?._chart) return;
        host._chart.mode = 'custom';
        const customRow = host.querySelector('[data-history-custom]');
        if (!customRow) return;
        // Pre-populate inputs if empty: default 24h ending now in local time.
        const startInput = customRow.querySelector('[data-custom-start]');
        const endInput = customRow.querySelector('[data-custom-end]');
        if (startInput && !startInput.value) {
            const end = new Date();
            const start = new Date(end.getTime() - 24 * 3600 * 1000);
            startInput.value = this._toLocalInputValue(start);
            endInput.value = this._toLocalInputValue(end);
        }
        customRow.style.display = '';
        this._updateActiveButton(host);
    },

    applyCustom(host) {
        if (!host?._chart) return;
        const customRow = host.querySelector('[data-history-custom]');
        if (!customRow) return;
        const startVal = customRow.querySelector('[data-custom-start]')?.value;
        const endVal = customRow.querySelector('[data-custom-end]')?.value;
        if (!startVal || !endVal) {
            this._setBodyMarkup(host, this._errorMarkup('Pick a start and end time'));
            return;
        }
        const start = new Date(startVal);
        const end = new Date(endVal);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
            this._setBodyMarkup(host, this._errorMarkup('Start must be before end'));
            return;
        }
        host._chart.mode = 'custom';
        host._chart.customStart = start.toISOString();
        host._chart.customEnd = end.toISOString();
        this._updateActiveButton(host);
        this._doFetch(host);
    },

    // --------------------------------------------------------
    // Fetch + body render
    // --------------------------------------------------------

    async _doFetch(host) {
        const c = host._chart;
        if (!c) return;
        if (c.abortController) c.abortController.abort();
        const abortController = new AbortController();
        c.abortController = abortController;

        this._setBodyMarkup(host, this._loadingMarkup());
        try {
            const payload = await this._fetchHistory(c, abortController.signal);
            if (host._chart?.abortController !== abortController) return; // superseded
            c.data = payload;
            this._setBodyMarkup(host, this._chartMarkup(payload, c));
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.warn('[HistoryChart] fetch failed:', e);
            this._setBodyMarkup(host, this._errorMarkup(e.message || 'Failed to load history'));
        }
    },

    async _fetchHistory(c, signal) {
        const qs = new URLSearchParams({ entity_id: c.entityId });
        if (c.mode === 'custom' && c.customStart && c.customEnd) {
            qs.set('start_iso', c.customStart);
            qs.set('end_iso', c.customEnd);
        } else {
            qs.set('hours', String(c.hours));
        }
        const resp = await fetch(DashieAuth._addonUrl(`/api/ha/history?${qs}`), { signal });
        const body = await resp.json().catch(() => null);
        if (!resp.ok) {
            throw new Error(body?.message || body?.error || `HTTP ${resp.status}`);
        }
        return body;
    },

    _setBodyMarkup(host, markup) {
        const body = host.querySelector('[data-history-body]');
        if (body) body.innerHTML = markup;
    },

    // --------------------------------------------------------
    // Active-button styling
    // --------------------------------------------------------

    _updateActiveButton(host) {
        const c = host._chart;
        if (!c) return;
        const buttons = host.querySelectorAll('[data-range]');
        const activeKey = c.mode === 'custom' ? 'custom' : String(c.hours);
        buttons.forEach(btn => {
            const isActive = btn.dataset.range === activeKey;
            btn.classList.toggle('history-chart__range-btn--active', isActive);
        });
    },

    // --------------------------------------------------------
    // Markup
    // --------------------------------------------------------

    _shellMarkup() {
        const presetButtons = this.PRESETS.map(p =>
            `<button type="button" class="history-chart__range-btn" data-range="${p.hours}" onclick="HistoryChart.setRange(this.closest('[data-history-root]'), ${p.hours})">${p.label}</button>`
        ).join('');
        // NB: data-history-root is set on the OUTER host by render(),
        // not on this inner div — see comment in render() for why.
        return `
            <div class="history-chart">
                <div class="history-chart__toolbar">
                    <div class="history-chart__ranges">
                        ${presetButtons}
                        <button type="button" class="history-chart__range-btn" data-range="custom" onclick="HistoryChart.showCustom(this.closest('[data-history-root]'))">Custom</button>
                    </div>
                </div>
                <div class="history-chart__custom" data-history-custom style="display: none;">
                    <input type="datetime-local" data-custom-start class="history-chart__custom-input"/>
                    <span style="color: #6b7280; font-size: 12px;">to</span>
                    <input type="datetime-local" data-custom-end class="history-chart__custom-input"/>
                    <button type="button" class="history-chart__apply-btn" onclick="HistoryChart.applyCustom(this.closest('[data-history-root]'))">Apply</button>
                </div>
                <div data-history-body class="history-chart__body"></div>
            </div>
        `;
    },

    _loadingMarkup() {
        return `<div class="history-chart__center">Loading history…</div>`;
    },

    _errorMarkup(msg) {
        return `<div class="history-chart__center" style="color: #b91c1c;">${this._escape(msg)}</div>`;
    },

    _chartMarkup(payload, chartState) {
        const samples = Array.isArray(payload?.samples) ? payload.samples : [];
        const points = this._normalizeSamples(samples);
        if (points.length === 0) {
            return this._errorMarkup('No history data in this range');
        }
        const unit = payload?.unit || '';
        const currentStr = this._formatCurrent(payload?.current_state, unit);
        // For SVG x-tick formatting we need to know the window in hours,
        // which differs in custom vs preset mode.
        const xSpanHours = chartState.mode === 'custom'
            ? (Date.parse(payload.end_iso) - Date.parse(payload.start_iso)) / 3600 / 1000
            : chartState.hours;
        const svg = this._renderSvg(points, { color: chartState.color, hours: xSpanHours, unit });
        return `
            <div class="history-chart__current">${this._escape(currentStr)}</div>
            ${svg}
        `;
    },

    // --------------------------------------------------------
    // Data normalization
    // --------------------------------------------------------

    _normalizeSamples(samples) {
        const points = [];
        for (const s of samples) {
            const ts = Date.parse(s?.last_changed || s?.last_updated || '');
            const val = parseFloat(s?.state);
            if (!Number.isFinite(ts) || !Number.isFinite(val)) continue;
            points.push({ ts, val });
        }
        points.sort((a, b) => a.ts - b.ts);
        return points;
    },

    _formatCurrent(state, unit) {
        if (state == null || state === '') return '—';
        const num = parseFloat(state);
        if (Number.isFinite(num)) {
            const rounded = Math.abs(num) >= 100 ? Math.round(num) : Math.round(num * 10) / 10;
            return unit ? `${rounded}${unit === '%' ? '' : ' '}${unit}` : String(rounded);
        }
        return String(state);
    },

    _toLocalInputValue(d) {
        // <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in LOCAL time.
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // --------------------------------------------------------
    // SVG rendering — hand-rolled line chart, no deps.
    // --------------------------------------------------------

    _renderSvg(points, { color, hours, unit }) {
        // ViewBox is virtual — SVG scales to host width.
        const W = 800, H = 280;
        const M = { top: 16, right: 16, bottom: 30, left: 50 };
        const plotW = W - M.left - M.right;
        const plotH = H - M.top - M.bottom;

        const xs = points.map(p => p.ts);
        const ys = points.map(p => p.val);
        const xMin = xs[0];
        const xMax = xs[xs.length - 1];
        const xSpan = Math.max(xMax - xMin, 1);
        const yRange = this._niceYRange(ys, unit);
        const ySpan = yRange.max - yRange.min;

        const x = ts => M.left + ((ts - xMin) / xSpan) * plotW;
        const y = v => M.top + (1 - (v - yRange.min) / ySpan) * plotH;

        const linePath = points.map((p, i) =>
            `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.val).toFixed(1)}`
        ).join(' ');

        // Y ticks: 4 evenly spaced
        const yTicks = [0, 1, 2, 3, 4].map(i => {
            const v = yRange.min + (ySpan * i / 4);
            return { v, py: y(v) };
        });

        // X ticks: 4-5 evenly spaced labels based on window size
        const xTicks = this._xTickLabels(xMin, xMax, hours).map(t => ({
            label: t.label,
            px: x(t.ts),
        }));

        const fillPath = `${linePath} L${x(xMax).toFixed(1)},${(M.top + plotH).toFixed(1)} L${x(xMin).toFixed(1)},${(M.top + plotH).toFixed(1)} Z`;
        const fillColor = this._hexToRgba(color, 0.10);

        return `
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="history-chart__svg" role="img" aria-label="History chart">
                <g class="history-chart__gridlines">
                    ${yTicks.map(t => `
                        <line x1="${M.left}" y1="${t.py.toFixed(1)}" x2="${M.left + plotW}" y2="${t.py.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
                    `).join('')}
                </g>
                <g class="history-chart__ylabels" font-size="11" fill="#6b7280" text-anchor="end">
                    ${yTicks.map(t => `
                        <text x="${M.left - 8}" y="${(t.py + 3).toFixed(1)}">${this._formatTick(t.v, unit)}</text>
                    `).join('')}
                </g>
                <g class="history-chart__xlabels" font-size="11" fill="#6b7280" text-anchor="middle">
                    ${xTicks.map(t => `
                        <text x="${t.px.toFixed(1)}" y="${H - 10}">${this._escape(t.label)}</text>
                    `).join('')}
                </g>
                <path d="${fillPath}" fill="${fillColor}" stroke="none"/>
                <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            </svg>
        `;
    },

    _niceYRange(values, unit) {
        // Percent sensors get a fixed 0-100 axis so two adjacent chips
        // (RAM vs battery) read at the same scale.
        if (unit === '%') return { min: 0, max: 100 };
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        if (lo === hi) { lo -= 1; hi += 1; }
        const pad = (hi - lo) * 0.1;
        return { min: lo - pad, max: hi + pad };
    },

    _formatTick(v, unit) {
        const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
        return `${rounded}`;
    },

    _xTickLabels(xMin, xMax, hours) {
        const N = 5;
        const out = [];
        for (let i = 0; i < N; i++) {
            const ts = xMin + ((xMax - xMin) * i) / (N - 1);
            out.push({ ts, label: this._formatXLabel(ts, hours) });
        }
        return out;
    },

    _formatXLabel(ts, hours) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        if (hours <= 48) return `${hh}:${mm}`;
        const m = d.toLocaleString(undefined, { month: 'short' });
        const dd = d.getDate();
        if (hours <= 24 * 14) return `${m} ${dd} ${hh}:${mm}`;
        // 2w+ ranges: drop time-of-day, it just adds noise at the daily tick scale.
        return `${m} ${dd}`;
    },

    _hexToRgba(hex, alpha) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (!m) return `rgba(37, 99, 235, ${alpha})`;
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 0xff;
        const g = (n >> 8) & 0xff;
        const b = n & 0xff;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    _escape(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },
};

// Lazy style injection — keeps history-chart.css from being a separate
// fetch and avoids touching every page's stylesheet for a one-off module.
(function injectStyles() {
    if (document.getElementById('history-chart-styles')) return;
    const style = document.createElement('style');
    style.id = 'history-chart-styles';
    style.textContent = `
        .history-chart { display: flex; flex-direction: column; height: 100%; min-height: 320px; }
        .history-chart__toolbar { display: flex; align-items: center; justify-content: flex-start; padding: 0 0 8px; gap: 12px; }
        .history-chart__ranges { display: flex; gap: 4px; flex-wrap: wrap; }
        .history-chart__range-btn {
            font-size: 12px; padding: 4px 10px;
            border: 1px solid #d1d5db; border-radius: 4px;
            background: #fff; color: #374151; cursor: pointer;
            font-family: inherit; line-height: 1.2;
        }
        .history-chart__range-btn:hover { background: #f3f4f6; }
        .history-chart__range-btn--active {
            background: #2563eb; border-color: #2563eb; color: #fff;
        }
        .history-chart__range-btn--active:hover { background: #1d4ed8; }
        .history-chart__custom {
            display: flex; align-items: center; gap: 8px;
            padding: 4px 0 12px;
        }
        .history-chart__custom-input {
            font-size: 12px; padding: 4px 6px;
            border: 1px solid #d1d5db; border-radius: 4px;
            font-family: inherit;
        }
        .history-chart__apply-btn {
            font-size: 12px; padding: 4px 12px;
            border: 1px solid #2563eb; border-radius: 4px;
            background: #2563eb; color: #fff; cursor: pointer;
            font-family: inherit;
        }
        .history-chart__apply-btn:hover { background: #1d4ed8; }
        .history-chart__body { flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
        .history-chart__center { flex: 1; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 13px; padding: 32px 16px; }
        .history-chart__current { font-size: 28px; font-weight: 600; color: #111827; padding: 4px 0 8px; }
        .history-chart__svg { width: 100%; height: 100%; max-height: 320px; display: block; }
    `;
    document.head.appendChild(style);
})();
