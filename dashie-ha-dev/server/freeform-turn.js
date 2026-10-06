// server/freeform-turn.js — assemble the household's own pass-1 prompt for a turn.
//
// Freeform is ADD-ON ONLY (John, 2026-10-05), and that is a constraint rather than a
// preference: the prompt is a Jinja template rendered by HOME ASSISTANT's own engine,
// and the cloud brain has no HA access. This is the only runtime that can serve it.
//
// 🔴 ONE ASSEMBLY, SHARED WITH THE CONSOLE'S PREVIEW. `freeform-prompt.js` and
// `prompt-tool-catalog.js` here are generated from js/ai/prompts/ in dashieapp_staging
// — the same source that generates the console's browser copies (JS_KOTLIN_CONTRACTS
// row 183, now tier 1). The Raw view is sold to the user as "everything that will be
// sent"; if this re-derived the assembly instead of importing it, that claim would be
// a confident non-answer, and the preview would be the version that looked right.
//
// ⚠️ PASS 1 ONLY. The returned string becomes `options.freeform_prompt`, which the core
// substitutes for the pass-1 prompt and nothing else. Pass 2 keeps our template and our
// envelope, which is what still produces cards (John: "We do need to support cards").
const { renderTemplate } = require('./ha-client');
const FreeformPrompt = require('./freeform-prompt');
const catalog = require('./prompt-tool-catalog');

/**
 * @returns {Promise<{prompt: string, toolsStored: string|undefined}|null>}
 *   null → not in Freeform mode, or we could not build it. The caller then sends no
 *   override and the core uses our own prompt.
 */
async function buildFreeformPrompt(acct) {
    if (!acct || acct.promptMode !== 'freeform') return null;

    const template = String(acct.freeformPrompt || '').trim();
    if (!template) {
        // Mode says freeform, box is empty. The console seeds the box on the mode
        // switch, so this means the seed never saved — a real failure, and silently
        // using our prompt would look exactly like Freeform working.
        console.warn('DROP: freeform mode with an EMPTY prompt — falling back to the '
            + 'Dashie prompt. The console seeds the box on switch, so this means that save '
            + 'did not land.');
        return null;
    }

    let rendered;
    try {
        const res = await renderTemplate(template);
        if (!res || res.ok !== true) {
            // 🔴 LOUD, because this is the failure a user cannot see. Their template has
            // a Jinja error; we fall back so the assistant keeps answering, but if that
            // fallback were quiet they would believe their prompt is live. The console's
            // Render button shows them the same message.
            console.warn('DROP: freeform template failed to render in Home Assistant — '
                + `falling back to the Dashie prompt. HA said: ${res && res.error}`);
            return null;
        }
        rendered = res.rendered;
    } catch (e) {
        console.warn('DROP: freeform template could not be rendered (HA unreachable) — '
            + `falling back to the Dashie prompt: ${(e && e.message) || e}`);
        return null;
    }

    // ⚠️ PERSONALITY IS NOT INJECTED, AND THAT IS THE STATUS QUO RATHER THAN A FREEFORM
    // REGRESSION. `addon-io.js:250` is `resolvePersonality: async () => null`, stubbed in
    // BOTH postures because personality.ts makes ~10 PostgREST queries — so NO prompt on
    // this runtime has ever carried a persona, dynamic mode included. Stated here because
    // the console's Freeform editor DOES show a personality control, so that control
    // currently promises something this runtime cannot deliver. Logged once per turn only
    // when the account actually asked for one, so the gap is countable rather than
    // theoretical.
    if (acct.personalityMode && acct.personalityMode !== 'off') {
        console.warn(`DROP: freeform prompt carries NO personality (mode=${acct.personalityMode}) `
            + '— resolvePersonality is stubbed null on this runtime (addon-io.js:250), so the '
            + "console's personality control cannot take effect here yet");
    }

    const toolsStored = acct.toolsEnabled;   // undefined = never set → catalog defaults
    // HA's own rule: date/time is appended only when no clock tool is offered, so a fact
    // is a tool or a prompt line and never both.
    const hasClock = catalog.parse(toolsStored).includes('schedule');

    const prompt = FreeformPrompt.raw({
        rendered,
        toolsStored,
        dateLine: hasClock ? '' : FreeformPrompt.dateLine(),
        catalog,
    });
    return { prompt, toolsStored };
}

module.exports = { buildFreeformPrompt };
