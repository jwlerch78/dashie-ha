/* ============================================================
   Card Component Helpers
   ============================================================ */

const Card = {
    stat(label, value, detail) {
        return `
            <div class="stat-card">
                <div class="stat-card-label">${label}</div>
                <div class="stat-card-value">${value}</div>
                ${detail ? `<div class="stat-card-detail">${detail}</div>` : ''}
            </div>
        `;
    },

    device(device) {
        const statusClass = device.online ? 'online' : 'offline';
        const statusText = device.online ? `Online · ${device.lastCheckIn}` : `Offline · ${device.lastCheckIn}`;

        return `
            <div class="card card-clickable" onclick="DevicesPage.showDetail('${device.id}')">
                <div class="card-body device-card">
                    <div class="device-card-header">
                        <div class="device-card-icon">${device.icon}</div>
                        <div class="device-card-info">
                            <div class="device-card-name">${device.name}</div>
                            <div class="device-card-type">${device.type}</div>
                            <div class="device-card-status">
                                <span class="status-dot ${statusClass}"></span>
                                ${statusText}
                            </div>
                        </div>
                    </div>
                    <div class="device-card-details">
                        <span class="device-card-detail">Layout: ${device.settings.layout}</span>
                        <span class="device-card-detail">Theme: ${device.settings.theme}</span>
                        <span class="device-card-detail">Sleep: ${device.settings.sleepTime}</span>
                    </div>
                </div>
            </div>
        `;
    },
};
