/* ============================================================
   Voice turn timeline — "On the tablet" block in Voice & AI History
   ------------------------------------------------------------
   Renders the device's own view of one voice turn (get_intelligence_log → interaction.device[]),
   so a slow turn can be diagnosed from the console instead of adb logcat:

       ON THE TABLET                                  waited 5.9s
         Wake word            0.0s
         Listening            0.6s
         You started talking  1.1s
         You stopped          3.4s
         Words ready          3.9s
         Sent to Dashie       3.9s
         Dashie speaking      9.3s

   `marks` are ms after the turn's anchor (wake word, or the mic re-opening on a dialog follow-up),
   written by the Android app (VoiceTurnMarks.kt, migration 202610052030). Older apps send no marks;
   for those the block falls back to the separate stage spans they do measure. Unknown marks are
   shown under their raw name, so a new device mark appears here without a console change.
   ============================================================ */

const VoiceTurnTimeline = {
    // Display order + labels. Anything not listed is appended in time order under its raw key.
    LABELS: {
        anchor: 'Wake word',
        stt_open: 'Listening',
        speech_start: 'You started talking',
        first_interim: 'First words heard',
        speech_end: 'You stopped',
        endpoint: 'Done listening',
        transcript: 'Words ready',
        shown: 'Words on screen',
        brain_sent: 'Sent to Dashie',
        first_audio: 'Dashie speaking',
    },

    render(device, fmtMs, escape) {
        if (!Array.isArray(device) || !device.length) return '';
        const blocks = device.map((d, i) => this._renderOne(d, device.length > 1 ? i + 1 : null, fmtMs, escape)).join('');
        return `<div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border, #e5e7eb);">${blocks}</div>`;
    },

    _renderOne(d, turnNo, fmtMs, escape) {
        const title = turnNo ? `On the tablet · turn ${turnNo}` : 'On the tablet';
        const waited = typeof d.wait_ms === 'number'
            ? `<span title="From when you stopped talking to Dashie's first sound">waited ${fmtMs(d.wait_ms)}</span>` : '';
        const head = `
            <div style="display: flex; justify-content: space-between; color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">
                <span>${escape(title)}</span>${waited}
            </div>`;
        const rows = d.marks ? this._markRows(d.marks, fmtMs, escape) : this._spanRows(d, fmtMs);
        if (!rows) return '';
        return `${head}<table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 6px;"><tbody>${rows}</tbody></table>`;
    },

    _markRows(marks, fmtMs, escape) {
        const anchorLabel = marks.anchor === 'rearm' ? 'Listening again' : this.LABELS.anchor;
        const points = [{ label: anchorLabel, ms: 0 }];
        for (const [k, v] of Object.entries(marks)) {
            if (k === 'anchor' || k === 'anchor_epoch_ms' || typeof v !== 'number') continue;
            points.push({ label: this.LABELS[k] || k, ms: v });
        }
        points.sort((a, b) => a.ms - b.ms);
        return points.map((p, i) => {
            const gap = i > 0 ? `<span style="color: var(--text-muted);">+${fmtMs(p.ms - points[i - 1].ms)}</span>` : '';
            return this._row(escape(p.label), gap, `${(p.ms / 1000).toFixed(1)}s`);
        }).join('');
    },

    /** Older apps: no timeline, only stage spans each measured from its own start. */
    _spanRows(d, fmtMs) {
        const out = [];
        if (typeof d.silence_to_transcript_ms === 'number') out.push(this._row('Silence → words ready', '', fmtMs(d.silence_to_transcript_ms)));
        if (typeof d.brain_client_ms === 'number') {
            const net = typeof d.network_ms === 'number' ? `<span style="color: var(--text-muted);">network ${fmtMs(d.network_ms)}</span>` : '';
            out.push(this._row('Dashie thinking', net, fmtMs(d.brain_client_ms)));
        }
        if (typeof d.tts_ms === 'number') out.push(this._row('Voice → first sound', '', fmtMs(d.tts_ms)));
        return out.join('');
    },

    _row(label, note, value) {
        return `
            <tr>
                <td style="padding: 2px 0;">${label}</td>
                <td style="padding: 2px 8px; font-size: 11px;">${note}</td>
                <td style="padding: 2px 0; text-align: right; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${value}</td>
            </tr>`;
    },
};

window.VoiceTurnTimeline = VoiceTurnTimeline;
