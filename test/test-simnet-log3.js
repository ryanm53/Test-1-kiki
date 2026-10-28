// A third SIMnet log (101 runs; Connect almost all right, 32 formulas typed whole,
// 14 of them repaired on the way), and what still went wrong in it:
//
// - "Enter a formula in the selected cell": the model names no cell, and typing
//   with nothing named and nothing open was refused ("Nothing is being edited
//   to type into") — four runs. SIMnet marks the cell selected, and the list
//   shows it "(selected)"; typing now goes there, as Excel's does.
// - An array formula's results block is selected for you (G1:G3). Naming G1 clicked
//   it, which shrinks the selection to one cell; a click on one cell of a selected
//   block is now left out.
// - The model sent Ctrl+Enter for an array formula, twice, with SIMnet's own hint
//   saying Ctrl+Shift+Enter. In an array formula's context the shift is added.
// - It typed =SOYD, which isn't a function (SYD is), and =RANK for a task that
//   wanted RANK.EQ; and took one dialog box a reply and ran out of steps.
const { boot, settle, until, bodyText } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice('{"action":"'.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const URL_ = 'https://simnet.mheducation.com/exam';

const page = (task, selected = []) => {
  const names = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'G3'].concat(Array.from({ length: 60 }, (_, i) => `H${i + 1}`));
  return `<body><div role="main"><p>${task}</p><div id="ed" contenteditable="true" tabindex="0"></div>
    <table><tr>${names.map(a => `<td class="grdbdy-cell${selected.includes(a) ? ' selected' : ''}" id="cell-${a}" tabindex="0"></td>`).join('')}</tr></table></div></body>`;
};

function editor(p) {
  const d = p.w.document, ed = d.getElementById('ed');
  const st = { open: false, text: '', keys: [], clicks: [], enters: [], committed: null };
  d.querySelectorAll('td').forEach(td => td.addEventListener('mousedown', () => st.clicks.push(td.id.slice(5))));
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.text && params.text !== '\r') {
      st.keys.push(params.text);
      if (!st.open) { st.open = true; st.text = ''; ed.focus(); }
      st.text += params.text; ed.textContent = st.text;
    }
  };
  d.addEventListener('keydown', e => {
    if (e.keyCode === 13) {
      st.enters.push({ ctrl: e.ctrlKey, shift: e.shiftKey });
      if (st.open) { st.committed = st.text; st.open = false; ed.textContent = ''; }
    }
  });
  return st;
}
const run = async (html, reply) => {
  const p = boot(html, { installLayout: flat, url: URL_, storage: { lastPresetIndex: 1, autoContinue: false }, reply });
  const st = editor(p);
  p.pressPlay();
  const final = await settle(p);
  return { p, st, final };
};
const typeThenEnter = (text, extra = {}) => (b, n) => as(b, n === 1 ? { action: 'type', text, ...extra } : n === 2 ? { action: 'key', key: 'Enter' } : { action: 'none' });

(async () => {
  // ── "In the selected cell": no cell named ────────────────────────────────
  {
    const { st, final, p } = await run(page('Enter a formula in the selected cell using AVERAGEIFS to calculate the average expense.', ['F2']), typeThenEnter('=AVERAGE(D2:D14)'));
    check('with no cell named, the formula goes into the selected one', st.committed === '=AVERAGE(D2:D14)' && !p.isError(), `${JSON.stringify(st.committed)} / ${final}`);
    check('  without clicking anything', st.clicks.length === 0, st.clicks.join());
  }

  // ── Nothing selected and nothing named: still refused, as before ─────────
  {
    const { st, final, p } = await run(page('Enter a formula somewhere.'), b => as(b, { action: 'type', text: '=A1' }));   // the same mistake on the retry too
    check('with nothing selected and no cell named: still refused, not typed anywhere', p.isError() && /Nothing is being edited/.test(final) && st.keys.length === 0, `${final} / ${st.keys.join('')}`);
  }

  // ── A selected block for an array formula stays a block ──────────────────
  {
    const { st, final, p } = await run(page('Enter an array formula in cells G1:G3 to display the three mode values. The results array has been selected for you.', ['G1', 'G2', 'G3']),
      typeThenEnter('=MODE.MULT(D2:D14)', { cell: 'G1' }));
    check('naming G1 in a selected G1:G3 does not click it', st.clicks.length === 0 && st.committed === '=MODE.MULT(D2:D14)', `clicks ${st.clicks}, ${JSON.stringify(st.committed)} / ${final}`);

    // a cell outside the selection is still clicked, as always
    const other = await run(page('Enter a formula in cell D2.', ['F2']), typeThenEnter('=A1', { cell: 'D2' }));
    check('  a cell outside the selection is still clicked first', other.st.clicks.join() === 'D2' && other.st.committed === '=A1', `${other.st.clicks} ${JSON.stringify(other.st.committed)}`);
  }

  // ── Ctrl+Enter for an array formula becomes Ctrl+Shift+Enter ─────────────
  {
    const send = text => (b, n) => as(b, n === 1 ? { action: 'type', text } : n === 2 ? { action: 'key', key: 'Enter', ctrl: true } : { action: 'none' });
    const arr = await run(page('Enter an array formula in cells G1:G3 to display the three mode values. The results array has been selected for you.', ['G1', 'G2', 'G3']), send('=MODE.MULT(D2:D14)'));
    check('an array formula\'s Ctrl+Enter reaches the page as Ctrl+Shift+Enter', arr.st.enters.at(-1)?.ctrl === true && arr.st.enters.at(-1)?.shift === true, JSON.stringify(arr.st.enters));
    const plain = await run(page('Enter a formula in the selected cell.', ['F2']), send('=A1'));
    check('  but not on an ordinary task', plain.st.enters.at(-1)?.ctrl === true && plain.st.enters.at(-1)?.shift === false, JSON.stringify(plain.st.enters));
  }

  // ── What the prompt says ─────────────────────────────────────────────────
  {
    const { p } = await run(page('Enter a formula in cell D2.'), typeThenEnter('=A1', { cell: 'D2' }));
    const sys = p.requests[0]?.system ?? '';
    check('the SIMnet prompt gives the current function names', /RANK\.EQ \(not RANK\)/.test(sys) && /SYD for sum-of-the-years' digits \(not SOYD\)/.test(sys), sys.slice(-900));
    check('  says a dialog\'s boxes go in one fill', /filled in ONE reply/.test(sys));
    check('  and what "in the selected cell" and an array block mean', /In the selected cell/.test(sys) && /NO "cell"/.test(sys));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll third-SIMnet-log checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
