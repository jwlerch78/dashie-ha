/* ============================================================
   FreeformPrompt — the text side of AI Prompt & Tools.

   Pure string assembly, no DOM and no I/O, so the gate can drive the same
   functions the page renders through.

   ── THE ORDER IS HOME ASSISTANT'S, DELIBERATELY ─────────────────────────────
   Copied from HA core 2026.9.3, components/conversation/chat_log.py
   (async_provide_llm_data):

       prompt_parts = [ render(user_prompt or DEFAULT_INSTRUCTIONS_PROMPT),
                        llm_api.api_prompt,
                        DATE_TIME_PROMPT   # only when no GetDateTime tool,
                        extra_system_prompt ]

   The user's text is FIRST and nothing structural follows it. Tool schemas
   appear nowhere in the prompt — they go to the model as function
   declarations — which is why nothing a user writes can break them.

   ── WHY THE DEFAULT BOX IS NOT EMPTY ────────────────────────────────────────
   HA's own default is three lines (helpers/llm.py DEFAULT_INSTRUCTIONS_PROMPT),
   not a blank box, and for a good reason: an empty textarea teaches nobody that
   Jinja works here. Ours mirrors theirs and adds one templated line.
   ============================================================ */

const FreeformPrompt = {

    /** Mirrors HA's DEFAULT_INSTRUCTIONS_PROMPT, with our one Jinja example. */
    DEFAULT_TEMPLATE:
        'You are the voice assistant for {{ ha_name }}.\n' +
        'Answer questions about the world truthfully.\n' +
        'Respond simply and to the point in plain text.\n',

    /**
     * The starting text when someone switches Dynamic → Freeform.
     *
     * House rules come WITH them (John, 2026-10-04). They are the same thing in
     * both modes — a few standing lines the household wants obeyed — so dropping
     * them at the switch would quietly discard work the user had already done,
     * and would hand them a near-empty box when they have already said what they
     * want. Carried, not copied: editing the box afterwards does not write back.
     */
    seed(houseRules) {
        const rules = String(houseRules || '').trim();
        return rules ? `${this.DEFAULT_TEMPLATE}\n${rules}\n` : this.DEFAULT_TEMPLATE;
    },

    /** Has the user actually written something, or is this still the seed? */
    isUntouched(prompt, houseRules) {
        return String(prompt || '').trim() === this.seed(houseRules).trim();
    },

    /**
     * The Raw view: everything that will be sent, in send order.
     *
     * `rendered` is HA's answer for the user's template — we never render Jinja
     * ourselves, so what is shown here is what HA produced, including its
     * whitespace. When the template has not been rendered yet the caller passes
     * the raw text and `pending: true`, and the view says so rather than
     * presenting un-substituted braces as if they were the final prompt.
     */
    raw({ rendered, personalityText, toolsStored, dateLine, pending }) {
        const C = window.PromptToolCatalog;
        const parts = [];
        parts.push(String(rendered || '').trimEnd());
        if (personalityText) parts.push(String(personalityText).trim());

        // One behavior line per capability that needs the model to KNOW it has it.
        // Modelled on HA's DYNAMIC_CONTEXT_PROMPT, whose whole job is to stop the
        // model claiming it cannot read live state. It is guidance, never a format
        // rule — the format lives in the function declarations.
        const ids = C ? C.parse(toolsStored).map((t) => (typeof t === 'string' ? t : t.id)) : [];
        if (ids.includes('live_context')) {
            parts.push('You can read the current state of this home with dashie__GetLiveContext.\n'
                + 'Do not say you lack that ability.');
        }

        // HA appends date/time ONLY when no clock tool is present, so a fact is
        // either a tool or a prompt line and never both.
        if (dateLine) parts.push(dateLine);

        const sigs = C ? C.signatures(toolsStored) : '';
        if (sigs) parts.push(`TOOLS\n${sigs}`);

        const body = parts.filter(Boolean).join('\n\n');
        return pending ? `[not rendered yet — press Render]\n\n${body}` : body;
    },

    /** The date line HA would append, in HA's own wording. */
    dateLine(now = new Date()) {
        const t = now.toTimeString().slice(0, 8);
        const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return `Current time is ${t}. Today's date is ${d}.`;
    },
};

window.FreeformPrompt = FreeformPrompt;
