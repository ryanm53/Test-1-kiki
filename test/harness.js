// Runs the real background.js and content.js against each other on a jsdom
// page, with Chrome's messaging wired between them and only the Claude API
// faked. What this proves is the plumbing: that a given page produces the
// right prompt, and a given reply produces the right clicks.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// EXT_DIR lets a suite be pointed at an older copy, to prove it catches a bug
const EXT = process.env.EXT_DIR || path.join(__dirname, '..', 'extension');

function boot(html, options = {}) {
  const { reply, storage = {}, installLayout, beforeLoad, url } = options;
  const dom = new JSDOM(html, {
    url: url ?? 'https://school.instructure.com/courses/1/quizzes/2/take',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const w = dom.window;
  if (installLayout) installLayout(w);
  // jsdom has no layout engine and so no innerText; textContent is close enough
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() {
      // Like a browser's: what isn't displayed isn't read (selects hidden by
      // the extension, for one)
      const out = [];
      const walk = n => {
        if (n.nodeType === 3) out.push(n.nodeValue);
        else if (n.nodeType === 1 && n.style?.display !== 'none') n.childNodes.forEach(walk);
      };
      walk(this);
      return out.join(' ').replace(/\s+/g, ' ').trim();
    },
    configurable: true
  });

  const store = { apiKey: 'sk-ant-test', autoContinue: true, ...storage };
  const requests = [];
  const requestHeaders = [];  // headers sent with each of those, same order
  const debuggerCalls = [];   // trusted input sent through chrome.debugger
  const screenshots = [];     // every captureVisibleTab call
  const pageMessages = [];    // everything the background asked the page
  let contentListener = null, backgroundListener = null, commandListener = null;
  // chrome.storage.onChanged: a write from either side reaches the page
  const changeListeners = [];
  const write = o => {
    const changes = {};
    for (const [k, v] of Object.entries(o)) changes[k] = { oldValue: store[k], newValue: v };
    Object.assign(store, o);
    setTimeout(() => changeListeners.forEach(f => f(changes, 'local')), 0);
  };

  // ── the page side ───────────────────────────────────────────────────────
  w.chrome = {
    runtime: {
      get id() { return 'ext'; },
      lastError: null,
      onMessage: { addListener: f => { contentListener = f; } },
      // Chrome tells the background which tab and page a message came from
      sendMessage: (msg, cb) => backgroundListener(msg, { tab: { id: 1 }, url: w.location.href }, res => cb && cb(res))
    },
    storage: {
      local: {
        get: (k, cb) => cb({ ...store }),
        set: (o, cb) => { write(o); cb && cb(); }
      },
      onChanged: { addListener: f => changeListeners.push(f) }
    }
  };

  // ── the extension side ──────────────────────────────────────────────────
  const bgChrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: f => { backgroundListener = f; } }
    },
    tabs: {
      get: async id => ({ id, windowId: 1, active: !options.tabHidden }),
      // A picture of the screen, as a data URL; or a failure
      captureVisibleTab: async (windowId, opts) => {
        screenshots.push({ windowId, ...opts });
        // What the page looks like at the instant of the capture
        options.onCapture?.(w);
        if (options.captureFails) throw new Error('Cannot capture');
        return 'data:image/jpeg;base64,/9j/AAAA';
      },
      sendMessage: (tabId, msg, opts, cb) => {
        pageMessages.push(msg);
        // A page that never answers a kind of message (an old copy of the script)
        if (options.ignore?.includes(msg.type)) return;
        // Chrome answers asynchronously; so does this
        setTimeout(() => {
          const keepOpen = contentListener(msg, {}, res => cb && cb(res));
          if (keepOpen !== true) { /* answered synchronously already */ }
        }, 0);
      }
    },
    scripting: {
      executeScript: async ({ func }) => [{ frameId: 0, result: new w.Function(`return (${func})()`)() }]
    },
    storage: { local: {
      get: async k => ({ ...store }),
      set: async o => { write(o); }
    } },
    commands: {
      onCommand: { addListener: f => { commandListener = f; } },
      getAll: async () => [{ name: 'toggle-bar', shortcut: 'Alt+Shift+H', description: '' }]
    },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (target, method, params) => { debuggerCalls.push({ method, ...params }); },
      onDetach: { addListener: () => {} }
    }
  };

  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    requestHeaders.push(init.headers ?? {});
    // A reply may be a promise, to stand for Claude taking its time
    const out = await (typeof reply === 'function' ? reply(body, requests.length) : reply);
    // { json } is a whole successful reply, for shapes a plain text answer
    // can't express: a decline, a fallback, running out of room
    if (out && typeof out === 'object' && out.json) {
      return { ok: true, status: 200, json: async () => out.json, text: async () => JSON.stringify(out.json) };
    }
    // Any other object reply is an HTTP failure: { status, body }
    if (out && typeof out === 'object') {
      return { ok: false, status: out.status, json: async () => ({}), text: async () => out.body ?? '' };
    }
    const text = out;
    return {
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text }] }),
      text: async () => text
    };
  };

  // The background's own globals, kept so a test can replace one of its functions
  const bg = {
    chrome: bgChrome, fetch: fakeFetch, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Math, Date, Set, Map, Number, String, Array, Object, Error, URL
  };
  vm.runInNewContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), bg);
  if (beforeLoad) beforeLoad(w);
  new w.Function(fs.readFileSync(path.join(EXT, 'content.js'), 'utf8')).call(w);

  const shadow = () => w.document.getElementById('__cap-host')?.shadowRoot;
  return {
    bg, w, store, requests, requestHeaders, debuggerCalls, pageMessages, screenshots,
    send: msg => new Promise(res => backgroundListener(msg, { tab: { id: 1 }, url: w.location.href }, res)),
    // A keyboard shortcut, as Chrome delivers it to the background
    command: name => commandListener?.(name),
    status: () => shadow()?.getElementById('statusText')?.textContent ?? '',
    isError: () => !!shadow()?.getElementById('statusText')?.classList.contains('err'),
    pressPlay: () => shadow().getElementById('go').dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    scrape: () => new Promise(res => contentListener({ type: 'SCRAPE' }, {}, res)),
    toPage: msg => new Promise(res => contentListener(msg, {}, res)),
    shadow
  };
}

// Resolves once the bar settles on something other than a working state.
// Generous, because CI machines are slower and run every suite at once; it
// returns as soon as the bar settles, so the ceiling costs nothing normally.
function settle(page, ms = 90000) {
  // A ceiling for the slowest machine, whatever a test asks for
  const end = Date.now() + Math.max(ms, 90000);
  return new Promise(resolve => (function poll() {
    const s = page.status();
    if (!/Answering|Next question/.test(s) || Date.now() > end) return resolve(s);
    setTimeout(poll, 50);
  })());
}

// Waits for something to HAVE happened. A fixed sleep followed by a check
// passes on a fast machine and fails on a slow one; this waits as long as it
// takes, up to a ceiling. (Checks that something did NOT happen still need a
// fixed wait — long enough for it to have happened if it was going to.)
function until(cond, ms = 15000) {
  // However little a test asks for, a loaded machine (every suite on one core)
  // gets a minute: it costs nothing when the thing happens promptly
  const end = Date.now() + Math.max(ms, 60000);
  return new Promise(resolve => (function poll() {
    if (cond() || Date.now() > end) return resolve();
    setTimeout(poll, 25);
  })());
}

// The words of a request's first message, whether or not a screenshot came first
const bodyText = b => {
  const m = b?.messages?.[0]?.content;
  return Array.isArray(m) ? (m.find(x => x.type === 'text')?.text ?? '') : (m ?? '');
};

module.exports = { boot, settle, until, bodyText };
