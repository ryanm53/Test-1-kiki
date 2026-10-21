// Connect, after the answer is in: getting to the next question, and
// remembering what the right answer was.
//
// A wrong answer greys out Next Question and says "Select a concept resource to
// continue." Opening one ("Read About the Concept") shows the reading, with a
// To Questions / Back to Questions button at the top right; only once back does
// Next work. Before this, the run went looking for Next, found it greyed out,
// and stopped with "Button not found after 5s".
//
// The page below is a small working copy of that: it renders what a state
// calls for, and answers clicks the way Connect does. The right answer, which
// the page shows after a wrong one, is what the memory keeps.
const { boot, settle, until, bodyText } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice(PREFIX.length) : s;
};
const indexOf = (body, label) =>
  Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label.replace(/[$()]/g, '\\$&')}"`).exec(bodyText(body))?.[1]);
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };

const QS = [
  { q: 'Which of the following is a contra-asset account?',
    c: ['Accounts Receivable', 'Allowance for Doubtful Accounts', 'Sales Revenue', 'Bad Debt Expense'], right: [1] },
  { q: 'Which of the following are current liabilities? Select all that apply.', multi: true,
    c: ['Accounts Payable', 'Land', 'Wages Payable', 'Equipment'], right: [0, 2] },
  { q: 'Which statement reports revenues and expenses for a period of time?',
    c: ['Balance sheet', 'Income statement', 'Statement of cash flows', 'Statement of retained earnings'], right: [1] }
];
const PAGE = '<body><div id="app"></div></body>';

// What Connect does, in a few lines. Options: backLabel, resource (the label of
// the concept resource), clarify (the AI Reader button too), inline (the
// reading opens in place and Next frees up, with no way back to press),
// soft (Next is greyed by its class alone, so a press does nothing but doesn't
// refuse), noNext (no Next anywhere), order (the choices shuffled)
function connect(w, o = {}) {
  const doc = w.document, app = doc.getElementById('app');
  const st = { n: o.start ?? 0, picked: [], graded: false, read: false, view: 'q', order: o.order ?? null, events: [], shot: false };
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const render = () => {
    const q = QS[st.n % QS.length];
    const order = st.order ?? q.c.map((_, i) => i);
    const wrong = st.graded && !same(st.picked, q.right);
    const gated = wrong && !st.read && o.gate !== false;
    if (st.view === 'reading') {
      app.innerHTML = `<div role="main"><button id="back">${o.backLabel ?? 'To Questions'}</button><h2>Concept: allowance method</h2><p>The allowance method estimates uncollectible accounts at the end of each period.</p></div>`;
      return;
    }
    app.innerHTML = `<div role="main"><h2>${q.multi ? 'Multiple Select Question' : 'Multiple Choice Question'}</h2>
      <div class="prompt">${q.q}</div>
      ${order.map(i => `<div><input type="${q.multi ? 'checkbox' : 'radio'}" name="mc" id="c${i}" aria-label="${q.c[i]}" ${st.picked.includes(i) ? 'checked' : ''} ${st.graded ? 'disabled' : ''}></div>`).join('')}
      ${st.graded ? '' : '<button aria-label="High Confidence">High</button><button aria-label="Medium Confidence">Medium</button><button aria-label="Low Confidence">Low</button>'}
      ${st.graded ? `<div class="result"><span>Your Answer</span> <span class="pill">${wrong ? 'incorrect' : 'correct'}</span></div>` : ''}
      ${wrong ? `<div class="box"><h4>Correct Answer</h4>${q.right.map(i => `<div>${q.c[i]}</div>`).join('')}</div>` : ''}
      ${gated ? `<p>Select a concept resource to continue.</p>${o.clarify === false ? '' : '<button>Clarify with AI Reader</button>'}<button>${o.resource ?? 'Read About the Concept'}</button>` : ''}
      ${o.noNext ? '' : `<button class="next-button ${gated && o.soft ? 'disabled' : ''}" ${gated && !o.soft ? 'disabled' : ''}>Next Question</button>`}
      <button>Submit Assignment</button></div>`;
  };
  doc.addEventListener('click', e => {
    const t = e.target;
    if (!app.contains(t)) return;
    const q = QS[st.n % QS.length];
    if (t.matches('input')) {
      const i = Number(t.id.slice(1));
      st.picked = q.multi ? (st.picked.includes(i) ? st.picked.filter(x => x !== i) : [...st.picked, i]) : [i];
      return;
    }
    const b = t.closest('button');
    if (!b) return;
    const label = b.innerText.trim() || b.getAttribute('aria-label');
    if (/Confidence/.test(b.getAttribute('aria-label') ?? '')) { st.graded = true; render(); return; }
    if (label === (o.resource ?? 'Read About the Concept')) {
      st.events.push('resource'); st.read = true; st.view = o.inline ? 'q' : 'reading'; render(); return;
    }
    if (b.id === 'back') { st.events.push('back'); st.view = 'q'; render(); return; }
    if (label === 'Submit Assignment') { st.events.push('SUBMIT'); return; }
    if (b.classList.contains('next-button')) {
      const q2 = QS[st.n % QS.length];
      if (st.graded && !same(st.picked, q2.right) && !st.read && o.gate !== false) return;   // refused
      st.events.push('next'); st.n++; st.picked = []; st.graded = false; st.read = false; st.order = o.nextOrder ?? null; render();
    }
  });
  render();
  return { st, render, prompt: () => doc.querySelector('.prompt')?.textContent ?? '', checked: () => [...doc.querySelectorAll('input:checked')].map(i => i.getAttribute('aria-label')) };
}

// A reply: tick these labels (by name), or answer the page-stuck question by naming a button
const answering = (labels, press) => body => {
  if (/already been answered and graded/.test(bodyText(body))) {
    return as(body, press ? { action: 'click', index: indexOf(body, press) } : { action: 'none' });
  }
  return labels.length === 1
    ? as(body, { action: 'click', index: indexOf(body, labels[0]) })
    : as(body, { action: 'clickMany', indexes: labels.map(l => indexOf(body, l)) });
};
const book = p => p.store.answerBook ?? {};
const entries = p => Object.values(book(p));

(async () => {
  // ── A right answer: Next, and nothing out of the ordinary ───────────────
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Allowance for Doubtful Accounts']) });
    const c = connect(p.w);
    p.pressPlay();
    const final = await settle(p);
    check('a right answer goes straight on to the next question', c.st.events.join() === 'next' && !p.isError(), `${c.st.events} / ${final}`);
    check('and is remembered, as the choice that was right', entries(p).length === 1 && entries(p)[0].a.join() === 'allowance for doubtful accounts', JSON.stringify(book(p)));
  }

  // ── A wrong answer: the concept resource, then back, then Next ──────────
  for (const back of ['To Questions', 'Back to Questions']) {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    const c = connect(p.w, { backLabel: back });
    p.pressPlay();
    const final = await settle(p);
    check(`wrong answer, "${back}": reads the concept, comes back, presses Next`, c.st.events.join() === 'resource,back,next' && !p.isError(), `${c.st.events} / ${final}`);
    check('  and is on the next question, with one call to the model', c.prompt() === QS[1].q && p.requests.length === 1, `${c.prompt()} / ${p.requests.length}`);
    check('  and remembers what was right, not what it said', entries(p)[0]?.a.join() === 'allowance for doubtful accounts', JSON.stringify(book(p)));
  }

  // ── The reading opens in place; Next frees up with nothing to go back to ─
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    const c = connect(p.w, { inline: true });
    p.pressPlay();
    const final = await settle(p);
    check('a resource that opens in place: Next is pressed once it frees up', c.st.events.join() === 'resource,next' && !p.isError(), `${c.st.events} / ${final}`);
  }

  // ── Next greyed by class alone: pressing it does nothing, and is noticed ─
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    const c = connect(p.w, { soft: true });
    p.pressPlay();
    const final = await settle(p);
    check('a Next that looks pressed and did nothing is not taken as moved on',
      c.st.events.join() === 'resource,back,next' && !p.isError(), `${c.st.events} / ${final}`);
  }

  // ── Only the AI Reader button, no "Read About the Concept": still moves ──
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    const c = connect(p.w, { resource: 'Clarify with AI Reader', clarify: false });
    p.pressPlay();
    const final = await settle(p);
    check('the AI Reader is a resource too, the last one tried', c.st.events.join() === 'resource,back,next' && !p.isError(), `${c.st.events} / ${final}`);
  }

  // ── A resource nobody could guess the name of: the model looks, and names it ─
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion,
      reply: answering(['Accounts Receivable'], 'Open study material') });
    const c = connect(p.w, { resource: 'Open study material', clarify: false });
    p.pressPlay();
    const final = await settle(p, 120000);
    const ask = p.requests.find(r => /already been answered and graded/.test(bodyText(r)));
    check('the model is asked what to press, with the page\'s buttons and a screenshot',
      !!ask && Array.isArray(ask.messages[0].content) && /Open study material/.test(bodyText(ask)), p.requests.length + ' calls');
    check('  and is told never to submit or leave', /Never choose Submit, Finish, Exit/.test(bodyText(ask)));
    check('  and what it names is pressed, then back, then Next', c.st.events.join() === 'resource,back,next' && !p.isError(), `${c.st.events} / ${final}`);
  }

  // ── The model names Submit: not pressed ─────────────────────────────────
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion,
      reply: answering(['Accounts Receivable'], 'Submit Assignment') });
    const c = connect(p.w, { resource: 'Open study material', clarify: false });
    p.pressPlay();
    const final = await settle(p, 120000);
    check('Submit is never pressed, whatever the model says', !c.st.events.includes('SUBMIT'), c.st.events.join());
    check('  and the bar says what it could not do, and what was on the page',
      p.isError() && /Could not get to the next question/.test(final) && /Open study material/.test(final) && /Click Next yourself/.test(final), final);
  }

  // ── No Next at all: the error is something to act on ────────────────────
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable'], null) });
    connect(p.w, { noNext: true });
    p.pressPlay();
    const final = await settle(p, 120000);
    check('no Next anywhere: an error that names what it tried and saw',
      p.isError() && /Could not get to the next question/.test(final) && /Read About the Concept/.test(final), final);
  }

  // ── Not Connect: no model fallback, and the plain error ────────────────
  {
    const p = boot(PAGE, { url: 'https://example.edu/quiz', installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable'], 'Open study material') });
    connect(p.w, { noNext: true });
    p.pressPlay();
    const final = await settle(p, 120000);
    check('off Connect, nothing is spent finding a way on', p.requests.length === 1 && p.isError() && /Could not get to the next question/.test(final), `${p.requests.length} calls / ${final}`);
  }

  // ── Remembered: the same question again, choices in another order ───────
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(first.w);
    first.pressPlay();
    await settle(first);
    const kept = first.store.answerBook;

    const second = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, answerBook: kept }, reply: () => { throw new Error('the model should not be asked'); } });
    const c = connect(second.w, { order: [3, 1, 2, 0] });
    second.pressPlay();
    const final = await settle(second);
    check('asked again, shuffled: answered from memory, without a call to the model', second.requests.length === 0, `${second.requests.length} calls`);
    check('  with the choice that was right', c.checked().join() === 'Allowance for Doubtful Accounts' || c.st.events.includes('next'), c.checked().join());
    check('  and moved on, and the bar says so', c.st.events.join() === 'next' && /remembered/.test(final), `${c.st.events} / ${final}`);
  }

  // ── A different question is not mistaken for it ─────────────────────────
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(first.w);
    first.pressPlay();
    await settle(first);
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: answering(['Income statement']) });
    connect(p.w, { start: 2 });
    p.pressPlay();
    await settle(p);
    check('a different question still goes to the model', p.requests.length === 1, `${p.requests.length} calls`);
  }

  // ── Select all that apply: both are remembered and given ────────────────
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Payable', 'Land']) });
    const c1 = connect(first.w, { start: 1 });
    first.pressPlay();
    await settle(first);
    check('a wrong select-all: the whole right set is remembered',
      entries(first)[0]?.a.slice().sort().join() === 'accounts payable,wages payable', JSON.stringify(book(first)));

    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: () => { throw new Error('no'); } });
    const c = connect(p.w, { start: 1, order: [3, 2, 1, 0] });
    const seen = [];
    p.w.document.addEventListener('click', e => { if (e.target.matches?.('input')) seen.push(e.target.getAttribute('aria-label')); }, true);
    p.pressPlay();
    await settle(p);
    check('  and given back: both ticked, nothing else', seen.slice().sort().join() === 'Accounts Payable,Wages Payable' && p.requests.length === 0, `${seen} / ${p.requests.length}`);
  }

  // ── What was remembered turned out wrong: put right ─────────────────────
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(first.w);
    first.pressPlay();
    await settle(first);
    const key = Object.keys(book(first))[0];
    // The page was changed under it: the right answer is now another one
    const bad = { [key]: { ...book(first)[key], a: ['sales revenue'] } };
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, answerBook: bad }, reply: () => { throw new Error('no'); } });
    connect(p.w);
    p.pressPlay();
    await settle(p);
    check('a remembered answer the page marks wrong is replaced by the one it shows',
      book(p)[key]?.a.join() === 'allowance for doubtful accounts', JSON.stringify(book(p)));
  }

  // ── The page doesn't say what was right: a bad memory is dropped, none is invented ─
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(first.w);
    first.pressPlay();
    await settle(first);
    const key = Object.keys(book(first))[0];
    const bad = { [key]: { ...book(first)[key], a: ['sales revenue'] } };
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, answerBook: bad }, reply: () => { throw new Error('no'); } });
    const c = connect(p.w);
    // The box lists something that is none of the page's choices
    const hide = () => { const box = p.w.document.querySelector('.box'); if (box && !/textbook/.test(box.textContent)) box.innerHTML = '<h4>Correct Answer</h4><div>See your textbook</div>'; };
    new p.w.MutationObserver(hide).observe(p.w.document.getElementById('app'), { childList: true, subtree: true });
    p.pressPlay();
    await settle(p);
    check('when the page does not say, the wrong memory is forgotten and nothing is made up', !(key in book(p)) && c.st.events.includes('next'), JSON.stringify(book(p)));
  }

  // ── Switched off: nothing learned, nothing recalled ─────────────────────
  {
    const first = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, rememberAnswers: false }, reply: answering(['Accounts Receivable']) });
    connect(first.w);
    first.pressPlay();
    await settle(first);
    check('with the memory off, nothing is kept', entries(first).length === 0, JSON.stringify(book(first)));

    const kept = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(kept.w);
    kept.pressPlay();
    await settle(kept);
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: { ...oneQuestion, rememberAnswers: false, answerBook: kept.store.answerBook }, reply: answering(['Allowance for Doubtful Accounts']) });
    connect(p.w);
    p.pressPlay();
    await settle(p);
    check('  and nothing is recalled either', p.requests.length === 1, `${p.requests.length} calls`);
  }

  // ── Only on Connect ─────────────────────────────────────────────────────
  {
    const p = boot(PAGE, { url: 'https://example.edu/quiz', installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(p.w);
    p.pressPlay();
    await settle(p);
    check('on another site, nothing is kept', entries(p).length === 0, JSON.stringify(book(p)));
  }

  // ── The memory: counting, clearing, and its limit ───────────────────────
  {
    const p = boot(PAGE, { url: CONNECT, installLayout: flat, storage: oneQuestion, reply: answering(['Accounts Receivable']) });
    connect(p.w);
    p.pressPlay();
    await settle(p);
    check('the bar can ask how many are remembered', (await p.send({ type: 'BOOK_COUNT' })).count === 1);

    await p.bg.changeBook(b => { for (let i = 0; i < 805; i++) b['k' + i] = { a: ['x'], t: i + 1 }; return b; });
    const n = Object.keys(book(p)).length;
    check('it holds 800 at most, the oldest going first', n === 800 && !('k0' in book(p)) && 'k804' in book(p), `${n}`);

    // The switch and the Clear button in the bar's settings
    const sh = p.shadow();
    const sw = sh.getElementById('bookSw');
    check('the settings have a switch for it, on to begin with', sw.getAttribute('aria-checked') === 'true');
    sw.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => p.store.rememberAnswers === false);
    check('  which turns it off', p.store.rememberAnswers === false);
    sw.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => p.store.rememberAnswers === true);

    const clear = sh.getElementById('bookClear');
    clear.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await wait(100);
    check('Clear takes a second tap, so a stray one does nothing', Object.keys(book(p)).length === 800, clear.textContent);
    clear.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => Object.keys(book(p)).length === 0);
    check('  and the second empties it', Object.keys(book(p)).length === 0);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll Connect next-question checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
