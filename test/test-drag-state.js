// A Connect matching question got one card moved, and then no further: the cards were
// listed by their words alone, so after a move the page read the same, and nothing
// said which boxes there were or where a card now sat. Now each card says which list
// it is in and its place there, the lists are summed up (empty or holding what), "done"
// with cards still in the pool is not accepted, and a drag gets more steps.
//
// And "keeps getting it wrong over and over": for questions that aren't ticking
// choices (cards, dropdowns), what Connect shows under "Correct Answer" is kept as
// words, and given to the model the next time that question comes up.
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
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const oneQuestion = { lastPresetIndex: 1, autoContinue: false };
const card = id => `data-rfd-drag-handle-draggable-id="${id}" data-rfd-draggable-id="${id}" tabindex="0"`;

const MORE = 'Normally payable more than one year from now';
const WITHIN = 'Normally payable within one year';
const PAGE = `<body><div id="app">
  <h2>Matching Question</h2><p>Match the classification with the correct description.</p>
  <div class="row"><div class="label">Current liability</div><div class="zone" id="z1" data-rfd-droppable-id="z1"></div></div>
  <div class="row"><div class="label">Long-term liability</div><div class="zone" id="z2" data-rfd-droppable-id="z2"></div></div>
  <div class="pool" id="pool" data-rfd-droppable-id="pool">
    <div class="card" ${card('a')}>${MORE}</div>
    <div class="card" ${card('b')}>${WITHIN}</div>
  </div>
  <button aria-label="High Confidence">High</button><button>Medium</button><button>Low</button>
</div></body>`;

// A keyboard that moves cards the way the library does: Space lifts, an arrow moves it to
// the list above or below, Space drops it
function keyboard(p) {
  const d = p.w.document, state = { lifted: null, moves: [] };
  const order = () => ['z1', 'z2', 'pool'].map(id => d.getElementById(id));
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method !== 'Input.dispatchKeyEvent' || params.type === 'keyUp') return;
    const el = d.activeElement?.closest?.('[data-rfd-draggable-id]');
    if (params.key === ' ') {
      if (state.lifted) { state.lifted = null; return; }
      if (el) state.lifted = { el, from: el.parentElement };
      return;
    }
    if (state.lifted && /^Arrow/.test(params.key)) {
      const lists = order(), at = lists.indexOf(state.lifted.el.parentElement);
      const to = lists[at + (params.key === 'ArrowUp' ? -1 : params.key === 'ArrowDown' ? 1 : 0)];
      if (to) { to.appendChild(state.lifted.el); state.lifted.el.focus(); state.moves.push(params.key); }
    }
  };
  return state;
}

// A model that reads where the cards are, as it now can
const model = (b, n) => {
  const t = bodyText(b);
  const line = text => new RegExp(`\\[(\\d+)\\][^\\n]*"${text}[^\\n]*\\(in the pool`).exec(t);
  const w = line('Normally payable within one year'), m = line('Normally payable more than');
  if (w) return as(b, { action: 'dragMove', index: Number(w[1]), dir: 'up', steps: 2 });
  if (m) return as(b, { action: 'dragMove', index: Number(m[1]), dir: 'up', steps: 1 });
  return as(b, { action: 'none' });
};

(async () => {
  // ── What a card says about where it is ────────────────────────────────────
  {
    const p = boot(PAGE, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: 'x' });
    const r = await p.scrape();
    const cards = r.elements.filter(e => /payable/.test(e.text));
    check('each card says which list it is in, and its place there',
      cards.length === 2 && cards.every(c => /^in the pool, place [12] of 2$/.test(c.place)), JSON.stringify(cards.map(c => c.place)));
    check('the lists are summed up: each box by its label, empty, and the pool with what it holds',
      /"Current liability" \(empty\)/.test(r.dragZones) && /"Long-term liability" \(empty\)/.test(r.dragZones)
        && /the pool \(holds "Normally payable more than one year from now", "Normally payable within one year"\)/.test(r.dragZones), r.dragZones);
    check('  and says to put every card in a box, and to try another way if a move changed nothing',
      /Put every card in the area it belongs to/.test(r.dragZones) && /same place after a move/.test(r.dragZones));
    check('  two cards are left in the pool while two boxes are empty', r.dragLeft === 2, String(r.dragLeft));

    const plain = boot('<body><div role="main"><p>Pick one.</p><input type="radio" aria-label="Yes"><input type="radio" aria-label="No"></div></body>', { installLayout: flat, url: CONNECT, reply: 'x' });
    const q = await plain.scrape();
    check('a page with no cards has none of it', q.dragZones === undefined && q.dragLeft === undefined && q.elements.every(e => !('place' in e)));

    // a reorder list: one list, no label, no "pool"
    const one = boot(`<body><div><p>Put these in order.</p><div data-rfd-droppable-id="l"><div ${card('a')}>First</div><div ${card('b')}>Second</div></div></div></body>`,
      { installLayout: flat, url: CONNECT, reply: 'x' });
    const o = await one.scrape();
    check('a single list to reorder: its cards are placed 1 of 2 and 2 of 2, and nothing is called unplaced',
      o.elements.map(e => e.place).join('|') === 'in list 1, place 1 of 2|in list 1, place 2 of 2' && o.dragLeft === 0, `${o.elements.map(e => e.place)} ${o.dragLeft}`);
  }

  // ── Every card is placed, over several moves ─────────────────────────────
  {
    const p = boot(PAGE, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: model });
    const keys = keyboard(p);
    p.pressPlay();
    const final = await settle(p, 60000);
    const d = p.w.document;
    const at = id => d.getElementById(id).textContent.trim();
    check('both cards end up in their boxes', at('z1') === WITHIN && at('z2') === MORE && at('pool') === '', `z1=${at('z1')} z2=${at('z2')} pool=${at('pool')} / ${final}`);
    check('  in three calls: a move, a move, then done', p.requests.length === 3, `${p.requests.length} calls`);
    check('  and the third call showed the cards where they now are',
      /"Normally payable within one year" \(in "Current liability", place 1 of 1\)/.test(bodyText(p.requests[2])) || /Normally payable within one year" \(in "Current liability"/.test(bodyText(p.requests[2])), bodyText(p.requests[2]).split('Elements')[1]?.slice(0, 300));
    check('  with the real keys that lift, move and drop each card', keys.moves.length === 3, keys.moves.join());
    check('  and no error', !p.isError(), final);
  }

  // ── "Done" with cards in the pool is not accepted ─────────────────────────
  {
    // gives up after the first card; asked to go on, it does the second
    let nudged = false;
    const p = boot(PAGE, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => {
      const t = bodyText(b);
      if (/NOT done/.test(t)) nudged = true;
      if (n === 1) return model(b, n);
      if (!nudged) return as(b, { action: 'none' });
      return model(b, n);
    } });
    keyboard(p);
    p.pressPlay();
    const final = await settle(p, 60000);
    const d = p.w.document;
    check('"done" with a card still in the pool: told it is not done, and goes on to place it',
      nudged && d.getElementById('pool').textContent.trim() === '' && d.getElementById('z2').textContent.trim() === MORE, `${nudged} pool=${d.getElementById('pool').textContent.trim()} / ${final}`);
    check('  and the note names the number of cards left', p.requests.some(r => /1 card is still in the pool/.test(bodyText(r))));

    // ...but not forever
    const q = boot(PAGE, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => n === 1 ? model(b, n) : as(b, { action: 'none' }) });
    keyboard(q);
    q.pressPlay();
    await settle(q, 60000);
    check('  a model that keeps saying done is believed after two nudges', q.requests.length === 4, `${q.requests.length} calls`);
  }

  // ── The right answer, kept as words, for a question that isn't ticking choices ──
  {
    const GRADED = `<div id="graded"><p>Your Answer</p><div><h4>Correct Answer</h4><p>Current liability: ${WITHIN}</p><p>Long-term liability: ${MORE}</p></div></div>`;
    const withBox = PAGE.replace('</div></body>', `${GRADED}</div></body>`);
    const next = '<button class="next-button">Next Question</button>';
    const html = withBox.replace('</div></body>', `${next}</div></body>`);
    const settleUp = async p => { p.pressPlay(); const f = await settle(p, 60000); await wait(500); return f; };
    const storage = { lastPresetIndex: 0, autoContinue: false, keepLog: true };

    // First time: no note. Marked wrong; the box is kept
    const first = boot(html.replace('<div id="graded">', '<div id="graded" hidden>'), { installLayout: flat, url: CONNECT, storage, reply: model });
    keyboard(first);
    // the graded view appears once an answer is given
    const reveal = () => first.w.document.getElementById('graded')?.removeAttribute('hidden');
    first.w.document.addEventListener('keydown', reveal, true);
    first.bg.chrome.debugger.sendCommand = ((orig) => async (...a) => { await orig(...a); reveal(); })(first.bg.chrome.debugger.sendCommand);
    const firstFinal = await settleUp(first);
    await until(() => first.store.answerBook && Object.keys(first.store.answerBook).length > 0, 8000).catch(() => {});
    const entries = Object.values(first.store.answerBook ?? {});
    check('a wrong card question: the first time it is asked with no note', !first.requests.some(r => /came up before/.test(bodyText(r))));
    check('  and what Connect showed as correct is kept, as it said it',
      entries.length === 1 && /Current liability: Normally payable within one year/.test(entries[0].n ?? '') && /Long-term liability/.test(entries[0].n ?? ''), `${JSON.stringify(first.store.answerBook)} / ${firstFinal} / ${JSON.stringify(first.store.answerLog?.[0]?.verdicts)}`);

    // The same question again, with that in the book: the model is told
    const again = boot(PAGE, { installLayout: flat, url: CONNECT, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: model });
    keyboard(again);
    again.pressPlay();
    await settle(again, 60000);
    const told = bodyText(again.requests[0]);
    check('the next time that question comes up, the model is told what the right answer was',
      /This exact question came up before/.test(told) && /Current liability: Normally payable within one year/.test(told) && /Answer so that yours matches it/.test(told), told.slice(0, 300));
    check('  on every call of the run', again.requests.every(r => /came up before/.test(bodyText(r))));

    // A different arrangement of cards is a different question
    const other = boot(PAGE.replace(MORE, 'Something else entirely'), { installLayout: flat, url: CONNECT, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: 'x' });
    other.pressPlay();
    await settle(other, 20000);
    check('a question with other cards gets no such note', !other.requests.some(r => /came up before/.test(bodyText(r))));

    // Turned off, nothing is kept or told
    const off = boot(PAGE, { installLayout: flat, url: CONNECT, storage: { ...oneQuestion, rememberAnswers: false, answerBook: first.store.answerBook }, reply: model });
    keyboard(off);
    off.pressPlay();
    await settle(off, 60000);
    check('with Remember them off, no note', !off.requests.some(r => /came up before/.test(bodyText(r))));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll drag-state checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
