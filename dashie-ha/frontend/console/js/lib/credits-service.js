/* ============================================================
   Credits Service
   ------------------------------------------------------------
   Owns the cached balance shown in the sidebar's bottom-left
   widget AND the Token Usage tab's "Balance" stat. Both reads
   go through the same cache so they never disagree.

   Pattern:
     - CreditsService.fetch()  → async, fetches via DashieAuth
                                  and caches the result.
     - CreditsService.balance  → synchronous getter (returns
                                  cached object or null).
     - CreditsService.note(b)  → stash a balance object returned
                                  by another caller (e.g. the
                                  Token Usage tab also fetches
                                  get_credit_balance for its own
                                  stat strip — reuse that result
                                  instead of double-fetching).

   Sidebar re-render: after fetch() resolves, we call
   App.renderPage() if the page has changed (so the sidebar
   redraws with the new balance). Pages don't need to subscribe.
   ============================================================ */

const CreditsService = (function () {
    let _cache = null;        // {balance, lifetime_granted, is_admin, updated_at}
    let _inflight = null;     // Promise — dedupe concurrent fetches

    function balance() {
        return _cache;
    }

    function note(obj) {
        if (!obj || typeof obj.balance !== 'number') return;
        _cache = obj;
        _scheduleRender();
    }

    async function fetch(opts = {}) {
        if (_inflight && !opts.force) return _inflight;
        // DashieAuth is a bare script-scope const, NOT on window — the old
        // window.DashieAuth?.dbRequest guard was ALWAYS undefined, so this
        // returned null every time and the sidebar/account balance never
        // populated until the Credit Usage page fetched it directly.
        if (typeof DashieAuth === 'undefined' || !DashieAuth.dbRequest) {
            // Auth bundle isn't loaded yet (e.g. very early boot) — defer
            // silently. Callers that care can retry after init.
            return null;
        }
        _inflight = (async () => {
            try {
                const result = await DashieAuth.dbRequest('get_credit_balance', {});
                if (result && typeof result.balance === 'number') {
                    _cache = result;
                    _scheduleRender();
                }
                return result;
            } catch (e) {
                console.warn('[CreditsService] fetch failed', e);
                return null;
            } finally {
                _inflight = null;
            }
        })();
        return _inflight;
    }

    /** Trigger a sidebar re-render on the next microtask without re-running
     *  the page body. App.renderPage() does both, but we throttle to once
     *  per tick so a burst of note() calls doesn't thrash. */
    let _renderScheduled = false;
    function _scheduleRender() {
        if (_renderScheduled) return;
        _renderScheduled = true;
        queueMicrotask(() => {
            _renderScheduled = false;
            const el = document.getElementById('sidebar');
            if (el && window.Sidebar?.render && window.App?._currentPage) {
                el.innerHTML = window.Sidebar.render(window.App._currentPage);
            }
        });
    }

    return { fetch, note, balance };
})();

window.CreditsService = CreditsService;
