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

function boot(html, { reply, storage = {}, installLayout, beforeLoad } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://school.instructure.com/courses/1/quizzes/2/take',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const w = dom.window;
  if (installLayout) installLayout(w);
  // jsdom has no layout engine and so no innerText; textContent is close enough
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent.replace(/\s+/g, ' ').trim(); },
    configurable: true
  });

  const store = { apiKey: 'sk-ant-test', autoContinue: true, ...storage };
  const requests = [];
  const debuggerCalls = [];   // trusted input sent through chrome.debugger
  let contentListener = null, backgroundListener = null;

  // ── the page side ───────────────────────────────────────────────────────
  w.chrome = {
    runtime: {
      get id() { return 'ext'; },
      lastError: null,
      onMessage: { addListener: f => { contentListener = f; } },
      sendMessage: (msg, cb) => backgroundListener(msg, { tab: { id: 1 } }, res => cb && cb(res))
    },
    storage: { local: {
      get: (k, cb) => cb({ ...store }),
      set: (o, cb) => { Object.assign(store, o); cb && cb(); }
    } }
  };

  // ── the extension side ──────────────────────────────────────────────────
  const bgChrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: f => { backgroundListener = f; } }
    },
    tabs: {
      sendMessage: (tabId, msg, opts, cb) => {
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
      set: async o => { Object.assign(store, o); }
    } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (target, method, params) => { debuggerCalls.push({ method, ...params }); },
      onDetach: { addListener: () => {} }
    }
  };

  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const out = typeof reply === 'function' ? reply(body, requests.length) : reply;
    // An object reply is an HTTP failure: { status, body }
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

  vm.runInNewContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), {
    chrome: bgChrome, fetch: fakeFetch, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Math, Date, Set, Map, Number, String, Array, Object, Error
  });
  if (beforeLoad) beforeLoad(w);
  new w.Function(fs.readFileSync(path.join(EXT, 'content.js'), 'utf8')).call(w);

  const shadow = () => w.document.getElementById('__cap-host')?.shadowRoot;
  return {
    w, store, requests, debuggerCalls,
    send: msg => new Promise(res => backgroundListener(msg, { tab: { id: 1 } }, res)),
    status: () => shadow()?.getElementById('statusText')?.textContent ?? '',
    isError: () => !!shadow()?.getElementById('statusText')?.classList.contains('err'),
    pressPlay: () => shadow().getElementById('go').dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    scrape: () => new Promise(res => contentListener({ type: 'SCRAPE' }, {}, res))
  };
}

// Resolves once the bar settles on something other than a working state.
// Generous, because CI machines are slower and run every suite at once; it
// returns as soon as the bar settles, so the ceiling costs nothing normally.
function settle(page, ms = 20000) {
  const end = Date.now() + ms;
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
  const end = Date.now() + ms;
  return new Promise(resolve => (function poll() {
    if (cond() || Date.now() > end) return resolve();
    setTimeout(poll, 25);
  })());
}

module.exports = { boot, settle, until };
