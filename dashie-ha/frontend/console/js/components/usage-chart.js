/* ============================================================
   Usage Chart
   ------------------------------------------------------------
   Pure-presentation stacked-bar chart for the Token Usage view's
   Daily / Monthly Graph modes. Hand-rolled SVG (no chart lib) to
   match the dependency-free console.

   Segments per bar = AI / Speech / Tools (in that stack order).
   Cost truth stays in AccountUsage; this module only shapes the
   passed-in day rows into buckets and draws them.

   Usage:
     const bucketFn = row => 'ai' | 'speech' | 'tools';
     const costFn   = row => Number;   // USD for the row
     UsageChart.render(UsageChart.dayBuckets(days, bucketFn, costFn), { note });
     UsageChart.render(UsageChart.monthBuckets(days, bucketFn, costFn));

   Tooltip: a single body-attached div, positioned on mousemove over
   any bar segment (or its full-height transparent hit area).
   ============================================================ */

const UsageChart = {
    COLORS: { ai: '#3b82f6', speech: '#10b981', tools: '#f59e0b' },
    ORDER: ['ai', 'speech', 'tools'],
    LABELS: { ai: 'AI', speech: 'Speech', tools: 'Tools' },

    _tip: null,   // singleton tooltip element

    // ── data shaping (cost/bucket logic injected by the caller) ──

    /** Per-day buckets: [{label, day, month, ai, speech, tools, total}], date
     *  order preserved. `day`/`month` drive the two-tier axis (day number on
     *  every bar, one month label per month span). */
    dayBuckets(days, bucketFn, costFn) {
        return (days || []).map(d => ({
            label: this._dayLabel(d.date),
            day: this._dayNum(d.date),
            month: this._monthShort(d.date),
            ...this._sum(d.by_service, bucketFn, costFn),
        }));
    },

    /** Aggregate days into months ('YYYY-MM'), ascending. */
    monthBuckets(days, bucketFn, costFn) {
        const m = new Map();
        for (const d of (days || [])) {
            const ym = (d.date || '').slice(0, 7);
            const acc = m.get(ym) || { ai: 0, speech: 0, tools: 0, total: 0 };
            const s = this._sum(d.by_service, bucketFn, costFn);
            acc.ai += s.ai; acc.speech += s.speech; acc.tools += s.tools; acc.total += s.total;
            m.set(ym, acc);
        }
        return Array.from(m.entries())
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([ym, g]) => ({ label: this._monthLabel(ym), ...g }));
    },

    /** Drop leading + trailing all-zero buckets (interior gaps are kept) so the
     *  chart starts at the first bucket with usage and ends at the last — no big
     *  empty run before the data. */
    trimEmptyEnds(buckets) {
        let lo = 0, hi = buckets.length - 1;
        while (lo <= hi && (buckets[lo].total || 0) <= 0) lo++;
        while (hi >= lo && (buckets[hi].total || 0) <= 0) hi--;
        return lo > hi ? [] : buckets.slice(lo, hi + 1);
    },

    _sum(byService, bucketFn, costFn) {
        const o = { ai: 0, speech: 0, tools: 0, total: 0 };
        for (const r of (byService || [])) {
            const c = Number(costFn(r)) || 0;
            const k = bucketFn(r);
            if (o[k] != null) o[k] += c;
            o.total += c;
        }
        return o;
    },

    // ── render ───────────────────────────────────────────────

    /** buckets: [{label, ai, speech, tools, total}]; opts: { note? } */
    render(buckets, opts = {}) {
        if (!buckets || !buckets.length) {
            return `<div style="padding:32px 16px; text-align:center; color:var(--text-muted); font-size:13px;">No usage in this range.</div>`;
        }
        // Two-tier axis (day buckets): day number under every bar, a bracket
        // grouping each month's days, and one month label per span. Month
        // buckets keep the single sparse row.
        const twoTier = buckets.every(b => b.day != null && b.month);
        const H = twoTier ? 214 : 200, padTop = 12, padBottom = twoTier ? 40 : 26, padLeft = 50;
        const plotH = H - padTop - padBottom;
        const slot = 34, barW = 22;
        // Daily average reference line (two-tier only).
        const avg = twoTier ? buckets.reduce((s, b) => s + (b.total || 0), 0) / buckets.length : null;
        const width = Math.max(560, padLeft + buckets.length * slot + 14);
        const plotRight = width - 6;
        const maxTotal = Math.max(...buckets.map(b => b.total), 0.0001);
        const yFor = v => padTop + plotH - (v / maxTotal) * plotH;

        const grid = [0, maxTotal / 2, maxTotal].map(v => {
            const y = yFor(v);
            return `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="var(--border,#e5e7eb)" stroke-width="1"/>
                    <text x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-muted,#888)">${this._axis(v)}</text>`;
        }).join('');

        // Average line: dashed, muted (an annotation, not a series). The value
        // is called out at BOTH ends of the line — a wide chart scrolls
        // horizontally (anchored to the recent end), so a single-end label can
        // sit past the scroll fold. The surface-colored halo keeps the text
        // readable when it crosses a bar.
        let avgLine = '';
        if (avg != null && avg > 0) {
            const y = yFor(avg);
            const labelY = y < padTop + 14 ? y + 12 : y - 5;   // flip below the line when near the top
            const lbl = (x, anchor) =>
                `<text x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}" font-size="9" font-weight="600" fill="var(--text-muted,#888)" stroke="var(--surface,#fff)" stroke-width="3" paint-order="stroke">avg ${this._money(avg)}/day</text>`;
            avgLine = `<g pointer-events="none">
                       <line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="var(--text-muted,#888)" stroke-width="1" stroke-dasharray="4 3"/>
                       ${lbl(padLeft + 4, 'start')}
                       ${lbl(plotRight - 4, 'end')}</g>`;
        }

        const labelEvery = Math.ceil(buckets.length / 12);
        const bars = buckets.map((b, i) => {
            const x = padLeft + i * slot + (slot - barW) / 2;
            const tip = this._tipText(b);
            let y = padTop + plotH, segs = '';
            for (const k of this.ORDER) {
                const v = b[k] || 0;
                if (v <= 0) continue;
                const h = (v / maxTotal) * plotH;
                y -= h;
                segs += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="${this.COLORS[k]}" data-tip="${tip}"></rect>`;
            }
            // full-height transparent hit area so tiny bars are still hoverable
            segs += `<rect x="${x.toFixed(1)}" y="${padTop}" width="${barW}" height="${plotH}" fill="transparent" data-tip="${tip}"></rect>`;
            if (twoTier) {
                segs += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 23}" text-anchor="middle" font-size="8.5" fill="var(--text-muted,#888)">${this._esc(b.day)}</text>`;
            } else {
                const showLabel = (i % labelEvery === 0) || i === buckets.length - 1;
                if (showLabel) {
                    segs += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="9" fill="var(--text-muted,#888)">${this._esc(b.label)}</text>`;
                }
            }
            return segs;
        }).join('');

        // Month row: a bracket under each month's span of day numbers (end
        // ticks turned up toward the days it groups), month label beneath,
        // and a vertical rule through the plot at each month boundary.
        let monthRow = '';
        if (twoTier) {
            const bktY = H - 17, tick = 3;
            for (let i = 0; i < buckets.length;) {
                let j = i;
                while (j < buckets.length && buckets[j].month === buckets[i].month) j++;
                const x1 = padLeft + i * slot + 3;
                const x2 = padLeft + j * slot - 3;
                const cx = (x1 + x2) / 2;
                if (i > 0) {
                    const xb = padLeft + i * slot;
                    monthRow += `<line x1="${xb}" y1="${padTop}" x2="${xb}" y2="${bktY}" stroke="var(--border,#e5e7eb)" stroke-width="1"/>`;
                }
                monthRow += `<path d="M ${x1.toFixed(1)} ${bktY - tick} V ${bktY} H ${x2.toFixed(1)} V ${bktY - tick}" fill="none" stroke="var(--border,#e5e7eb)" stroke-width="1"/>
                             <text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--text-muted,#888)">${this._esc(buckets[i].month)}</text>`;
                i = j;
            }
        }

        const legend = this.ORDER.map(k =>
            `<span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--text-muted);">
                <span style="width:10px; height:10px; border-radius:2px; background:${this.COLORS[k]};"></span>${this.LABELS[k]}
             </span>`).join('');
        const note = opts.note
            ? `<div style="font-size:11px; color:var(--text-muted); padding:0 16px 8px;">${this._esc(opts.note)}</div>`
            : '';

        return `
            <div style="display:flex; gap:14px; padding:10px 16px 4px;">${legend}</div>
            ${note}
            <div style="overflow-x:auto; padding:0 8px 8px; direction:rtl;">
                <!-- rtl on the scroller anchors the initial scroll position to the
                     RIGHT (most recent days); the ltr wrapper restores normal layout. -->
                <div style="direction:ltr; width:${width}px;">
                    <svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" style="display:block;"
                         onmousemove="UsageChart.onMove(event)" onmouseleave="UsageChart.hideTip()">
                        ${grid}
                        ${bars}
                        ${avgLine}
                        ${monthRow}
                    </svg>
                </div>
            </div>`;
    },

    _tipText(b) {
        const parts = [b.label];
        for (const k of this.ORDER) if ((b[k] || 0) > 0) parts.push(`${this.LABELS[k]}: ${this._money(b[k])}`);
        parts.push(`Total: ${this._money(b.total)}`);
        return this._esc(parts.join('\n'));   // newlines survive in the attribute; shown via white-space:pre-line
    },

    // ── tooltip (singleton, body-attached, injection-safe via textContent) ──

    onMove(evt) {
        const t = evt.target;
        const tip = t && t.getAttribute && t.getAttribute('data-tip');
        if (!tip) { this.hideTip(); return; }
        const el = this._ensureTip();
        el.textContent = tip;
        el.style.display = 'block';
        const pad = 14, r = el.getBoundingClientRect();
        let x = evt.clientX + pad, y = evt.clientY + pad;
        if (x + r.width > window.innerWidth) x = evt.clientX - r.width - pad;
        if (y + r.height > window.innerHeight) y = evt.clientY - r.height - pad;
        el.style.left = `${Math.max(4, x)}px`;
        el.style.top = `${Math.max(4, y)}px`;
    },

    hideTip() { if (this._tip) this._tip.style.display = 'none'; },

    _ensureTip() {
        if (!this._tip) {
            const d = document.createElement('div');
            d.id = 'usage-chart-tip';
            d.style.cssText = 'position:fixed; z-index:9999; pointer-events:none; display:none; white-space:pre-line; ' +
                'background:var(--surface,#fff); color:var(--text-primary,#111); border:1px solid var(--border,#e5e7eb); ' +
                'border-radius:6px; padding:6px 9px; font-size:12px; line-height:1.45; box-shadow:0 4px 14px rgba(0,0,0,0.15); max-width:220px;';
            document.body.appendChild(d);
            this._tip = d;
        }
        return this._tip;
    },

    // ── formatting ───────────────────────────────────────────

    _money(n) {
        n = Number(n) || 0;
        if (n === 0) return '$0.00';
        if (n < 0.01) return '$' + n.toFixed(4);
        return '$' + n.toFixed(2);
    },
    _axis(n) {
        n = Number(n) || 0;
        if (n === 0) return '$0';
        if (n < 0.01) return '$' + n.toFixed(3);
        if (n < 1) return '$' + n.toFixed(2);
        return '$' + n.toFixed(n < 10 ? 1 : 0);
    },
    _dayNum(dateStr) {
        const n = Number(String(dateStr).slice(8, 10));
        return isFinite(n) && n > 0 ? n : null;
    },
    _monthShort(dateStr) {
        try {
            const [y, m] = String(dateStr).split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
        } catch { return null; }
    },
    _dayLabel(dateStr) {
        try {
            const [y, m, d] = dateStr.split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
        } catch { return dateStr; }
    },
    _monthLabel(ym) {
        try {
            const [y, m] = ym.split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });
        } catch { return ym; }
    },
    _esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};

window.UsageChart = UsageChart;
