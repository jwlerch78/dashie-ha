/* ============================================================
   PromptToolCatalog — the one holder of the tools a prompt may offer.

   Read by three surfaces that MUST agree, which is the whole reason it is a
   holder and not three lists:
     • the AI Prompt & Tools section's compact "tools enabled" line
     • the Freeform editor's sidebar of on/off rows
     • the Raw view, which prints the function signatures the model will receive

   The `fn` names are the HA-style namespaced names. Home Assistant will REQUIRE
   the `<domain>__` prefix from 2027.3 (homeassistant/components/llm/__init__.py:31,
   TOOL_PREFIX_BREAKS_IN_HA_VERSION), so they carry it from the first commit rather
   than being renamed once people's prompts refer to them.

   ⚠️ Corrected 2026-10-04 against HA core 2026.9.3: an earlier version of this
   comment said HA "logs an error for custom integrations". It is the other way
   round — `_async_report_unprefixed_tools` picks
   `WARNING if integration and not integration.is_built_in else ERROR`, so a
   CUSTOM integration like ours gets a WARNING and a built-in gets the ERROR. The
   conclusion is unchanged (carry the prefix), but the loudness we would actually
   see is lower than stated, which matters if anyone plans to find this by
   grepping the log for an error.

   `id` is what persists (comma-joined in ai.toolsEnabled). It is deliberately
   NOT the fn name: renaming a function must not silently switch a tool off for
   everyone who had it on.
   ============================================================ */

const PromptToolCatalog = {

    /** Ordered as the sidebar renders them: the ones an HA household reaches for
     *  first at the top. `on` is the default for an account that has never set
     *  this, chosen to match what the dynamic prompt already offers today. */
    TOOLS: [
        { id: 'home_assistant', label: 'Home Assistant',      fn: 'dashie__ControlHome',         args: 'command_hint',                    on: true },
        { id: 'live_context',   label: 'Live entity state',   fn: 'dashie__GetLiveContext',      args: 'name?, domain?, area?',           on: true },
        { id: 'calendar',       label: 'Family calendar',     fn: 'dashie__GetCalendarEvents',   args: 'time_range, member?',             on: true },
        { id: 'calendar_write', label: 'Add & change events', fn: 'dashie__WriteCalendarEvent',  args: 'action, title?, date?, time?',    on: false },
        { id: 'weather',        label: 'Weather',             fn: 'dashie__GetWeather',          args: 'timeframe, location?',            on: true },
        { id: 'chores',         label: 'Chores & rewards',    fn: 'dashie__GetChores',           args: 'hint?, member_hint?',             on: true },
        { id: 'locations',      label: 'Where is everyone',   fn: 'dashie__GetFamilyLocations',  args: 'member_name?',                    on: false },
        { id: 'music',          label: 'Music',               fn: 'dashie__ControlMusic',        args: 'action, query?, speaker?',        on: true },
        { id: 'video_feeds',    label: 'Camera feeds',        fn: 'dashie__ShowVideoFeed',       args: 'action, camera?, time?',          on: false },
        { id: 'sports',         label: 'Sports scores',       fn: 'dashie__GetSports',           args: 'sport, league, team, type',       on: false },
        { id: 'schedule',       label: 'Timers & reminders',  fn: 'dashie__ScheduleAction',      args: 'time|delay_minutes, kind, label',  on: false },
        { id: 'web_search',     label: 'Web search',          fn: 'dashie__SearchWeb',           args: 'query',                           on: false },
        // The response envelope. It is a tool because that is the only way to get
        // a schema the API enforces: function calling, structured output and
        // Google grounding are mutually exclusive in one Gemini call (measured
        // 2026-10-03), so the envelope cannot ride on responseSchema alongside
        // the tools above. Off = the model answers in prose and we speak it,
        // which is exactly how HA's own agents behave.
        { id: 'answer',         label: 'Answer on screen',    fn: 'dashie__Answer',              args: 'voice, text?, display_events?',   on: true },
    ],

    byId(id) { return this.TOOLS.find((t) => t.id === id) || null; },

    /** The default enabled set, as the stored comma-joined string. */
    defaultEnabled() {
        return this.TOOLS.filter((t) => t.on).map((t) => t.id).join(',');
    },

    /**
     * Parse the stored value into an id array.
     *
     * ⚠️ `undefined` and `''` are DIFFERENT and must stay different: undefined is
     * "never set, use the defaults", `''` is "the user turned everything off".
     * Collapsing them silently turns every tool back on for someone who
     * deliberately cleared the list.
     */
    parse(stored) {
        if (stored === undefined || stored === null) return this.parse(this.defaultEnabled());
        return String(stored).split(',').map((s) => s.trim())
            .filter((id) => !!this.byId(id));
    },

    /** Stored string with `id` switched on or off. Order follows TOOLS, never
     *  click order, so the stored value is stable and diffable. */
    toggled(stored, id, on) {
        const have = new Set(this.parse(stored));
        if (on) have.add(id); else have.delete(id);
        return this.TOOLS.filter((t) => have.has(t.id)).map((t) => t.id).join(',');
    },

    enabled(stored) { return this.parse(stored).map((id) => this.byId(id)); },

    /** "Home Assistant · Family calendar · Weather" for the collapsed section. */
    summary(stored) {
        return this.enabled(stored).map((t) => t.label).join(' · ');
    },

    /** The TOOLS block of the Raw view — what the model is actually handed,
     *  aligned so a signature is readable at a glance. */
    signatures(stored) {
        const on = this.enabled(stored);
        if (!on.length) return '';
        const sigs = on.map((t) => ({ sig: `${t.fn}(${t.args})`, label: t.label }));
        const w = Math.max(...sigs.map((s) => s.sig.length));
        return sigs.map((s) => `${s.sig.padEnd(w + 4)}${s.label}`).join('\n');
    },
};

window.PromptToolCatalog = PromptToolCatalog;
