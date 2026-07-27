/* ============================================================
   Locations Page
   ============================================================ */

const LocationsPage = {
    render() {
        const settings = MockData.locationsSettings;
        const locations = MockData.savedLocations;

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
    topBarSubtitle() { return `${MockData.savedLocations.length} saved locations`; },
    topBarActions() { return `<button class="btn btn-primary">+ Add Location</button>`; },
};
