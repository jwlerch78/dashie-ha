/**
 * DevicesBluetoothModal — the device list behind the Bluetooth chip.
 *
 * John, 2026-10-07: *"Would it be possible to have the bluetooth devices that
 * are connected be shown when the user clicks the bluetooth icon?"*
 *
 * No new network call. `METRIC_MAP['bluetooth_devices']` already carries the
 * sensor's whole `devices` attribute through to the card, and the chip was
 * ignoring it. Shape comes from the integration's own `extra_state_attributes`
 * (`ble_entities.py`): `{name, address, via, rssi}` per entry.
 *
 * ── WHY THE LIST IS GROUPED, AND WHY THAT IS NOT COSMETIC ───────────────────
 *
 * 🔴 THE LIST HOLDS MORE THAN THE CHIP COUNTS. `via` is HA's view, not the
 * tablet's: `"this"` means HA is using THIS tablet as the receiver for that
 * device, and those are the ones the chip counts. A `"other"` entry is a device
 * this tablet hears while HA prefers a different receiver for it. So on a
 * multi-tablet household the chip reads 3 and the raw attribute has 5 entries.
 *
 * Rendering that flat makes the chip look wrong, which is the exact disagreement
 * the "state IS the count" rule exists to prevent — the chip would be right and
 * the list would be contradicting it. Two groups instead, so both are true at
 * once. In a single-tablet household (the commonest deployment) the second group
 * is simply empty and the UI collapses to one list.
 *
 * ── THE COUNT IN THE HEADING IS THE STATE, NOT THE LIST LENGTH ──────────────
 *
 * 🔴 `_heading()` prints `bt.count` — the sensor state — and never
 * `viaThis.length`. `ble_entities.py`'s docstring forbids the second derivation
 * ("a second source of truth, and the two would disagree the moment one of them
 * was changed"), and this module is downstream of exactly that rule. If the two
 * ever disagree the heading reports the sensor and the rows show what arrived,
 * which surfaces the inconsistency instead of papering over it.
 */
const DevicesBluetoothModal = {

    _open: false,
    _deviceId: null,

    open(deviceId) {
        this._open = true;
        this._deviceId = deviceId;
        App.renderPage();
    },

    close() {
        this._open = false;
        this._deviceId = null;
        App.renderPage();
    },

    /**
     * rssi → a word plus the raw dBm.
     *
     * The word is for reading at a glance; the number stays because dBm is what
     * anyone debugging a range problem actually wants, and because a bucket
     * label alone would make two very different devices look identical.
     * Thresholds match the conventional BLE reading (-60 / -75).
     */
    _signal(rssi) {
        if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return '';
        const word = rssi >= -60 ? 'Strong' : rssi >= -75 ? 'OK' : 'Weak';
        return `${word} · ${rssi} dBm`;
    },

    /**
     * One row. `name` may legitimately be an EMPTY STRING — plenty of BLE
     * peripherals advertise no name — so it falls back to the address rather
     * than rendering a blank line. `||` and not `??` on purpose: '' must fall
     * through, and `??` would keep it.
     */
    _row(d) {
        const esc = (s) => DevicesPage._escape(s);
        const addr = String(d?.address || '');
        const label = String(d?.name || '') || addr || 'Unknown device';
        const sig = this._signal(d?.rssi);
        // The address is shown as a second line only when it is not already the
        // label, so an unnamed device does not print its MAC twice.
        const sub = [label !== addr ? addr : '', sig].filter(Boolean).join(' · ');
        return `
            <div style="display: flex; align-items: baseline; justify-content: space-between;
                        gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border, #e5e7eb);">
                <span style="min-width: 0; font-size: var(--font-size-sm); color: var(--text-primary);
                             overflow-wrap: anywhere;">${esc(label)}</span>
                <span style="flex: none; font-size: var(--font-size-sm); color: var(--text-muted);
                             font-variant-numeric: tabular-nums;">${esc(sub)}</span>
            </div>`;
    },

    _heading(text, n) {
        return `<div style="font-size: var(--font-size-sm); font-weight: 700; color: var(--text-primary);
                            margin: 14px 0 2px;">${DevicesPage._escape(text)}${n == null ? '' : ` (${n})`}</div>`;
    },

    render() {
        if (!this._open) return '';
        const device = DevicesPage._findDevice(this._deviceId);
        if (!device) return '';
        const bt = DeviceControlState.metricsFor(device)?.bluetooth || null;

        let body;
        if (!bt) {
            // Reached only if the sensor disappeared between the click and the
            // re-render; the chip is not drawn at all without `bluetooth`.
            body = `<div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                        No Bluetooth sensor for this device.</div>`;
        } else if (bt.count == null) {
            // ⚠️ NAMES NO CAUSE, matching the chip. The greyed state covers eight
            // Android-local conditions HA never learns about (permission refused,
            // adapter off, location off, service not running, …) — naming one
            // sends the user after the wrong fault. check-bluetooth-surface
            // leg 14 holds the same line for the chip.
            body = `<div style="font-size: var(--font-size-sm); color: var(--text-muted);">
                        The Bluetooth bridge is unavailable, so this tablet is not
                        reporting any devices right now.</div>`;
        } else {
            const all = Array.isArray(bt.devices) ? bt.devices : [];
            const viaThis = all.filter((d) => d?.via === 'this');
            const viaOther = all.filter((d) => d?.via !== 'this');
            const parts = [];
            // 🔴 bt.count, never viaThis.length — see the module comment.
            parts.push(this._heading('Connected via this tablet', bt.count));
            parts.push(viaThis.length
                ? viaThis.map((d) => this._row(d)).join('')
                : `<div style="font-size: var(--font-size-sm); color: var(--text-muted); padding: 6px 0;">
                       Scanning — nothing claimed yet. This is the normal state during setup.</div>`);
            if (viaOther.length) {
                parts.push(this._heading('Also in range', viaOther.length));
                parts.push(`<div style="font-size: var(--font-size-sm); color: var(--text-muted);
                                        margin-bottom: 2px;">
                                Heard by this tablet, but Home Assistant is using a different
                                receiver for them — so they are not in the count above.</div>`);
                parts.push(viaOther.map((d) => this._row(d)).join(''));
            }
            body = parts.join('');
        }

        // The chip used to open HA history on click, so keep that one click away
        // rather than removing a route that existed.
        const slug = DevicesPage._haSlugForDevice(device.device_id);
        const entityId = (DevicesPage._haEntityIdsForDevice(device.device_id) || {})['bluetooth_devices']
            || (slug ? `sensor.${slug}_bluetooth_devices` : null);
        const footer = entityId
            ? `<button class="btn btn-secondary" onclick="DevicesCard.openHistory('${entityId}',
                   '${DevicesPage._escape((device.device_name || 'Device') + ' · Bluetooth')}')">
                   View history</button>`
            : '';
        return DevicesDetailModals._modal('Bluetooth devices', body,
            'DevicesBluetoothModal.close()', footer, device);
    },
};
