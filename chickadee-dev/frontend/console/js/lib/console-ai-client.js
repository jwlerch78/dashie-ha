/* ============================================================
   ConsoleAiClient — same pipeline the tablets run, in the Console.
   ------------------------------------------------------------
   Mirrors the webapp's
       _buildPrompt → ai-gateway → ai-response-parser →
       info_request fetch → _buildPrompt(inquiry) → ai-gateway →
       execute_commands → haService.callService()
   flow as closely as possible. Uses the actual webapp prompt
   templates (vendored in ai-prompt-templates.js) and the actual
   personality wrapper (personality-prompt-builder.js).

   Two-pass for HA:
     1. Initial prompt = base-context + response-format-initial + personality.
     2. AI replies — usually info_request { tool: 'home_assistant',
        query: { command_hint } } for any smart-home command.
     3. We fetch the user's controllable HA entities via the add-on
        (/api/ha/entities), exactly the shape the webapp builds via
        haService.discoverEntities() + the controllableDomains filter.
     4. Second prompt = inquiries/home-assistant.md filled with the
        entity list + personality. AI returns `execute_commands`.
     5. We dispatch each command via the add-on (/api/ha/service),
        same shape haService.callService(domain, service, data) sends.

   Public API:
     await ConsoleAiClient.sendQuery(text, {
        personalityId, modelId, history,
        onStage(stageName, detail)   // optional progress callback
     }) → turn object (see end of file for shape)
   ============================================================ */

const ConsoleAiClient = {
    _personalityCache: new Map(),
    _entityCache: null,
    _entityCacheAt: 0,
    _ENTITY_CACHE_MS: 60_000,

    /** Look up the provider for a model from the bundled catalog. The catalog
     *  is the source of truth used by web + Android + here; prefix-sniffing
     *  the id breaks on shapes like 'us.amazon.nova-2-lite-v1:0' (was falling
     *  through to 'claude' default, which is why a Nova selection got routed
     *  to Anthropic and 400'd on the Claude API). Falls back to prefix-sniff
     *  only if the catalog isn't loaded yet. */
    _providerForModel(modelId) {
        if (!modelId || typeof modelId !== 'string') return 'claude';
        const row = window.AiModelCatalog?.AI_MODEL_CATALOG?.find(m => m.id === modelId);
        if (row?.provider) return row.provider;
        const id = modelId.toLowerCase();
        if (id.startsWith('claude-')) return 'claude';
        if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3')) return 'openai';
        if (id.startsWith('gemini-')) return 'gemini';
        if (id.startsWith('us.amazon.') || id.startsWith('bedrock-') || id.includes('nova')) return 'bedrock';
        return 'claude';
    },

    /** Per-provider max_tokens — matches webapp ai-context.js AI_CONFIG.
     *  Gemini gets a much larger budget because search-result synthesis
     *  often blows past 1500 tokens; truncation mid-JSON makes the parser
     *  fail and the chat ends up rendering literal half-finished JSON. */
    _maxTokensForProvider(provider) {
        switch (provider) {
            case 'claude':  return 1500;
            case 'openai':  return 1500;
            case 'gemini':  return 50000;
            case 'bedrock': return 5000;
            default:        return 2048;
        }
    },

    /** Resolve a personality row by id-or-key. Source order:
     *    1. VoiceAiPage._templates (built-ins keyed by `key`). These rows
     *       are already loaded into memory when the page renders the picker
     *       and have all the structured fields (overview/persona/adjectives/
     *       topics/example_phrases) we need. The previous server-fetch path
     *       hit handlers that returned null for template keys, leaving the
     *       personality undefined and the AI defaulting to the generic
     *       "I'm a family assistant" persona regardless of pick.
     *    2. VoiceAiPage._custom (custom rows keyed by UUID).
     *    3. Falls back to the dbRequest path (kept for the case where the
     *       chat is opened before VoiceAiPage has fetched its lists).
     *    For templates, family_notes from _overrides[key] is merged in via
     *    mergePersonalityWithOverride — same pattern the webapp uses. */
    async _getPersonality(personalityId) {
        if (!personalityId) return null;
        if (this._personalityCache.has(personalityId)) {
            return this._personalityCache.get(personalityId);
        }

        let VAP = (typeof VoiceAiPage !== 'undefined') ? VoiceAiPage : null;

        // Lazy-load the personality lists if Voice & AI Settings was never
        // opened in this session — that's the path that normally populates
        // VAP._templates / _custom / _overrides. Otherwise we fall through
        // to the server with the slug ("pirate") which the server treats
        // as a UUID and 500s.
        if (VAP && !VAP._templates && typeof VoiceAiApi !== 'undefined') {
            try {
                const [templates, custom, overrides] = await Promise.all([
                    VoiceAiApi.listTemplates().catch(() => []),
                    VoiceAiApi.listCustom().catch(() => []),
                    VoiceAiApi.listOverrides().catch(() => []),
                ]);
                VAP._templates = templates;
                VAP._custom = custom;
                VAP._overrides = {};
                for (const o of overrides) VAP._overrides[o.template_key] = o;
            } catch { /* leave VAP._templates null — fall through to server */ }
        }

        let row = null;

        // 1. Built-in template by key.
        if (VAP?._templates) {
            const tpl = VAP._templates.find(t => (t.key || t.id) === personalityId);
            if (tpl) {
                const override = VAP._overrides?.[tpl.key];
                row = (override && window.PersonalityPromptBuilder?.mergePersonalityWithOverride)
                    ? window.PersonalityPromptBuilder.mergePersonalityWithOverride(tpl, override)
                    : tpl;
            }
        }

        // 2. Custom row by id.
        if (!row && VAP?._custom) {
            row = VAP._custom.find(c => c.id === personalityId) || null;
        }

        // 3. Server fallback — by id only (UUIDs). Skip when the id looks
        // like a slug (built-in key) so we don't fire a known-bad request
        // that the server logs as a 500.
        if (!row && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(personalityId)) {
            try {
                const result = await DashieAuth.dbRequest('get_personality', { id: personalityId });
                row = result?.data || result?.personality || null;
            } catch { /* leave null */ }
        }

        this._personalityCache.set(personalityId, row);
        return row;
    },

    /** Drop cached personalities — called when the user edits a personality
     *  in the Voice & AI page so the next chat turn picks up the change. */
    invalidatePersonalityCache() {
        this._personalityCache.clear();
    },

    /** Per-token cost estimation. Pricing sourced from
     *  window.AiModelCatalog.pricingFor(modelId), which the bundler emits
     *  from config.js's TOKEN_COSTS. Single source of truth across web,
     *  Android picker, and this test harness. */
    estimateCost(modelId, inputTokens, outputTokens) {
        const rates = window.AiModelCatalog?.pricingFor?.(modelId);
        if (!rates) return { input: 0, output: 0, total: 0, known: false };
        const input  = (inputTokens  || 0) * rates[0] / 1_000_000;
        const output = (outputTokens || 0) * rates[1] / 1_000_000;
        return { input, output, total: input + output, known: true };
    },

    /** Fetch + cache the controllable HA entity list from the add-on.
     *  Cache TTL matches the webapp's haService entity cache window. */
    async _getControllableEntities() {
        const now = Date.now();
        if (this._entityCache && (now - this._entityCacheAt) < this._ENTITY_CACHE_MS) {
            return this._entityCache;
        }
        const resp = await fetch(DashieAuth._addonUrl('/api/ha/entities'));
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.message || body.error || `HTTP ${resp.status}`);
        }
        const body = await resp.json();
        this._entityCache = body;
        this._entityCacheAt = now;
        return body;
    },

    /** Call the same web-search-gateway edge fn the webapp uses. Returns the
     *  raw provider response (results array + provider name + metadata). */
    async _runWebSearch(query, { provider = 'brave', count = 10 } = {}) {
        const url = `${DashieAuth.config.url}/functions/v1/web-search-gateway`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': DashieAuth.anonKey,
                'Authorization': `Bearer ${DashieAuth.anonKey}`,
            },
            body: JSON.stringify({ provider, query, options: { count } }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
        return body;
    },

    /** Format search results as the AI sees them — mirrors the webapp's
     *  webSearchService.formatResultsForAI() output. */
    /** Build the context object passed to window.PromptBuilder.buildPrompt.
     *  Single chokepoint — adding a new prompt field (language, future)
     *  means one edit here, both Pass 1 and Pass 2 inherit it. */
    async _buildPromptContext({ personality, history }) {
        const language = await this._resolveLanguage();
        return {
            customPersonalityConfig: personality,
            chatHistory: this._formatHistory(history || []),
            language,
        };
    },

    // Language resolution — cached lazily on first sendQuery. The
    // Preferences page calls invalidateLanguageCache() after a save so
    // a change picked there takes effect on the next turn without a
    // page reload.
    _cachedLanguage: null,
    _cachedLanguageAt: 0,
    _LANGUAGE_TTL_MS: 5 * 60 * 1000,

    async _resolveLanguage() {
        const now = performance.now();
        if (this._cachedLanguage !== null && (now - this._cachedLanguageAt) < this._LANGUAGE_TTL_MS) {
            return this._cachedLanguage;
        }
        try {
            // Bare DashieAuth (script-scope const), NOT window.DashieAuth —
            // console-auth.js never attaches the object to window, so the
            // optional-chained window.DashieAuth was always undefined.
            const settings = (typeof DashieAuth !== 'undefined' && DashieAuth.loadUserSettings)
                ? await DashieAuth.loadUserSettings()
                : {};
            this._cachedLanguage = settings.general?.language || 'system';
            console.log('[ConsoleAiClient] resolved language:', this._cachedLanguage,
                'general.language:', settings.general?.language);
        } catch (e) {
            console.warn('[ConsoleAiClient] language resolve failed:', e);
            this._cachedLanguage = 'system';
        }
        this._cachedLanguageAt = now;
        return this._cachedLanguage;
    },

    /** Called by the Preferences page after a successful save so the next
     *  chat turn picks up the change. */
    invalidateLanguageCache() {
        this._cachedLanguage = null;
        this._cachedLanguageAt = 0;
    },

    _formatHistory(history) {
        if (!Array.isArray(history) || history.length === 0) return '';
        const lines = history.slice(-4).map(h => {
            const speaker = h.role === 'user' ? 'User' : 'You';
            return `${speaker}: ${h.content || ''}`;
        });
        return `Recent conversation:\n${lines.join('\n')}\n`;
    },

    _parseContent(content) {
        if (!content || typeof content !== 'string') return null;
        let body = content.trim();
        // Strip ```json ... ``` fences (both inline and newline-separated).
        body = body
            .replace(/^\s*```(?:json|JSON)?\s*\r?\n?/i, '')
            .replace(/\r?\n?\s*```\s*$/i, '')
            .trim();
        const firstBrace = body.indexOf('{');
        if (firstBrace > 0) body = body.slice(firstBrace);

        // Try as-is first.
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { /* fall through */ }

        // Strip trailing commas before } or ]. Common Gemini quirk.
        if (!parsed) {
            const cleaned = body.replace(/,(\s*[}\]])/g, '$1');
            try { parsed = JSON.parse(cleaned); } catch (_) { /* fall through */ }
            if (!parsed) {
                // Truncated response repair: trim to the last balanced brace.
                const repaired = this._repairTruncatedJson(cleaned);
                if (repaired) {
                    try { parsed = JSON.parse(repaired); } catch (_) { /* still null */ }
                }
            }
        }

        return parsed ? this._normalizeParsedShape(parsed) : null;
    },

    /** Lenient normalization for common model misformats:
     *  - `type: 'web_search'` (or any other tool name) instead of the
     *    canonical `type: 'info_request', tool: 'web_search'`. Both
     *    Gemini and OpenAI hit this when conversation history primes
     *    them to think the tool is the response type. Rewrite to
     *    canonical shape so our dispatch code finds it. */
    _normalizeParsedShape(parsed) {
        if (!parsed || typeof parsed !== 'object') return parsed;
        const KNOWN_TOOLS = new Set([
            'web_search', 'calendar_events', 'family_members', 'chores', 'rewards',
            'location_events', 'travel_time', 'family_locations', 'weather_data',
            'home_assistant', 'get_current_time', 'dashie_help', 'music',
            'schedule_action',
        ]);
        if (parsed.type && KNOWN_TOOLS.has(parsed.type) && parsed.type !== 'info_request') {
            return {
                type: 'info_request',
                tool: parsed.type,
                query: parsed.query,
                context: parsed.context,
                processing_message: parsed.processing_message,
            };
        }
        return parsed;
    },

    /** Best-effort recovery of a JSON object whose tail was cut off by
     *  max_tokens. We track brace/bracket depth, ignore characters inside
     *  string literals, and remember the longest prefix that ends inside
     *  a value position with balanced quotes. Then we close every still-
     *  open scope. Not perfect (won't recover an unfinished string field),
     *  but salvages the common case where truncation lands between fields. */
    _repairTruncatedJson(s) {
        if (!s || s[0] !== '{') return null;
        let inString = false;
        let escape = false;
        const stack = [];
        let validEnd = -1;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (escape) { escape = false; continue; }
            if (inString) {
                if (ch === '\\') escape = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{' || ch === '[') stack.push(ch);
            else if (ch === '}' || ch === ']') stack.pop();
            // Mark valid end after a value-terminating char with empty stack
            // — anything past this is mid-field and unparseable.
            if (stack.length > 0 && (ch === ',' || ch === '}' || ch === ']')) validEnd = i;
        }
        if (inString) return null;          // truncated inside a string — give up
        if (stack.length === 0) return s;   // already balanced; outer parse already failed for another reason
        // Trim trailing comma if any (we may have stopped after one).
        let prefix = s;
        if (validEnd !== -1 && validEnd < s.length - 1) prefix = s.slice(0, validEnd + 1);
        prefix = prefix.replace(/,(\s*)$/, '$1');
        // Close all open scopes.
        const closers = stack.map(c => (c === '{' ? '}' : ']')).reverse().join('');
        return prefix + closers;
    },

    /** POST the prompt to ai-gateway and return { ok, raw, latency_ms, error }. */
    async _callGateway({ provider, prompt, modelId, requestType = 'console_chat', sessionId }) {
        const t0 = performance.now();
        try {
            const resp = await fetch(`${DashieAuth.config.url}/functions/v1/ai-gateway`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': DashieAuth.anonKey,
                    'Authorization': `Bearer ${DashieAuth.anonKey}`,
                },
                body: JSON.stringify({
                    provider,
                    prompt,
                    stream: false,
                    options: {
                        model: modelId,
                        max_tokens: this._maxTokensForProvider(provider),
                        temperature: 0.7,
                    },
                }),
            });
            const body = await resp.json().catch(() => ({}));
            const latency_ms = Math.round(performance.now() - t0);
            if (!resp.ok) {
                return { ok: false, error: body.error || body.message || `HTTP ${resp.status}`, latency_ms };
            }
            // Fire-and-forget usage log. Console chat lives outside the
            // webapp's ai-service so it has its own logging path. Same
            // ai_interactions row shape — server-side deduction picks
            // this up automatically. Token-aware; zero-token replies
            // get filtered out of the usage table the same way the
            // webapp's NLP path does.
            const usage = body?.usage || {};
            this._logInteraction({
                requestType,
                sessionId,
                requestLength: prompt.length,
                model: body?.model || modelId,
                provider: body?.provider || provider,
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                totalTokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
                apiLatencyMs: body?.latency || 0,
                totalLatencyMs: latency_ms,
                promptText: prompt,
                responseText: typeof body?.content === 'string' ? body.content : null,
            });
            return { ok: true, raw: body, latency_ms };
        } catch (e) {
            return { ok: false, error: e?.message || String(e), latency_ms: Math.round(performance.now() - t0) };
        }
    },

    /** Account-level "Save conversation details" opt-in
     *  (user_settings.settings.ai.retainTranscripts, default false). Memoized
     *  so we don't round-trip per chat message; privacy-first (suppress text
     *  until we've confirmed it's on). */
    async _retainTranscripts() {
        if (this.__retainCache === undefined) {
            try {
                // Authoritative column, not the clobberable blob. See _TECHNICAL_DEBT.md.
                const r = await DashieAuth.dbRequest('get_retain_transcripts');
                this.__retainCache = r?.retain_transcripts === true;
            } catch { this.__retainCache = false; }
        }
        return this.__retainCache;
    },

    /** Fire-and-forget log_ai_interaction. Mirrors ai-analytics.js
     *  logInteraction but stripped to the fields available here. Transcript
     *  text is gated on the account-level retainTranscripts opt-in; token/cost
     *  rows always log for billing. */
    async _logInteraction(d) {
        // Bare DashieAuth (script-scope const), NOT window.DashieAuth — the
        // optional-chained window.DashieAuth was always undefined, so console
        // chat turns were never logged or billed.
        if (typeof DashieAuth === 'undefined' || !DashieAuth.dbRequest) return;
        const retain = await this._retainTranscripts();
        const logData = {
            session_id: d.sessionId || null,
            request_type: d.requestType || 'console_chat',
            request_length: d.requestLength || 0,
            model: d.model || 'unknown',
            input_tokens: d.inputTokens || 0,
            output_tokens: d.outputTokens || 0,
            total_tokens: d.totalTokens || 0,
            response_type: null,
            response_length: d.responseText ? d.responseText.length : 0,
            tool_used: null,
            action_taken: null,
            api_latency_ms: d.apiLatencyMs || 0,
            total_latency_ms: d.totalLatencyMs || 0,
            success: true,
            error_type: null,
            prompt_text: retain ? (d.promptText || null) : null,
            response_text: retain ? (d.responseText || null) : null,
        };
        DashieAuth.dbRequest('log_ai_interaction', logData)
            .then(() => window.CreditsService?.fetch({ force: true }))
            .catch(() => {});
    },

    /** Fire an HA service call via the add-on. */
    async _callHaService(domain, service, data) {
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/ha/service'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain, service, data: data || {} }),
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok || body.success === false) {
                return { ok: false, error: body.error || body.message || `HTTP ${resp.status}` };
            }
            return { ok: true, result: body.result };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    },

    async _dispatchExecuteCommands(commands) {
        const results = [];
        for (const c of commands) {
            const r = await this._callHaService(c.domain, c.service, c.data);
            results.push({
                domain: c.domain, service: c.service, data: c.data || {},
                ok: r.ok, error: r.error || null,
            });
        }
        return results;
    },

    /** forward_to_assist — POST text to HA Assist via the add-on. */
    async _dispatchForwardToAssist(transcript) {
        try {
            const resp = await fetch(DashieAuth._addonUrl('/api/ha/conversation'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: transcript || '' }),
            });
            const body = await resp.json().catch(() => ({}));
            return {
                ok: resp.ok && body.success !== false,
                response: body.response || body,
                error: !resp.ok ? (body.message || body.error || `HTTP ${resp.status}`) : null,
            };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    },

    /** Console is dev-only and migrating to the consolidated voice-conversation
     *  "brain", so the brain is the DEFAULT here. Opt out (legacy local orchestration,
     *  kept for comparison) with ?brain=0 or localStorage['dashie-use-brain']='0'. */
    get _useBrain() {
        try {
            const qs = new URLSearchParams(location.search);
            if (qs.get('brain') === '0' || localStorage.getItem('dashie-use-brain') === '0') return false;
            return true;
        } catch (_) { return true; }
    },

    /** One call to the voice-conversation brain. `providedContext` supplies gathers
     *  the brain can't self-fulfill (e.g. HA entities). Returns the raw turn. */
    async _brainCall(text, { personalityId, modelId, history, providedContext } = {}) {
        const t0 = performance.now();
        // "My Local LLM" routes to the on-prem add-on brain — it can reach the LAN model;
        // the cloud brain can't. 'local' is a routing sentinel, not a real model name, so we
        // DON'T forward it as options.model — the add-on resolves the saved local model.
        const isLocal = modelId === 'local';
        const body = {
            text,
            endpoint_id: 'console',
            options: {},
            history: (history || []).map(h => ({
                role: h.role === 'user' ? 'user' : 'assistant',
                text: h.content || h.voice || h.text || '',
            })),
        };
        if (personalityId) body.options.personality_id = personalityId;
        if (modelId && !isLocal) body.options.model = modelId;
        if (providedContext) body.provided_context = providedContext;
        const url = isLocal
            ? DashieAuth._addonUrl('/api/voice/converse-local')
            : `${DashieAuth.config.url}/functions/v1/voice-conversation`;
        const headers = isLocal
            ? { 'Content-Type': 'application/json' }
            : {
                'Content-Type': 'application/json',
                'apikey': DashieAuth.anonKey,
                'Authorization': `Bearer ${DashieAuth.jwt || DashieAuth.anonKey}`,
            };
        try {
            const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
            const turn = await resp.json().catch(() => ({}));
            if (!resp.ok || turn.ok === false) {
                const err = (isLocal && resp.status === 403)
                    ? (turn.message || `The ${BRAND.productName} add-on is not signed in.`)
                    : (turn.error || turn.message || `HTTP ${resp.status}`);
                return { ok: false, error: err, latency_ms: Math.round(performance.now() - t0), stages: turn.stages || [] };
            }
            return turn;
        } catch (e) {
            return { ok: false, error: `brain: ${e?.message || e}`, latency_ms: Math.round(performance.now() - t0) };
        }
    },

    /** Compact sports detector for the dev console (§23.6). Lighter than the
     *  shared js/core parser (which has the full team lexicon) — sport/league cues
     *  + a modest team set are enough here; misses fall to the brain's template. */
    _SPORTS_TEAMS: {
        chiefs: { sport: 'football', league: 'nfl' }, eagles: { sport: 'football', league: 'nfl' },
        cowboys: { sport: 'football', league: 'nfl' }, packers: { sport: 'football', league: 'nfl' },
        '49ers': { sport: 'football', league: 'nfl' }, bills: { sport: 'football', league: 'nfl' },
        lakers: { sport: 'basketball', league: 'nba' }, celtics: { sport: 'basketball', league: 'nba' },
        warriors: { sport: 'basketball', league: 'nba' }, knicks: { sport: 'basketball', league: 'nba' },
        yankees: { sport: 'baseball', league: 'mlb' }, dodgers: { sport: 'baseball', league: 'mlb' },
        'red sox': { sport: 'baseball', league: 'mlb' }, mets: { sport: 'baseball', league: 'mlb' },
        bruins: { sport: 'hockey', league: 'nhl' },
        'manchester united': { sport: 'soccer', league: 'premier-league' },
        liverpool: { sport: 'soccer', league: 'premier-league' }, arsenal: { sport: 'soccer', league: 'premier-league' },
        mexico: { sport: 'soccer', league: 'world-cup' },
    },
    _SPORTS_CUES: [
        [/world cup|\bfifa\b/i, { sport: 'soccer', league: 'world-cup' }],
        [/premier league|\bepl\b/i, { sport: 'soccer', league: 'premier-league' }],
        [/champions league/i, { sport: 'soccer', league: 'champions-league' }],
        [/\bnfl\b/i, { sport: 'football', league: 'nfl' }], [/\bnba\b/i, { sport: 'basketball', league: 'nba' }],
        [/\bmlb\b/i, { sport: 'baseball', league: 'mlb' }], [/\bnhl\b/i, { sport: 'hockey', league: 'nhl' }],
        [/\bsoccer\b/i, { sport: 'soccer' }], [/\bbasketball\b/i, { sport: 'basketball' }],
        [/\bbaseball\b/i, { sport: 'baseball' }], [/\bhockey\b/i, { sport: 'hockey' }],
    ],
    _detectWhen(t) {
        if (/\b(winning|losing|right now|currently|live|still (on|going|playing))\b/i.test(t)) return 'live';
        if (/\b(next|upcoming|tomorrow|when (do|does|is|are)|play(ing)? (today|tonight)|tonight)\b/i.test(t)) return 'next';
        return 'last';
    },
    _extractTeam(t) {
        const m = t.match(/of (?:the )?([a-z][\w'.\- ]+?) (?:game|match|score)\b/i)
            || t.match(/\bdid (?:the )?([a-z][\w'.\- ]+?) (?:win|play|beat|lose)/i)
            || t.match(/\b(?:are|is) (?:the )?([a-z][\w'.\- ]+?) (?:play|game)/i);
        if (!m) return null;
        const stop = new Set(['the', 'a', 'an', 'score', 'game', 'match']);
        return m[1].split(/\s+/).filter(w => !stop.has(w)).join(' ').trim() || null;
    },
    /** Detect a team-scoped sports query → fetch the gateway. Returns the result or null. */
    async _prefetchSports(text) {
        const t = (text || '').toLowerCase().trim();
        if (!/\b(game|score|match|won|win|winning|beat|playing|play|vs\.?|versus)\b/i.test(t)) return null;
        let query = null;
        for (const key of Object.keys(this._SPORTS_TEAMS).sort((a, b) => b.length - a.length)) {
            if (new RegExp(`\\b${key}\\b`, 'i').test(t)) { query = { ...this._SPORTS_TEAMS[key], team: key }; break; }
        }
        if (!query) {
            let sl = null;
            for (const [re, x] of this._SPORTS_CUES) if (re.test(t)) { sl = x; break; }
            if (!sl) return null;
            const team = this._extractTeam(t);
            if (!team) return null;
            query = { ...sl, team };
        }
        query.when = this._detectWhen(t);
        try {
            const resp = await fetch(`${DashieAuth.config.url}/functions/v1/sports-gateway`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: DashieAuth.anonKey, Authorization: `Bearer ${DashieAuth.jwt || DashieAuth.anonKey}` },
                body: JSON.stringify({ provider: 'auto', query }),
            });
            if (!resp.ok) return null;
            const data = await resp.json().catch(() => null);
            return (data && data.result_count > 0) ? data : null; // empty → let the brain template/say "couldn't find"
        } catch (_) { return null; }
    },

    /** Full console→brain turn: pre-fetch HA entities (so an HA command resolves in
     *  one round-trip), call the brain, then dispatch any returned action — the brain
     *  returns actions but does not execute them; the caller (console) does. */
    async _sendQueryViaBrain(text, { personalityId, modelId, history } = {}) {
        const t0 = performance.now();
        console.log('[ConsoleAiClient] routing via voice-conversation brain');

        // Best-effort HA entities (cached 60s). If HA isn't configured, HA queries
        // degrade gracefully (the brain returns unsupported_tool).
        let providedContext;
        try {
            const ents = await this._getControllableEntities();
            if (ents) providedContext = { ha_entities: ents.entities || [] };
        } catch (_) { /* no HA available */ }

        // §23.6: pre-fetch sports so pass-1 voices it IN PERSONALITY (vs the
        // deterministic template the brain falls back to without a pre-fetch).
        try {
            const sports = await this._prefetchSports(text);
            if (sports) providedContext = { ...(providedContext || {}), sports };
        } catch (_) { /* pre-fetch best-effort; brain templates on miss */ }

        const turn = await this._brainCall(text, { personalityId, modelId, history, providedContext });
        if (!turn.ok) return turn;

        // The brain returns actions but does not execute them — the caller dispatches.
        if (turn.action) {
            const tAct0 = performance.now();
            turn.action_result = await this._runAction(turn.action);
            turn.action_latency_ms = Math.round(performance.now() - tAct0);
        }
        turn._via = 'brain';
        turn.total_latency_ms = Math.round(performance.now() - t0);
        return turn;
    },

    /** Main entry point. Returns a structured "turn" object. */
    async sendQuery(text, opts = {}) {
        const t0 = performance.now();
        const personalityId = opts.personalityId || null;
        const modelId = opts.modelId || window.AiModelCatalog?.DEFAULT_AI_MODEL || 'gemini-3.1-flash-lite';
        const history = Array.isArray(opts.history) ? opts.history : [];
        const onStage = typeof opts.onStage === 'function' ? opts.onStage : () => {};

        // Console is dev-only → brain by default (opt out: ?brain=0 / localStorage dashie-use-brain=0).
        if (this._useBrain) {
            return this._sendQueryViaBrain(text, { personalityId, modelId, history });
        }

        // ── NLP FAST PATH ──────────────────────────────────────────
        // Mirror the tablet's IntentClassifier behavior: clear HA
        // commands skip the AI entirely and forward straight to HA's
        // Assist pipeline. Same effect, way smaller code surface than
        // porting the full 4k-line webapp classifier.
        if (window.ConsoleIntentClassifier) {
            const cls = window.ConsoleIntentClassifier.classify(text);
            if (cls.matched && cls.intent?.command === 'forward_to_assist') {
                onStage('nlp_intercept', { confidence: cls.confidence });
                const tAct0 = performance.now();
                const assist = await this._dispatchForwardToAssist(cls.intent.transcript);
                const actLatency = Math.round(performance.now() - tAct0);
                const speech = assist?.response?.response?.speech?.plain?.speech || '';
                const responseType = assist?.response?.response?.response_type || (assist.ok ? 'action_done' : 'error');
                return {
                    ok: true,
                    type: 'action',
                    voice: speech || (assist.ok ? 'Done.' : "Sorry, that didn't work."),
                    text: null,
                    action: {
                        category: 'homeassistant',
                        command: 'forward_to_assist',
                        parameters: { transcript: cls.intent.transcript },
                    },
                    action_result: {
                        dispatched: assist.ok,
                        kind: 'forward_to_assist',
                        response: assist.response,
                        response_type: responseType,
                        error: assist.error || null,
                    },
                    action_latency_ms: actLatency,
                    parsed_ok: true,
                    raw_content: null,
                    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    model: 'nlp',
                    provider: 'local',
                    latency_ms: actLatency,
                    nlp_confidence: cls.confidence,
                    stages: [{ name: 'nlp_intercept', latency_ms: actLatency, confidence: cls.confidence }],
                    total_latency_ms: Math.round(performance.now() - t0),
                };
            }
        }

        const provider = this._providerForModel(modelId);
        const personality = await this._getPersonality(personalityId);
        const promptContext = await this._buildPromptContext({ personality, history });

        onStage('pass1_start', { provider, modelId });

        // ── PASS 1 ─────────────────────────────────────────────────
        const initialPrompt = await window.PromptBuilder.buildPrompt({
            userRequest: text,
            inquiryType: null,
            retrievedData: null,
            context: promptContext,
        });
        const pass1 = await this._callGateway({ provider, prompt: initialPrompt, modelId });

        if (!pass1.ok) {
            return {
                ok: false, error: pass1.error,
                latency_ms: pass1.latency_ms,
                total_latency_ms: Math.round(performance.now() - t0),
                stages: [{ name: 'pass1', latency_ms: pass1.latency_ms, error: pass1.error }],
            };
        }

        const pass1Parsed = this._parseContent(pass1.raw.content);
        const pass1Stage = {
            name: 'pass1',
            latency_ms: pass1.latency_ms,
            model: pass1.raw.model,
            provider: pass1.raw.provider,
            usage: pass1.raw.usage,
            type: pass1Parsed?.type || 'response',
            parsed: pass1Parsed,
            raw_content: pass1.raw.content,
        };
        onStage('pass1_done', pass1Stage);

        // ── If it's a direct response or non-HA action, we're done.
        if (!pass1Parsed || pass1Parsed.type === 'response' || pass1Parsed.type === 'action') {
            return await this._finalize({
                t0, parsed: pass1Parsed, raw: pass1.raw,
                stages: [pass1Stage],
                primary_model: pass1.raw.model, primary_provider: pass1.raw.provider,
                primary_usage: pass1.raw.usage, primary_latency: pass1.latency_ms,
            });
        }

        // ── info_request → web_search ──────────────────────────────
        if (pass1Parsed.type === 'info_request' && pass1Parsed.tool === 'web_search') {
            const queryStr = typeof pass1Parsed.query === 'string'
                ? pass1Parsed.query
                : (pass1Parsed.query?.query || pass1Parsed.query?.q || text);
            onStage('fetch_search_start', { query: queryStr });
            const tFetch0 = performance.now();
            let searchResp;
            try {
                searchResp = await this._runWebSearch(queryStr);
            } catch (e) {
                const fetchErr = e?.message || String(e);
                return {
                    ok: false, error: `Web search failed: ${fetchErr}`,
                    latency_ms: pass1.latency_ms,
                    total_latency_ms: Math.round(performance.now() - t0),
                    stages: [pass1Stage, { name: 'fetch_search', latency_ms: Math.round(performance.now() - tFetch0), error: fetchErr }],
                };
            }
            const fetchStage = {
                name: 'fetch_search',
                latency_ms: Math.round(performance.now() - tFetch0),
                result_count: searchResp?.results?.length || 0,
                provider: searchResp?.provider || 'unknown',
            };
            onStage('fetch_search_done', fetchStage);

            // Pass 2 — hand the raw search response to the unified builder.
            // The web-search inquiry template JSON-stringifies it into
            // SEARCH_RESULTS; the AI parses structured JSON just fine.
            const wsPrompt = await window.PromptBuilder.buildPrompt({
                userRequest: text,
                inquiryType: 'web-search',
                retrievedData: searchResp,
                context: promptContext,
            });
            onStage('pass2_start', {});
            const pass2 = await this._callGateway({ provider, prompt: wsPrompt, modelId });
            if (!pass2.ok) {
                return {
                    ok: false, error: pass2.error,
                    latency_ms: pass2.latency_ms,
                    total_latency_ms: Math.round(performance.now() - t0),
                    stages: [pass1Stage, fetchStage, { name: 'pass2', latency_ms: pass2.latency_ms, error: pass2.error }],
                };
            }
            const pass2Parsed = this._parseContent(pass2.raw.content);
            const pass2Stage = {
                name: 'pass2',
                latency_ms: pass2.latency_ms,
                model: pass2.raw.model, provider: pass2.raw.provider,
                usage: pass2.raw.usage,
                type: pass2Parsed?.type || 'response',
                parsed: pass2Parsed, raw_content: pass2.raw.content,
            };
            onStage('pass2_done', pass2Stage);
            const totalUsage = this._sumUsage([pass1.raw.usage, pass2.raw.usage]);
            return await this._finalize({
                t0, parsed: pass2Parsed, raw: pass2.raw,
                stages: [pass1Stage, fetchStage, pass2Stage],
                primary_model: pass2.raw.model, primary_provider: pass2.raw.provider,
                primary_usage: totalUsage,
                primary_latency: pass1.latency_ms + pass2.latency_ms,
            });
        }

        // ── info_request → other (unsupported) tool ────────────────
        if (pass1Parsed.type !== 'info_request' || pass1Parsed.tool !== 'home_assistant') {
            return await this._finalize({
                t0, parsed: pass1Parsed, raw: pass1.raw,
                stages: [pass1Stage],
                primary_model: pass1.raw.model, primary_provider: pass1.raw.provider,
                primary_usage: pass1.raw.usage, primary_latency: pass1.latency_ms,
                unsupported_tool: pass1Parsed.tool,
            });
        }

        // ── FETCH HA ENTITIES ──────────────────────────────────────
        onStage('fetch_entities_start', {});
        const tFetch0 = performance.now();
        let retrievedData;
        try {
            retrievedData = await this._getControllableEntities();
        } catch (e) {
            const fetchErr = e?.message || String(e);
            return {
                ok: false, error: `HA entity fetch failed: ${fetchErr}`,
                latency_ms: pass1.latency_ms,
                total_latency_ms: Math.round(performance.now() - t0),
                stages: [
                    pass1Stage,
                    { name: 'fetch_entities', latency_ms: Math.round(performance.now() - tFetch0), error: fetchErr },
                ],
            };
        }
        const fetchStage = {
            name: 'fetch_entities',
            latency_ms: Math.round(performance.now() - tFetch0),
            entity_count: retrievedData?.entities?.length || 0,
        };
        onStage('fetch_entities_done', fetchStage);

        // ── PASS 2 ─────────────────────────────────────────────────
        const commandHint = pass1Parsed.query?.command_hint || text;
        const haPrompt = await window.PromptBuilder.buildPrompt({
            userRequest: text,
            inquiryType: 'home-assistant',
            retrievedData: { ...retrievedData, command_hint: commandHint },
            context: promptContext,
        });
        onStage('pass2_start', {});
        const pass2 = await this._callGateway({ provider, prompt: haPrompt, modelId });
        if (!pass2.ok) {
            return {
                ok: false, error: pass2.error,
                latency_ms: pass2.latency_ms,
                total_latency_ms: Math.round(performance.now() - t0),
                stages: [pass1Stage, fetchStage, { name: 'pass2', latency_ms: pass2.latency_ms, error: pass2.error }],
            };
        }
        const pass2Parsed = this._parseContent(pass2.raw.content);
        const pass2Stage = {
            name: 'pass2',
            latency_ms: pass2.latency_ms,
            model: pass2.raw.model, provider: pass2.raw.provider,
            usage: pass2.raw.usage,
            type: pass2Parsed?.type || 'response',
            parsed: pass2Parsed, raw_content: pass2.raw.content,
        };
        onStage('pass2_done', pass2Stage);

        // Sum usage across passes.
        const totalUsage = this._sumUsage([pass1.raw.usage, pass2.raw.usage]);
        return await this._finalize({
            t0, parsed: pass2Parsed, raw: pass2.raw,
            stages: [pass1Stage, fetchStage, pass2Stage],
            primary_model: pass2.raw.model, primary_provider: pass2.raw.provider,
            primary_usage: totalUsage,
            primary_latency: pass1.latency_ms + pass2.latency_ms,
        });
    },

    _sumUsage(usages) {
        const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        for (const u of usages) {
            if (!u) continue;
            total.input_tokens  += u.input_tokens  || 0;
            total.output_tokens += u.output_tokens || 0;
            total.total_tokens  += u.total_tokens  || 0;
        }
        return total;
    },

    /** Build the final turn object. Dispatch any action present. */
    async _finalize({ t0, parsed, raw, stages, primary_model, primary_provider, primary_usage, primary_latency, unsupported_tool }) {
        const out = {
            ok: true,
            type: parsed?.type || 'response',
            voice: parsed?.voice || raw.content || '',
            text: parsed?.text || null,
            action: parsed?.action || null,
            parsed_ok: !!parsed,
            raw_content: raw.content,
            usage: primary_usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            model: primary_model,
            provider: primary_provider,
            latency_ms: primary_latency,
            stages,
            unsupported_tool: unsupported_tool || null,
        };
        if (out.action) {
            const tAct0 = performance.now();
            out.action_result = await this._runAction(out.action);
            out.action_latency_ms = Math.round(performance.now() - tAct0);
        }
        out.total_latency_ms = Math.round(performance.now() - t0);
        return out;
    },

    async _runAction(action) {
        if (!action || typeof action !== 'object') return { dispatched: false };
        if (action.category !== 'homeassistant') {
            return { dispatched: false, reason: `unsupported category: ${action.category}` };
        }
        const cmd = action.command;
        const params = action.parameters || {};
        if (cmd === 'execute_commands') {
            const commands = Array.isArray(params.commands) ? params.commands : [];
            return { dispatched: true, kind: 'execute_commands', results: await this._dispatchExecuteCommands(commands) };
        }
        if (cmd === 'forward_to_assist') {
            return { dispatched: true, kind: 'forward_to_assist', ...(await this._dispatchForwardToAssist(params.transcript || '')) };
        }
        return { dispatched: false, reason: `unsupported command: ${cmd}` };
    },
};

window.ConsoleAiClient = ConsoleAiClient;

/*
   Turn object shape:
   {
     ok: true,
     type: 'response'|'info_request'|'action',
     voice, text, action,
     parsed_ok, raw_content,
     usage: {input_tokens, output_tokens, total_tokens},  // summed across passes
     model, provider,
     latency_ms,                  // gateway round trips only (sum across passes)
     total_latency_ms,            // wall clock incl. fetches and action dispatch
     action_result?: { dispatched, kind, results, error? },
     action_latency_ms?,
     unsupported_tool?: string,   // if the AI asked for a tool we don't have
     stages: [
       { name: 'pass1', latency_ms, model, provider, usage, type, parsed, raw_content },
       { name: 'fetch_entities', latency_ms, entity_count, error? },
       { name: 'pass2', latency_ms, model, provider, usage, type, parsed, raw_content },
     ],
   }
*/
