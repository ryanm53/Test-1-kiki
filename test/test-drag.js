// The control bar can be dragged anywhere and stays where it was put.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

function makePage(saved = {}) {
  const dom = new JSDOM('<body><div role="main"><button>An answer</button></div></body>',
    { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;

  // The bar reads its own position back through this, so the stub has to
  // reflect the style it just set — and, before any drag, the CSS default of
  // 22px up from the bottom-left corner.
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const left = parseFloat(this.style?.left) || 22;
    const top  = parseFloat(this.style?.top);
    const y = Number.isFinite(top) ? top : w.innerHeight - 40 - 22;
    return { width: 260, height: 40, left, top: y, right: left + 260, bottom: y + 40 };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};

  const written = {};
  w.chrome = {
    runtime: {
      get id() { return 'abc123'; },
      onMessage: { addListener: () => {} },
      sendMessage: () => {},
      lastError: null
    },
    storage: {
      local: {
        get: (k, cb) => cb({ apiKey: 'sk-ant-test', ...saved }),
        set: (o, cb) => { Object.assign(written, o); cb && cb(); }
      }
    }
  };
  new w.Function(SRC).call(w);
  const host = w.document.getElementById('__cap-host');
  return { w, host, written, shadow: host.shadowRoot };
}

// jsdom may not ship a PointerEvent constructor; the listeners only care about
// the event type and coordinates.
function pointer(w, el, type, x, y) {
  const Ctor = w.PointerEvent ?? w.MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};

// 1. Drag by the bar background
{
  const { w, host, written, shadow } = makePage();
  const bar = shadow.getElementById('bar');
  pointer(w, bar, 'pointerdown', 100, 700);
  pointer(w, bar, 'pointermove', 400, 300);   // 300 right, 400 up
  pointer(w, bar, 'pointerup',   400, 300);

  // starts at left 22, top 706 (22px up from the bottom of a 768px window)
  check('bar moves with the pointer',
    host.style.left === '322px' && host.style.top === '306px',
    `${host.style.left} / ${host.style.top}`);
  check('bottom anchoring is released', host.style.bottom === 'auto', host.style.bottom);
  check('position is remembered',
    written.barPos?.left === 322 && written.barPos?.top === 306,
    JSON.stringify(written.barPos));
}

// 2. Dragged off-screen, it stays reachable
{
  const { w, host, shadow } = makePage();
  const bar = shadow.getElementById('bar');
  pointer(w, bar, 'pointerdown', 0, 0);
  pointer(w, bar, 'pointermove', 9000, 9000);
  pointer(w, bar, 'pointerup',   9000, 9000);
  const left = parseFloat(host.style.left), top = parseFloat(host.style.top);
  check('clamped inside the window',
    left + 260 <= w.innerWidth && top + 40 <= w.innerHeight,
    `${left} / ${top} in ${w.innerWidth}x${w.innerHeight}`);
}

// 3. The buttons are still buttons
{
  const { w, host, written, shadow } = makePage();
  const go = shadow.getElementById('go');
  pointer(w, go, 'pointerdown', 20, 20);
  pointer(w, go, 'pointermove', 24, 22);   // a small wobble while clicking
  pointer(w, go, 'pointerup',   24, 22);
  check('pressing play does not drag the bar',
    host.style.bottom === '22px' && host.style.left === '22px',
    `${host.style.left} / bottom ${host.style.bottom}`);
  check('a wobble is not saved as a move', written.barPos === undefined, JSON.stringify(written.barPos));
}

// 4. The settings panel picks a side to open towards
{
  const { w, shadow } = makePage();
  const bar = shadow.getElementById('bar'), panel = shadow.getElementById('panel');
  check('opens upward from the bottom left', !panel.classList.contains('below'));

  pointer(w, bar, 'pointerdown', 100, 700);
  pointer(w, bar, 'pointermove', 900, 200);   // up and to the right
  pointer(w, bar, 'pointerup',   900, 200);
  check('opens downward near the top', panel.classList.contains('below'));
  check('right-aligns near the right edge', panel.classList.contains('alignRight'));
}

// 5. A position saved on a larger screen still lands somewhere visible
{
  const { host, w } = makePage({ barPos: { left: 3400, top: 1900 } });
  const left = parseFloat(host.style.left), top = parseFloat(host.style.top);
  check('a stale saved position is pulled back into view',
    left + 260 <= w.innerWidth && top + 40 <= w.innerHeight,
    `${left} / ${top}`);
}

console.log(failed ? `\n${failed} failed` : '\nAll drag checks passed');
process.exit(failed ? 1 : 0);
