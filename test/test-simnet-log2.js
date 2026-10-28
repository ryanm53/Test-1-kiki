// A second real SIMnet exam (40 formula tasks, 70% right), and what its log
// showed beyond the typing fault (see test-simnet-formula.js):
//
// - Six runs stopped on `from must be a cell address like B7, got: ""` after a
//   perfectly good click: the reply is shaped by a schema that names every field,
//   and the model fills the ones it doesn't need with "". An empty field is an
//   absent one.
// - One run clicked the Excel window's own Close button, and lost the question.
// - A formula typed with a line break on its end.
// - The verdict popup is a moment coming after Enter. Not there yet was taken as
//   the answer being wrong, and the model went off to the ribbon's Function
//   Arguments dialog to try again — which ran out of steps.
// - That dialog redraws its boxes after each is filled: "[16] left the page".
// - A "(" dropped from the middle of a formula, which "only the tail is left"
//   would not notice.
// - Array formulas (MODE.MULT) were entered with Ctrl+Enter.
const { boot, settle, until, bodyText } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice('{"action":"'.length) : s;
};
const indexOf = (body, label) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label.replace(/[()]/g, '\\$&')}"`).exec(bodyText(body))?.[1]);
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const URL_ = 'https://simnet.mheducation.com/exam';
const grid = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'].concat(Array.from({ length: 60 }, (_, i) => `E${i + 1}`))
  .map(a => `<td class="grdbdy-cell" id="cell-${a}" tabindex="0"></td>`).join('');

(async () => {
  // ── The window's own buttons are not offered ─────────────────────────────
  {
    const p = boot(`<body><div role="main"><p>Open the Evaluate Formula dialog.</p>
      <div class="header"><button aria-label="minimizeButton"></button><button aria-label="restoreButton"></button><button aria-label="closeButton"></button></div>
      <button aria-label="Evaluate Formula">Evaluate Formula</button><button>Close</button>
      <table><tr>${grid}</tr></table></div></body>`, { installLayout: flat, url: URL_, reply: 'x' });
    const r = await p.scrape();
    const names = r.elements.map(e => e.text);
    check('minimize, restore and close of the Excel window are not in the list', !names.some(n => /^(minimize|restore|close)Button$/.test(n)), names.join(' | '));
    check('  while a dialog\'s own Close button still is', names.includes('Close') && names.includes('Evaluate Formula'), names.join(' | '));
  }

  // ── Empty fields are absent fields ───────────────────────────────────────
  {
    const p = boot(`<body><div role="main"><p>Click Home.</p><button class="shell-btn" aria-label="Home">Home</button>
      <table><tr>${grid}</tr></table></div></body>`, {
      installLayout: flat, url: URL_, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: (b, n) => n === 1
        ? as(b, { action: 'click', index: indexOf(b, 'Home'), cell: '', from: '', to: '', text: '', column: '', row: 0, key: null })
        : as(b, { action: 'none' })
    });
    let clicked = false;
    p.w.document.querySelector('[aria-label="Home"]').addEventListener('click', () => { clicked = true; });
    p.pressPlay();
    const final = await settle(p);
    check('a click with "" and null in its unused fields goes through', clicked && !p.isError(), final);
  }

  // ── An editor: keys typed into it, with faults on request ────────────────
  const page = `<body><div role="main"><p>Enter a formula in cell D2 to find the section code.</p>
    <input id="fontsize" aria-label="Font Size input" value="10">
    <div id="ed" contenteditable="true" tabindex="0"></div><table><tr>${grid}</tr></table></div></body>`;
  const editor = (p, { dropParen = false } = {}) => {
    const d = p.w.document, ed = d.getElementById('ed');
    const st = { open: false, text: '', keys: [], backspaces: 0, committed: null, dropped: false, enterAt: 0, ctrlShift: false };
    p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
      if (method !== 'Input.dispatchKeyEvent') return;
      if (params.type === 'keyDown' && params.text && params.text !== '\r') {
        st.keys.push(params.text);
        if (!st.open) { st.open = true; st.text = ''; ed.focus(); }
        if (dropParen && params.text === '(' && !st.dropped) { st.dropped = true; return; }   // the "(" never arrives
        st.text += params.text;
        ed.textContent = st.text;
      } else if (params.type === 'rawKeyDown' && params.key === 'Backspace') {
        st.backspaces++; st.text = st.text.slice(0, -1); ed.textContent = st.text;
      }
    };
    d.addEventListener('keydown', e => {
      if (e.keyCode === 13 && st.open) {
        st.committed = st.text; st.enterAt = Date.now(); st.ctrlShift = !!(e.ctrlKey && e.shiftKey);
        st.open = false; ed.textContent = '';
        st.onEnter?.();
      }
    });
    return st;
  };
  const run = async (reply, opts = {}) => {
    const p = boot(opts.page ?? page, { installLayout: flat, url: URL_, storage: { lastPresetIndex: 1, autoContinue: false, keepLog: true, ...opts.storage }, reply });
    const st = editor(p, opts);
    opts.wire?.(p, st);
    p.pressPlay();
    const final = await settle(p);
    return { p, st, final };
  };
  const typeThenEnter = text => (b, n) => as(b, n === 1 ? { action: 'type', cell: 'D2', text } : n === 2 ? { action: 'key', key: 'Enter' } : { action: 'none' });

  // ── A line break on the end of a formula ─────────────────────────────────
  {
    const { st, final, p } = await run(typeThenEnter('=RIGHT(A2,2)\n'));
    check('a formula ending in a line break is typed without it', st.keys.join('') === '=RIGHT(A2,2)' && st.committed === '=RIGHT(A2,2)', `${JSON.stringify(st.keys.join(''))} / ${final}`);
  }

  // ── A "(" that never arrives ─────────────────────────────────────────────
  {
    const { st, final, p } = await run(typeThenEnter('=FV(C4/12,C2,-C3)'), { dropParen: true });
    check('a "(" dropped from the middle is noticed and put back', st.committed === '=FV(C4/12,C2,-C3)', `${JSON.stringify(st.committed)} / ${final}`);
    check('  by clearing and typing again, not by handing in the damaged one', st.backspaces > 0, `${st.backspaces} backspaces`);
  }

  // ── Another box on the page that happens to read like the end of the formula ─
  {
    const { st, final } = await run(typeThenEnter('=B1*10'));
    check('the Font Size box saying "10" is not mistaken for a formula\'s end', st.committed === '=B1*10' && st.backspaces === 0, `${JSON.stringify(st.committed)}, ${st.backspaces} backspaces`);
  }

  // ── The popup is a moment coming ─────────────────────────────────────────
  {
    const HINT = 'You answered the question incorrectly.';
    const withAttempts = page.replace('<div id="ed"', '<span id="attempts">1 of 3 Attempts</span><div id="ed"');
    let steps = 0;
    const { st, final, p } = await run((b, n) => { steps = n; return typeThenEnter('=LEFT(A2,2)')(b, n); }, {
      page: withAttempts, storage: { lastPresetIndex: 0, autoContinue: false },
      wire: (pg, s) => {
        // SIMnet grades about a second and a half after Enter
        s.onEnter = () => setTimeout(() => {
          pg.w.document.body.insertAdjacentHTML('beforeend', `<div class="modal"><h2>Incorrect</h2><p>${HINT}</p><button id="continue">Continue</button></div>`);
        }, 1500);
      }
    });
    check('the popup 1.5s after Enter is waited for, not mistaken for no result', /Marked incorrect/.test(final) || p.isError(), final);
    check('  and no more calls are spent going off to try another way: one call, Enter being pressed without asking', p.requests.length === 1, `${p.requests.length} calls`);
  }

  // ── A dialog that redraws its boxes ──────────────────────────────────────
  {
    const html = `<body><div role="main"><p>Fill the arguments.</p><div id="dlg" role="dialog">
      <label>Rate <input id="rate" type="text" aria-label="Rate"></label><label>Nper <input id="nper" type="text" aria-label="Nper"></label>
      <label>Pmt <input id="pmt" type="text" aria-label="Pmt"></label></div><table><tr>${grid}</tr></table></div></body>`;
    const p = boot(html, { installLayout: flat, url: URL_, reply: 'x' });
    const r = await p.scrape();
    const at = label => r.elements.findIndex(e => e.text === label);
    // The dialog redraws while the model is thinking: new boxes in the place of the old
    const dlg = p.w.document.getElementById('dlg');
    dlg.innerHTML = dlg.innerHTML.replace(/<input /g, '<input data-redrawn="1" ');
    const done = await p.toPage({ type: 'EXECUTE', action: { action: 'fill', fills: [{ index: at('Nper'), value: 'B4' }, { index: at('Pmt'), value: '-B2' }] } });
    const v = id => p.w.document.getElementById(id).value;
    check('boxes redrawn after the model chose them are found again, by what they say',
      done.success === true && v('nper') === 'B4' && v('pmt') === '-B2' && v('rate') === '', `${JSON.stringify(done)} ${v('nper')} ${v('pmt')}`);

    // Two boxes saying the same: the same one of them, not the first
    const html2 = `<body><div role="main"><div id="dlg">${[1, 2, 3].map(i => `<input class="a" type="text" aria-label="Value">`).join('')}</div><table><tr>${grid}</tr></table></div></body>`;
    const q = boot(html2, { installLayout: flat, url: URL_, reply: 'x' });
    const rr = await q.scrape();
    const idx = rr.elements.map((e, i) => e.text === 'Value' ? i : -1).filter(i => i >= 0);
    const box = q.w.document.getElementById('dlg');
    box.innerHTML = box.innerHTML;   // all three replaced
    const out = await q.toPage({ type: 'EXECUTE', action: { action: 'fill', fills: [{ index: idx[2], value: 'third' }] } });
    const vals = Array.from(q.w.document.querySelectorAll('input.a')).map(i => i.value);
    check('  with three alike, the third one is still the third', out.success === true && vals.join() === ',,third', `${JSON.stringify(out)} ${vals}`);

    // An element that is really gone is still reported as gone
    const gone = await (async () => {
      const g = boot(`<body><div role="main"><input id="x" type="text" aria-label="Only"><table><tr>${grid}</tr></table></div></body>`, { installLayout: flat, url: URL_, reply: 'x' });
      const rg = await g.scrape();
      const i = rg.elements.findIndex(e => e.text === 'Only');
      g.w.document.getElementById('x').remove();
      return g.toPage({ type: 'EXECUTE', action: { action: 'fill', fills: [{ index: i, value: 'v' }] } });
    })();
    check('  one that has really gone is still said to be gone', gone.success === false && /left the page|no longer/.test(gone.error ?? ''), JSON.stringify(gone));
  }

  // ── Array formulas ───────────────────────────────────────────────────────
  {
    const p = boot(page, { installLayout: flat, url: URL_, reply: 'x' });
    const { run: _ } = { run };
    const first = await run(typeThenEnter('=MODE.MULT(D2:D14)'));
    const system = first.p.requests[0]?.system ?? '';
    check('the SIMnet prompt says array formulas are Ctrl+Shift+Enter', /Ctrl\+Shift\+Enter/.test(system) && /no line break/.test(system), system.slice(-600));
    check('  and never to click the window\'s Close', /Never click the window's own Close/.test(system));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll second-SIMnet-log checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
