// The failure modes that show up as "I pressed play and nothing happened":
// a second injection, a dead extension connection, and a page that wipes the
// control bar out of the DOM.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');

function makePage({ deadContext = false } = {}) {
  const dom = new JSDOM('<body><div role="main"><button>An answer</button></div></body>',
    { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;

  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 50, height: 20, top: 5, bottom: 25, left: 5, right: 55 });
  w.HTMLElement.prototype.scrollIntoView = () => {};

  const sent = [];
  const listeners = [];
  w.chrome = {
    runtime: {
      // A reloaded extension leaves the old page with no runtime id, and every
      // call throws rather than returning an error.
      get id() { return deadContext ? undefined : 'abc123'; },
      onMessage: { addListener: f => listeners.push(f) },
      sendMessage: (msg, cb) => {
        if (deadContext) throw new Error('Extension context invalidated.');
        sent.push(msg);
        cb && cb({ success: true });
      },
      lastError: null
    },
    storage: {
      local: {
        get: (k, cb) => { if (deadContext) throw new Error('Extension context invalidated.'); cb({ apiKey: 'sk-ant-test' }); },
        set: (o, cb) => { if (deadContext) throw new Error('Extension context invalidated.'); cb && cb(); }
      }
    }
  };
  return { dom, w, sent, listeners };
}

const run = (w, src) => new w.Function(src).call(w);
const widgetOf = w => w.document.getElementById('__cap-host');
const status = w => widgetOf(w)?.shadowRoot.getElementById('statusText')?.textContent ?? '';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};

// 1. Injected twice — the background does this for tabs that were already open
{
  const { w, listeners } = makePage();
  run(w, SRC);
  let threw = null;
  try { run(w, SRC); } catch (e) { threw = e.message; }
  check('second injection does not throw', !threw, threw);
  check('second injection adds no second widget',
    w.document.querySelectorAll('#__cap-host').length === 1,
    `${w.document.querySelectorAll('#__cap-host').length} widgets`);
  check('second injection adds no duplicate listener',
    listeners.length === 1, `${listeners.length} listeners`);
}

// 2. Extension reloaded under an open page
{
  const { w } = makePage({ deadContext: true });
  let threw = null;
  try { run(w, SRC); } catch (e) { threw = e.message; }
  check('loads even with a dead connection', !threw, threw);

  const go = widgetOf(w)?.shadowRoot.getElementById('go');
  check('control bar still renders', !!go);
  if (go) {
    go.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check('play explains the refresh instead of hanging',
      /refresh this page/i.test(status(w)), `status was "${status(w)}"`);
  }
}

// 3. A long run reports progress, so the silence timer never kills live work
{
  const { w, listeners } = makePage();
  // never answer: the run stays in flight, exactly like a long multi-step task
  w.chrome.runtime.sendMessage = () => {};
  run(w, SRC);

  const go = widgetOf(w).shadowRoot.getElementById('go');
  go.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('a started run says it is answering', /Answering/.test(status(w)), status(w));

  listeners[0]({ type: 'PROGRESS', step: 2, budget: 6 }, {}, () => {});
  check('progress shows which step it is on', /step 2\/6/.test(status(w)), status(w));

  listeners[0]({ type: 'PROGRESS', step: 1, budget: 1 }, {}, () => {});
  check('a one-step question stays uncluttered',
    /Answering…$/.test(status(w).replace(/ · \d+$/, '')), status(w));
}

// 4. A page that replaces its body between questions
{
  const { w } = makePage();
  run(w, SRC);
  w.document.body.innerHTML = '<div role="main">next question</div>';
  check('control bar removed by the page', !widgetOf(w));
  // The self-heal runs on a 2s interval, which a loaded machine can stretch,
  // so wait until it has happened rather than a fixed time
  const end = Date.now() + 10000;
  return void (function poll() {
    if (!widgetOf(w) && Date.now() < end) return setTimeout(poll, 50);
    check('control bar puts itself back', !!widgetOf(w));
    console.log(failed ? `\n${failed} failed` : '\nAll resilience checks passed');
    process.exit(failed ? 1 : 0);
  })();
}
