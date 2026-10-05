/**
 * console-harness — load the REAL console, in real index.html order, in one shared
 * global scope, inside node. No browser.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every console gate we have inspects the HTML a render function RETURNS. None of
 * them ever CALLS a click handler. That gap is not theoretical: the six dead Admin
 * Actions (console 0.9.42) rendered perfect markup and did nothing when pressed,
 * and a string-matching gate is green for all six. A handler that throws — a typo'd
 * global, a method that moved, a file that loads before the holder it needs — is
 * invisible until a person clicks it.
 *
 * The console is 85 classic <script> tags sharing ONE global scope, with no modules
 * and no bundler. So load order is a real hazard rather than a formality, and the
 * cheapest honest way to test it is to do what the browser does: run the files in
 * order in one context and see what breaks.
 *
 * Modelled on dashieapp_staging/tools/admin-console-harness/harness.mjs, which does
 * the same for the admin console.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * 🔴 There is NO LAYOUT here. The stub document does not measure anything, so every
 * width/height reads 0 and any code that branches on a measurement takes the wrong
 * branch. Fit, overflow and collision questions need real Chrome — see
 * tools/freeform-fit/. A green run here says the code RUNS, never that it LOOKS right.
 *
 * ── 🔴 WHY THE FILES ARE CONCATENATED AND NOT RUN ONE BY ONE ────────────────
 *
 * In a browser, the top-level `let`/`const` of a classic script go into the GLOBAL
 * LEXICAL ENVIRONMENT, which every other classic script on the page shares. That is
 * how a bare `App` in app.js sees `const App` elsewhere — and it is the documented
 * gotcha that cost four add-on releases: `DashieAuth` is a top-level `const`, so
 * `window.DashieAuth` is ALWAYS undefined while bare `DashieAuth` works.
 *
 * node's `vm` does NOT share that environment across separate `vm.Script` runs: each
 * `runInContext` gets its own lexical scope, so a per-file loop silently breaks the
 * sharing the browser provides. The first version of this harness did exactly that
 * and reported `App`, `VoiceAiPage` and `VoiceAiApi` as undefined — a harness bug that
 * reads exactly like three broken console files, which is the worst way to be wrong.
 *
 * So: COMPILE each file separately (syntax errors keep their filename), then EXECUTE
 * one concatenation (lexical scope is shared, as in the browser). A runtime throw is
 * attributed back to a file through the line-offset table, so we keep the per-file
 * blame the loop was giving us without keeping its lie.
 *
 * ⚠️ Do not "improve" this back into a loop. The symptom of that regression is a
 * global reading undefined that is perfectly fine in production.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

/** A forgiving fake element. Returns more fake elements rather than undefined, so
 *  85 files of real console code can load without the stub becoming a second
 *  implementation of the DOM. Writes are recorded so tests can assert on them. */
function mkNode(id = 'node') {
    const node = {
        id,
        tagName: 'DIV',
        style: {},
        dataset: {},
        classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        children: [],
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
        get textContent() { return this._html.replace(/<[^>]*>/g, ''); },
        set textContent(v) { this._html = String(v); },
        value: '',
        checked: false,
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
        remove() { },
        setAttribute(k, v) { this.dataset[k] = v; },
        getAttribute(k) { return this.dataset[k] ?? null; },
        removeAttribute(k) { delete this.dataset[k]; },
        addEventListener() { },
        removeEventListener() { },
        querySelector: () => mkNode('q'),
        querySelectorAll: () => [],
        closest: () => null,
        focus() { },
        blur() { },
        click() { },
        scrollIntoView() { },
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
        insertAdjacentHTML() { },
    };
    return node;
}

function mkStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        clear: () => { m.clear(); },
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null,
        _map: m,
    };
}

/**
 * @param {object} o
 * @param {string} o.consoleDir  the served console root (contains index.html)
 * @param {Function} [o.fetchImpl] stubbed fetch; defaults to one that throws loudly
 */
export function loadConsole({ consoleDir, fetchImpl }) {
    const html = fs.readFileSync(path.join(consoleDir, 'index.html'), 'utf8');

    // Order as the browser sees it. `?v=` cache-busters are stripped (83 of 85 carry
    // one); the jsdelivr CDN tag and the Supabase vendor bundle are not executed —
    // see `skipped` below, which the caller asserts on so a skip can't go unnoticed.
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    const skipped = [];
    const files = [];
    for (const raw of srcs) {
        const src = raw.split('?')[0];
        if (/^https?:\/\//.test(src)) { skipped.push({ src, why: 'external CDN' }); continue; }
        if (/vendor\/supabase-js/.test(src)) { skipped.push({ src, why: 'vendor bundle — stubbed' }); continue; }
        files.push(src);
    }

    const doc = {
        readyState: 'complete',
        _byId: new Map(),
        getElementById(id) {
            if (!this._byId.has(id)) this._byId.set(id, mkNode(id));
            return this._byId.get(id);
        },
        createElement: (t) => { const n = mkNode('created'); n.tagName = String(t).toUpperCase(); return n; },
        createDocumentFragment: () => mkNode('fragment'),
        querySelector: () => mkNode('q'),
        querySelectorAll: () => [],
        addEventListener() { },
        removeEventListener() { },
        body: mkNode('body'),
        documentElement: mkNode('html'),
        head: mkNode('head'),
        cookie: '',
    };

    const loadErrors = [];
    const sandbox = {
        console,
        document: doc,
        localStorage: mkStorage(),
        sessionStorage: mkStorage(),
        location: { href: 'http://localhost/', search: '', hash: '', pathname: '/', origin: 'http://localhost', reload() { } },
        navigator: { userAgent: 'harness', language: 'en-US', clipboard: { writeText: async () => { } } },
        setTimeout: (fn) => { if (typeof fn === 'function') { /* never auto-fire */ } return 0; },
        clearTimeout() { },
        setInterval: () => 0,
        clearInterval() { },
        requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(0); return 0; },
        fetch: fetchImpl || (async () => { throw new Error('HARNESS: unstubbed fetch'); }),
        // The vendor bundle is not executed, so hand the code the one symbol it exports.
        supabase: { createClient: () => ({ auth: {}, from: () => ({ select: () => ({ data: null, error: null }) }) }) },
        URLSearchParams,
        URL,
        Date,
        Math,
        JSON,
        Promise,
        Error,
        TextEncoder,
        TextDecoder,
        btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
        alert() { },
        confirm: () => true,
        prompt: () => null,
        matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    const ctx = vm.createContext(sandbox);

    // PASS 1 — compile each file alone, so a SYNTAX error keeps its own filename.
    const present = [];
    const sources = [];
    for (const rel of files) {
        const abs = path.join(consoleDir, rel);
        if (!fs.existsSync(abs)) { loadErrors.push({ file: rel, error: 'MISSING ON DISK' }); continue; }
        const src = fs.readFileSync(abs, 'utf8');
        try {
            new vm.Script(src, { filename: rel });   // compile only — never run
        } catch (e) {
            loadErrors.push({ file: rel, error: `SyntaxError: ${e.message}` });
            continue;
        }
        present.push(rel);
        sources.push(src);
    }

    // PASS 2 — execute ONE script, so top-level const/let are shared as the browser
    // shares them. A line-offset table keeps per-file attribution on a runtime throw.
    const lineOf = [];     // [startLine, file]
    let line = 1, joined = '';
    for (let i = 0; i < present.length; i++) {
        lineOf.push([line, present[i]]);
        const chunk = sources[i].endsWith('\n') ? sources[i] : sources[i] + '\n';
        joined += chunk;
        line += chunk.split('\n').length - 1;
    }
    const blame = (n) => {
        let hit = '(unknown)';
        for (const [start, f] of lineOf) { if (start <= n) hit = f; else break; }
        return hit;
    };
    try {
        new vm.Script(joined, { filename: 'console-concatenated.js' }).runInContext(ctx);
    } catch (e) {
        const m = /console-concatenated\.js:(\d+)/.exec(e.stack || '');
        const n = m ? Number(m[1]) : 0;
        loadErrors.push({
            file: n ? blame(n) : '(could not attribute)',
            error: `${e.name}: ${e.message}`,
            concatenatedLine: n || undefined,
        });
    }

    return { ctx, sandbox, win: sandbox, doc, files: present, skipped, loadErrors, blame };
}
