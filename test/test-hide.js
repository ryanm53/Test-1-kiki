// Putting the control bar away: the – on the bar, the keyboard shortcut, the
// switch in the toolbar popup. Hidden stays hidden across pages, every open
// page follows the setting, and a run carries on while the bar is away.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { boot, settle, until } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice(PREFIX.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};

const MC = `<body><div role="main">
  <div class="prompt">Which of the following is an asset?</div>
  <input type="radio" id="a" aria-label="Cash"><input type="radio" id="b" aria-label="Revenue">
  <button class="next-button">Next Question</button>
</div></body>`;

const hidden = p => p.shadow().getElementById('root').hidden;
const click = (p, id) => p.shadow().getElementById(id).dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));

(async () => {
  // ── The – on the bar ────────────────────────────────────────────────────
  {
    const p = boot(MC, { installLayout: flat, reply: b => as(b, { action: 'click', index: 0 }) });
    check('the bar shows by default', !hidden(p));
    check('it has a hide button', !!p.shadow().getElementById('hide'));

    click(p, 'gear');
    click(p, 'hide');
    check('hide puts the bar away', hidden(p));
    check('and closes the settings panel with it', !p.shadow().getElementById('panel').classList.contains('show'));
    check('and remembers it, for every page', p.store.barHidden === true);
    const toast = p.shadow().getElementById('toast');
    await until(() => !toast.hidden && /Alt\+Shift\+H/.test(toast.textContent));
    check('a note says how to bring it back, with the real shortcut',
      /Alt\+Shift\+H/.test(toast.textContent) && /toolbar/.test(toast.textContent), toast.textContent);
    check('the note is not hidden along with the bar', !toast.hidden);

    // ── The keyboard shortcut ───────────────────────────────────────────────
    p.command('toggle-bar');
    await until(() => !hidden(p));
    check('the shortcut brings it back', !hidden(p) && p.store.barHidden === false);
    check('and the note goes', toast.hidden);
    p.command('toggle-bar');
    await until(() => hidden(p));
    check('pressed again, it hides it', hidden(p) && p.store.barHidden === true);
  }

  // ── A page opened while it's hidden ─────────────────────────────────────
  {
    const p = boot(MC, { installLayout: flat, storage: { barHidden: true }, reply: '' });
    await wait(50);
    check('a new page starts with it hidden', hidden(p));
    check('without the note (nothing was just hidden)', p.shadow().getElementById('toast').hidden);
    // The popup's switch writes the same setting
    p.w.chrome.storage.local.set({ barHidden: false });
    await until(() => !hidden(p));
    check('the popup switch shows it on pages already open', !hidden(p));
  }

  // ── A run carries on with the bar away ──────────────────────────────────
  {
    const p = boot(MC, { installLayout: flat, storage: { lastPresetIndex: 0, autoContinue: false },
                         reply: b => as(b, { action: 'click', index: 0 }) });
    let next = false;
    p.w.document.querySelector('.next-button').addEventListener('click', () => { next = true; });
    p.pressPlay();
    click(p, 'hide');
    const final = await settle(p);
    check('a run started before hiding still answers', p.w.document.getElementById('a').checked);
    check('and still clicks Next', next, final);
  }

  // ── The toolbar popup ───────────────────────────────────────────────────
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8')
      .replace(/<script src="popup.js"><\/script>/, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const store = { barHidden: true };
    let opened = null;
    dom.window.chrome = {
      storage: { local: { get: (k, cb) => cb({ ...store }), set: o => Object.assign(store, o) } },
      commands: { getAll: cb => cb([{ name: 'toggle-bar', shortcut: 'Alt+Shift+H' }]) },
      tabs: { create: o => { opened = o.url; } }
    };
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8'));
    const d = dom.window.document;
    const sw = d.getElementById('showBar');
    check('popup: the switch shows the bar is hidden', sw.getAttribute('aria-checked') === 'false');
    sw.click();
    check('popup: turning it on shows the bar', store.barHidden === false && sw.getAttribute('aria-checked') === 'true');
    sw.click();
    check('popup: and off hides it again', store.barHidden === true);
    check('popup: names the shortcut', /Alt\+Shift\+H/.test(d.getElementById('shortcutHint').textContent));
    d.querySelector('#shortcutHint a').click();
    check('popup: links to Chrome\'s shortcut settings', opened === 'chrome://extensions/shortcuts', opened);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll hide checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
