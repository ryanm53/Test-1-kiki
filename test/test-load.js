// Load content.js the way a page would, with a minimal chrome stub, and see
// whether the widget actually mounts.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<body><div role="main"><button>hi</button></div></body>',
  { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'outside-only' });

global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const k of ['Element','HTMLElement','Node','PointerEvent','MouseEvent','KeyboardEvent',
                 'InputEvent','FocusEvent','Event','DataTransfer','DragEvent','getComputedStyle'])
  if (dom.window[k]) global[k] = dom.window[k];

dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 50, height: 20, top: 5, bottom: 25, left: 5, right: 55 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const listeners = [];
global.chrome = dom.window.chrome = {
  runtime: {
    onMessage: { addListener: f => listeners.push(f) },
    sendMessage: () => {},
    lastError: null
  },
  storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } }
};

try {
  new dom.window.Function(fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8'))
    .call(dom.window);
} catch (e) {
  console.log('THREW AT LOAD:', e.message);
  process.exit(1);
}

const host = dom.window.document.getElementById('__cap-host');
console.log('widget mounted:', !!host);
console.log('message listeners registered:', listeners.length);
if (host) {
  const sh = host.shadowRoot;
  console.log('play button:', !!sh.getElementById('go'), '| gear:', !!sh.getElementById('gear'));
  console.log('status text:', sh.getElementById('statusText')?.textContent);
}
process.exit(host ? 0 : 1);
