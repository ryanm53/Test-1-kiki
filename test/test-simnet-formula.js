// A real SIMnet log, 8 formulas, 7 of them graded wrong though every one was the
// right formula. SIMnet's own report of what was done said why:
//
//   "typed =RIG in cell D2, typed HT(A2,2) in cell D2, and pressed Enter"
//
// The list of function names that opens after "=RIG", and the argument hint that
// opens after "(", reset SIMnet's editor, and what had been typed before them was
// gone: the cell held "HT(A2,2)". The one formula that came out right was typed in
// one chunk. So a formula is typed in stages, each looked at before the next; text
// that has gone is typed again; failing that the cell is cancelled and tried
// another way; and Enter is never pressed on a formula known to be damaged.
//
// The page below is a SIMnet editor with that fault, switched on as each case needs.
const { boot, settle, until } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice(PREFIX.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const FORMULA = '=RIGHT(A2,2)';
const LONG = '=SUMIFS(JunePrices,JunePOs,D1,JuneCompanies,"Salon Supplies")';

const cells = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'].concat(Array.from({ length: 60 }, (_, i) => `E${i + 1}`))
  .map(a => `<td class="grdbdy-cell" id="cell-${a}" tabindex="0"></td>`).join('');
const page = editable => `<body><div role="main">
  <p>Enter a formula in cell D2 to find the section code by extracting the last two letters of the class/section code in cell A2.</p>
  <button class="shell-btn" aria-label="Home">Home</button>
  <input id="namebox" value="D2" aria-label="Name Box">
  <div id="ed" ${editable ? 'contenteditable="true" tabindex="0"' : ''} aria-label="Formula bar"></div>
  <table><tr>${cells}</tr></table></div></body>`;

// The editor. fault: 'none'; 'once' — each popup (the names list, the argument
// hint) resets it the first time it opens; 'always' — every time it opens, for
// typed keys (inserted text doesn't open one); 'everything' — nothing works.
// A popup opens 100ms after the key that calls it.
function editor(p, fault, { editable = true } = {}) {
  const d = p.w.document, ed = d.getElementById('ed'), cell = d.getElementById('cell-D2');
  const st = { open: false, text: '', shown: new Set(), keys: [], escapes: 0, backspaces: 0, inserts: [], committed: null };
  const show = () => { ed.textContent = st.open ? st.text : ''; };
  const popup = kind => setTimeout(() => {
    const first = !st.shown.has(kind);
    st.shown.add(kind);
    if (fault === 'always' || fault === 'everything' || (fault === 'once' && first)) { st.text = ''; show(); }
  }, 100);
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.insertText') {
      st.inserts.push(params.text);
      if (st.open) st.text += params.text;
      if (fault === 'everything') popup('list');
      show();
      return;
    }
    if (method !== 'Input.dispatchKeyEvent') return;
    if (params.type === 'keyDown' && params.text && params.text !== '\r') {
      st.keys.push(params.text);
      if (!st.open) { st.open = true; st.text = ''; if (editable) ed.focus(); }
      st.text += params.text;
      if (st.text.length === 3 && st.text[0] === '=') popup('list');
      if (params.text === '(') popup('hint');
      show();
    } else if (params.type === 'rawKeyDown' && params.key === 'Backspace') {
      st.backspaces++;
      st.text = st.text.slice(0, -1);
      show();
    } else if (params.type === 'rawKeyDown' && params.key === 'Escape') {
      st.escapes++;
      st.open = false; st.text = '';
      show();
    }
  };
  // The model's Enter reaches the page as a key event: it commits what is in the editor
  d.addEventListener('keydown', e => {
    if (e.keyCode === 13 && st.open) { st.committed = st.text; cell.textContent = st.text; st.open = false; show(); }
  });
  return st;
}

const run = async (formula, fault, opts) => {
  const p = boot(page(opts?.editable !== false), {
    installLayout: flat, url: 'https://simnet.mheducation.com/exam', storage: { lastPresetIndex: 1, autoContinue: false, keepLog: true },
    reply: (b, n) => as(b, n === 1 ? { action: 'type', cell: 'D2', text: formula } : n === 2 ? { action: 'key', key: 'Enter' } : { action: 'none' })
  });
  const st = editor(p, fault, opts);
  p.pressPlay();
  const final = await settle(p);
  await until(() => p.store.answerLog?.length > 0, 8000);
  return { p, st, final, log: p.store.answerLog?.[0] };
};

(async () => {
  // ── No fault: typed once, exactly, nothing repaired ──────────────────────
  {
    const { st, final, p } = await run(FORMULA, 'none');
    check('no fault: the formula is in the cell exactly', st.committed === FORMULA, JSON.stringify(st.committed));
    check('  with nothing cleared or cancelled on the way', st.backspaces === 0 && st.escapes === 0 && st.keys.join('') === FORMULA, `${st.backspaces} backspaces, ${st.escapes} escapes, typed ${st.keys.join('')}`);
    check('  and no error', !p.isError(), final);
  }

  // ── The real fault: each popup wipes the editor the first time ───────────
  for (const [name, formula] of [['short', FORMULA], ['long, with quotes and names', LONG]]) {
    const { st, final, p, log } = await run(formula, 'once');
    check(`popups wipe the editor (${name}): the formula still lands whole`, st.committed === formula, JSON.stringify(st.committed));
    check('  it was noticed and put back, not cancelled', st.backspaces > 0 && st.escapes === 0, `${st.backspaces} backspaces, ${st.escapes} escapes`);
    check('  one call to the model for it, not a retry', p.requests.length >= 1 && p.requests.filter(r => !/ALREADY done/.test(JSON.stringify(r.messages))).length === 1, `${p.requests.length} calls`);
    check('  and the log says how it went', log?.typing?.[0]?.trail?.[0]?.way === 'keys' && log.typing[0].trail[0].ok === true && log.typing[0].trail[0].repaired > 0, JSON.stringify(log?.typing));
    check('  no error in the bar', !p.isError(), final);
  }

  // ── Typed keys keep failing: cancelled, "=" typed, the rest inserted whole ─
  {
    const { st, final, p, log } = await run(LONG, 'always');
    check('typed keys always wiped: the formula still lands whole', st.committed === LONG, JSON.stringify(st.committed));
    check('  by cancelling the cell and inserting the rest in one piece', st.escapes === 1 && st.inserts.join('') === LONG.slice(1), `${st.escapes} escapes, inserts ${JSON.stringify(st.inserts)}`);
    check('  the log has both ways: keys failed, inserted worked',
      log?.typing?.[0]?.trail?.map(t => `${t.way}:${t.ok}`).join() === 'keys:false,inserted:true', JSON.stringify(log?.typing?.[0]?.trail));
    check('  no error', !p.isError(), final);
  }

  // ── Nothing works: said so, and Enter is never pressed on garbage ────────
  {
    const { st, final, p } = await run(FORMULA, 'everything');
    check('nothing works: the bar says so, with what was wanted', p.isError() && /kept losing/.test(final) && final.includes(FORMULA), final);
    check('  nothing was committed to the cell', st.committed === null, JSON.stringify(st.committed));
    check('  the run stopped there, with no retry spending calls', p.requests.length === 1, `${p.requests.length} calls`);
    check('  and the editor was cancelled, not left holding half a formula', st.escapes >= 1 && !st.open, `${st.escapes} escapes, open ${st.open}`);
  }

  // ── An editor that can't be read: typed as before, not blocked ───────────
  {
    const { st, final, p } = await run(FORMULA, 'none', { editable: false });
    check('an editor that cannot be read from the page: typed through, as before', st.committed === FORMULA && !p.isError() && st.escapes === 0, `${JSON.stringify(st.committed)} / ${final}`);
  }

  // ── Plain values are left alone ──────────────────────────────────────────
  {
    const p = boot(page(true), {
      installLayout: flat, url: 'https://simnet.mheducation.com/exam', storage: { lastPresetIndex: 1, autoContinue: false },
      reply: (b, n) => as(b, n === 1 ? { action: 'type', cell: 'D2', text: '42' } : { action: 'none' })
    });
    const st = editor(p, 'none');
    p.pressPlay();
    await settle(p);
    check('a plain value is typed as it always was, with nothing read back', st.keys.join('') === '42' && !p.pageMessages.some(m => m.type === 'READ_EDIT'), `${st.keys.join('')}`);
  }

  // ── What the page reports ─────────────────────────────────────────────────
  {
    const p = boot(`<body><div role="main"><input id="namebox" value="D2"><div id="ed" contenteditable="true" tabindex="0">HT(A2,2)</div></div></body>`,
      { installLayout: flat, reply: 'x' });
    const ask = expect => p.toPage({ type: 'READ_EDIT', expect });
    check('READ_EDIT: the editor holds exactly this', (await ask('HT(A2,2)')).match === true);
    const lost = await ask('=RIGHT(A2,2)');
    check('  it holds only the end of it: damage, and what is left', lost.match === false && lost.have === 'HT(A2,2)', JSON.stringify(lost));
    const name = await ask('=B1+D2');
    check('  the Name Box showing "D2" is not taken for the end of a formula', name.match === false && name.have === null, JSON.stringify(name));
    const none = await ask('=SUM(B1:B9)');
    check('  nothing that looks like it: cannot tell, and says so', none.match === false && none.have === null, JSON.stringify(none));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll SIMnet formula checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
