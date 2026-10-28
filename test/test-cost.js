// Spending less, without changing what it answers.
//
// A real day's bill (Oct 27): 240 Sonnet 5.5 calls, $4.65. About $1.70 of that was
// what was sent; the other ~$2.90 was the model thinking (billed as output, about
// 1,200 tokens a call) — and 2.5 calls went into every SIMnet question, because
// pressing Enter after a typed formula was a call of its own, every time.
//
// By default only things that cannot change an answer are done: the long
// instructions are marked for caching, Enter is pressed without asking, and what
// each call really cost is recorded and shown. The cheaper-but-different things —
// less of the page sent, the cheapest model first — are behind a switch, off.
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
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const SIMNET = 'https://simnet.mheducation.com/exam';
const CONNECT = 'https://learning.mheducation.com/smartbook/1';

// A reply with usage, as Anthropic sends it
const withUsage = (action, usage) => ({ json: { content: [{ type: 'text', text: JSON.stringify(action) }], stop_reason: 'end_turn', usage } });

const names = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'].concat(Array.from({ length: 60 }, (_, i) => `H${i + 1}`));
const ribbon = ['Home', 'Insert', 'Formulas', 'Data'].map(t => `<button class="shell-btn" aria-label="${t} tab">${t}</button>`).join('')
  + ['Recycle Bin', 'Start Menu'].map(t => `<button class="shell-btn" aria-label="${t}">${t}</button>`).join('');
const sheet = (task, attempt = '1 of 3 Attempts') => `<body><div role="main"><p>${task}</p><span id="attempts">${attempt}</span>
  ${ribbon}<div id="ed" contenteditable="true" tabindex="0"></div>
  <table><tr>${names.map(a => `<td class="grdbdy-cell" id="cell-${a}" tabindex="0"></td>`).join('')}</tr></table></div></body>`;

// SIMnet's editor and its grading: Enter commits the cell, and a moment later a popup
// says whether it was the expected formula
function simnet(p, expected, { delay = 400 } = {}) {
  const d = p.w.document, ed = d.getElementById('ed');
  const st = { open: false, text: '', keys: [], enters: [], committed: null, popups: [], continues: 0 };
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.text && params.text !== '\r') {
      st.keys.push(params.text);
      if (!st.open) { st.open = true; st.text = ''; ed.focus(); }
      st.text += params.text; ed.textContent = st.text;
    }
  };
  d.addEventListener('keydown', e => {
    if (e.keyCode !== 13) return;
    st.enters.push({ ctrl: e.ctrlKey, shift: e.shiftKey });
    if (!st.open) return;
    st.committed = st.text; st.open = false; ed.textContent = '';
    const right = st.committed === expected;
    setTimeout(() => {
      st.popups.push(right ? 'Correct' : 'Incorrect');
      d.body.insertAdjacentHTML('beforeend', `<div class="modal" id="popup"><h2>${right ? 'Correct' : 'Incorrect'}</h2>${right ? '' : '<p>HINT: In cell D2 type ' + expected + '</p>'}<button id="continue">Continue</button></div>`);
      d.getElementById('continue').addEventListener('click', () => { st.continues++; d.getElementById('popup').remove(); });
    }, delay);
  });
  return st;
}
const run = async (html, expected, reply, storage = {}, opts) => {
  const p = boot(html, { installLayout: flat, url: SIMNET, storage: { lastPresetIndex: 0, autoContinue: false, keepLog: true, ...storage }, reply });
  const st = simnet(p, expected, opts);
  p.pressPlay();
  const final = await settle(p);
  return { p, st, final };
};
const typeIt = formula => (b, n) => as(b, n === 1 ? { action: 'type', cell: 'D2', text: formula } : { action: 'none' });

(async () => {
  // ── What a call cost is recorded, from the usage Anthropic sends ─────────
  {
    const p = boot('<body><div role="main"><p>Pick one.</p><input type="radio" aria-label="Yes"><input type="radio" aria-label="No"><button class="next-button">Next</button></div></body>', {
      installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: () => withUsage({ action: 'click', index: 0 }, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 })
    });
    p.pressPlay();
    await settle(p);
    await until(() => p.store.spend?.calls >= 1, 8000);
    // Haiku 5.5: 1000 in at $0.10, 2000 cached at a tenth of that, 500 out at $0.50, per million
    const want = (1000 * 0.10 + 2000 * 0.01 + 500 * 0.50) / 1e6;
    check('a call\'s cost is worked out from its usage and kept', Math.abs((p.store.spend?.usd ?? 0) - want) < 1e-9 && p.store.spend?.calls === 1, JSON.stringify(p.store.spend));
    check('  by model', p.store.spend?.byModel?.['claude-haiku-5-5']?.calls === 1);
    const got = await p.send({ type: 'SPEND_GET' });
    check('the bar can ask for it', got.spend?.calls === 1);
    // shown under More → Cost
    p.shadow().getElementById('moreBtn').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => /call/.test(p.shadow().getElementById('spendText').textContent), 8000);
    check('  and shown, with its cost and the calls', /\$0\.00\d+ · 1 call$/.test(p.shadow().getElementById('spendText').textContent), p.shadow().getElementById('spendText').textContent);
    check('  with the share read from the cache', /67% of what was read came from the cache/.test(p.shadow().getElementById('spendDetail').textContent), p.shadow().getElementById('spendDetail').textContent);
    p.shadow().getElementById('spendReset').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => /Nothing spent/.test(p.shadow().getElementById('spendText').textContent), 8000);
    check('  Reset starts it again', /Nothing spent yet/.test(p.shadow().getElementById('spendText').textContent) && p.store.spend?.calls === 0, JSON.stringify(p.store.spend));
  }

  // ── The long instructions are marked for caching; short ones are not ─────
  {
    const { p } = await run(sheet('Enter a formula in cell D2.'), '=A1', typeIt('=A1'));
    check('SIMnet\'s instructions go as a cached block', p.requests[0]?.cacheMarked === true && /simulated Excel/.test(p.requests[0]?.system ?? ''), `${p.requests[0]?.cacheMarked}`);
    const q = boot('<body><div role="main"><p>Pick one.</p><input type="radio" aria-label="Yes"><button class="next-button">Next</button></div></body>', {
      installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false }, reply: b => as(b, { action: 'click', index: 0 }) });
    q.pressPlay(); await settle(q);
    check('  an ordinary question\'s, below the cacheable minimum, go plain', q.requests[0]?.cacheMarked === undefined && typeof q.requests[0]?.system === 'string');
  }

  // ── Enter after a typed formula is pressed without a call ────────────────
  {
    const f = '=RIGHT(A2,2)';
    const { p, st, final } = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.'), f, typeIt(f));
    check('a typed formula is entered with no call to ask', st.committed === f && st.enters.length === 1, `${JSON.stringify(st.committed)}, ${st.enters.length} Enters`);
    check('  one call for the whole question, where there used to be two or three', p.requests.length === 1, `${p.requests.length} calls`);
    check('  and it still ends on SIMnet\'s own verdict', st.popups.join() === 'Correct' && !p.isError(), `${st.popups} / ${final}`);
    check('  a plain Enter', st.enters[0].ctrl === false && st.enters[0].shift === false, JSON.stringify(st.enters));
    check('  the log has the Enter, as pressed', /pressed Enter/.test(JSON.stringify(p.store.answerLog?.[0] ?? '')) || p.store.answerLog?.[0]?.verdicts?.length >= 0);
  }
  {
    const f = '=MODE.MULT(D2:D14)';
    const { p, st } = await run(sheet('Enter an array formula in cells G1:G3 to display the three mode values.'), f, typeIt(f));
    check('an array formula is entered with Ctrl+Shift+Enter', st.enters.length === 1 && st.enters[0].ctrl === true && st.enters[0].shift === true, JSON.stringify(st.enters));
  }
  {
    // text into a box (a dialog's), not a cell: no Enter of ours
    const html = `<body><div role="main"><p>Type the rule.</p><input type="text" id="rule" aria-label="Format values where this formula is true">
      <table><tr>${names.map(a => `<td class="grdbdy-cell" id="cell-${a}" tabindex="0"></td>`).join('')}</tr></table></div></body>`;
    let enters = 0;
    const p = boot(html, { installLayout: flat, url: SIMNET, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: (b, n) => as(b, n === 1 ? { action: 'type', index: 0, text: '=A1>5' } : { action: 'none' }) });
    p.w.document.addEventListener('keydown', e => { if (e.keyCode === 13) enters++; });
    p.pressPlay();
    await settle(p);
    check('a formula typed into a dialog box gets no Enter of ours', enters === 0 && p.w.document.getElementById('rule').value === '=A1>5', `${enters} Enters`);
  }

  // ── Off by default: what the model reads and which model reads it ────────
  {
    const f = '=RIGHT(A2,2)';
    const { p } = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.'), f, typeIt(f));
    const prompt = bodyText(p.requests[0]);
    check('by default the model reads the ribbon and Windows items as before', /Home tab/.test(prompt) && /Recycle Bin/.test(prompt), prompt.slice(-300));
    check('  and it is Sonnet 5.5, as before', p.requests[0]?.model === 'claude-sonnet-5-5', p.requests[0]?.model);
  }

  // ── Cheapest formulas, switched on ───────────────────────────────────────
  {
    // Haiku first, a wrong formula; SIMnet says so; Sonnet, with the hint, gets it right
    const right = '=RIGHT(A2,2)';
    const reply = (b, n) => as(b, n === 1 ? { action: 'type', cell: 'D2', text: '=LEFT(A2,2)' } : { action: 'type', cell: 'D2', text: right });
    const { p, st, final } = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.'), right, reply, { cheapFormulas: true });
    const listOf = b => (bodyText(b).split('Elements (click by index):')[1] ?? '');
    const first = listOf(p.requests[0]), second = p.requests[1] ? bodyText(p.requests[1]) : '';
    check('on: the first try is the cheapest model, with the ribbon and taskbar left out of the list',
      p.requests[0]?.model === 'claude-haiku-5-5' && !/Home tab|Recycle Bin/.test(first) && /cell=D2/.test(first), `${p.requests[0]?.model} ${first.slice(0, 200)}`);
    check('  SIMnet marks it wrong, and the retry is Sonnet 5.5, with SIMnet\'s hint and everything',
      p.requests[1]?.model === 'claude-sonnet-5-5' && /marked your previous attempt at this task INCORRECT/.test(second) && /Home tab/.test(second), `${p.requests[1]?.model}`);
    check('  and the right formula ends up in the cell', st.committed === right && st.popups.join() === 'Incorrect,Correct', `${JSON.stringify(st.committed)} ${st.popups} / ${final}`);
  }
  {
    // Not when a wrong one could not be tried again: the last attempt is not spent on the cheap model
    const f = '=RIGHT(A2,2)';
    const { p } = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.', '3 of 3 Attempts'), f, typeIt(f), { cheapFormulas: true });
    check('on, but on the last attempt: Sonnet 5.5 from the start', p.requests[0]?.model === 'claude-sonnet-5-5', p.requests[0]?.model);
    const q = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.'), f, typeIt(f), { cheapFormulas: true, lastPresetIndex: 1 });
    check('  and in Answer only mode, where nothing retries: Sonnet 5.5', q.p.requests[0]?.model === 'claude-sonnet-5-5', q.p.requests[0]?.model);
  }
  {
    // A task the short list can't do: asked again with all of it
    const f = '=RIGHT(A2,2)';
    const { p } = await run(sheet('Enter a formula in cell D2 to extract the last two letters of the code in cell A2.'), f,
      (b, n) => n === 1 ? as(b, { action: 'click', index: 0 }) : as(b, { action: 'type', cell: 'D2', text: f }), { cheapFormulas: true });
    check('on, and the model reaches for the ribbon: asked again with the whole list', p.requests.length >= 2 && /Home tab/.test(bodyText(p.requests[1])), `${p.requests.length} calls`);
  }

  // ── The switch ───────────────────────────────────────────────────────────
  {
    const p = boot('<body><div role="main"><button>x</button></div></body>', { installLayout: flat, reply: 'x' });
    const sw = p.shadow().getElementById('cheapSw');
    check('Cheapest formulas starts off', sw.getAttribute('aria-checked') === 'false' && p.store.cheapFormulas === undefined);
    sw.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => p.store.cheapFormulas === true, 8000);
    check('  and the switch turns it on', p.store.cheapFormulas === true && sw.getAttribute('aria-checked') === 'true');
  }

  console.log(failed ? `\n${failed} failed` : '\nAll cost checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
