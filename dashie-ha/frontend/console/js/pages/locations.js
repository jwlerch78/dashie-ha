/* ============================================================
   Locations Page
   ============================================================ */

const LocationsPage = {
    // Demo data — this alpha-gated page isn't wired to Supabase yet.
    // (Moved from the old MockData blocks when mock-data.js slimmed to
    // the identity store, 2026-07.)
    _settings: {
        trackingEnabled: true,
        travelTimes: true,
        trafficModel: 'Best Guess',
        earlyArrival: 5,
    },
    _locations: [
        { id: '1', name: 'Home', icon: '🏠', address: '123 Main St, Anytown' },
        { id: '2', name: 'School', icon: '🏫', address: '456 Oak Ave, Anytown' },
        { id: '3', name: 'Work', icon: '💼', address: '789 Business Blvd' },
    ],

    render() {
        const settings = this._settings;
        const locations = this._locations;

        const locationItems = locations.map(l => ({
            title: `${l.icon}  ${l.name}`,
            subtitle: l.address,
        }));

        return `
            <div class="section-header" style="margin-top: 0;">Settings</div>
            <div class="card">
                ${FormFields.toggle('Location Tracking', settings.trackingEnabled)}
                ${FormFields.toggle('Calculate Travel Times', settings.travelTimes)}
                ${FormFields.settingValue('Traffic Model', settings.trafficModel)}
                ${FormFields.settingValue('Early Arrival (minutes)', settings.earlyArrival)}
            </div>

            <div class="section-header">Saved Locations</div>
            ${DataTable.list(locationItems)}

            <p class="page-summary">${locations.length} saved locations</p>
        `;
    },

    topBarTitle() { return 'Locations'; },
    topBarSubtitle() { return `${this._locations.length} saved locations`; },
    topBarActions() { return `<button class="btn btn-primary">+ Add Location</button>`; },
};
