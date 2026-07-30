/* ============================================================
   Data Table / List Helpers
   ============================================================ */

const DataTable = {
    /** Render a list of items with icon, title, subtitle, and optional badge */
    list(items) {
        if (!items.length) {
            return `<div class="list-container"><div class="empty-state"><div class="empty-state-text">No items</div></div></div>`;
        }
        return `
            <div class="list-container">
                ${items.map(item => this._listItem(item)).join('')}
            </div>
        `;
    },

    _listItem(item) {
        const iconStyle = item.color ? `background: ${item.color}` : 'background: var(--text-muted)';
        const clickAttr = item.onClick ? `onclick="${item.onClick}"` : '';
        return `
            <div class="list-item" ${clickAttr}>
                ${item.icon ? `<div class="list-item-icon" style="${iconStyle}">${item.iconText || ''}</div>` : ''}
                <div class="list-item-content">
                    <div class="list-item-title">${item.title}</div>
                    ${item.subtitle ? `<div class="list-item-subtitle">${item.subtitle}</div>` : ''}
                </div>
                ${item.badge ? `<span class="list-item-badge">${item.badge}</span>` : ''}
                ${item.count ? `<span class="list-item-count">${item.count}</span>` : ''}
            </div>
        `;
    },

    /** Render checkbox list items */
    checkboxList(items) {
        return `
            <div class="list-container">
                ${items.map(item => `
                    <div class="checkbox-row ${item.checked ? 'checked' : ''}">
                        <div class="checkbox-icon"></div>
                        ${item.color ? `<span class="color-dot" style="background: ${item.color}"></span>` : ''}
                        <span class="checkbox-label">${item.label}</span>
                        ${item.detail ? `<span class="list-item-badge">${item.detail}</span>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    },
};
