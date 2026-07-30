/* ============================================================
   Form Field Helpers
   ============================================================ */

const FormFields = {
    select(label, value, options, onChange) {
        const optionsHtml = options.map(o =>
            `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`
        ).join('');

        return `
            <div class="form-group">
                <label class="form-label">${label}</label>
                <select class="form-select" ${onChange ? `onchange="${onChange}"` : ''}>
                    ${optionsHtml}
                </select>
            </div>
        `;
    },

    input(label, value, placeholder, onChange) {
        return `
            <div class="form-group">
                <label class="form-label">${label}</label>
                <input class="form-input" type="text" value="${value || ''}"
                    placeholder="${placeholder || ''}"
                    ${onChange ? `onchange="${onChange}"` : ''}>
            </div>
        `;
    },

    toggle(label, checked) {
        return `
            <div class="setting-row">
                <span class="setting-row-label">${label}</span>
                <label class="toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    },

    settingValue(label, value) {
        return `
            <div class="setting-row">
                <span class="setting-row-label">${label}</span>
                <span class="setting-row-value">${value}</span>
            </div>
        `;
    },
};
