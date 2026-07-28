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
};
