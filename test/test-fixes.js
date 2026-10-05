// Bugs found reading the code through, each pinned:
//
// - Next was looked for as "the first button that says Next" and given up on
//   when that one was greyed out — a question's own disabled Next (on its last
//   Required tab) hid the real one.
// - Stop pressed while Claude was thinking still let its answer be clicked
//   once it came back.
// - A number box blanks "7,200" or "(7,200)" without a word, and the run
//   reported the box filled.
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
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };

(async () => {
  // ── A greyed-out Next ahead of the real one ─────────────────────────────
  {
    const html = `<body><div role="main">
      <div class="prompt">Which of the following is an asset?</div>
      <input type="radio" id="a" aria-label="Cash"><input type="radio" aria-label="Revenue">
      <button class="next-button" id="inner" disabled>Next</button>
      <button class="next-button" id="outer">Next</button>
    </div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    let clicked = '';
    p.w.document.getElementById('outer').addEventListener('click', () => { clicked = 'outer'; });
    p.pressPlay();
    const final = await settle(p);
    check('Next: the usable one is pressed when a disabled one comes first', clicked === 'outer' && !p.isError(), final);
  }

  // ── Stop while Claude is thinking ───────────────────────────────────────
  {
    const html = `<body><div role="main">
      <div class="prompt">Which of the following is an asset?</div>
      <input type="radio" id="a" aria-label="Cash"><input type="radio" aria-label="Revenue">
      <button class="next-button">Next Question</button>
    </div></body>`;
    let release;
    const p = boot(html, { installLayout: flat, storage: oneQuestion,
      reply: b => new Promise(r => { release = () => r(as(b, { action: 'click', index: 0 })); }) });
    let next = false;
    p.w.document.querySelector('.next-button').addEventListener('click', () => { next = true; });
    p.pressPlay();
    await until(() => p.requests.length === 1 && release);
    p.pressPlay();                 // stop, with the answer still to come
    await wait(100);
    release();
    await wait(2500);
    check('stop: an answer arriving after stop is not clicked', !p.w.document.getElementById('a').checked);
    check('stop: nor is Next', !next);
    check('stop: the bar is idle, not an error', !p.isError() && /Ready/.test(p.status()), p.status());
  }

  // ── Number boxes ────────────────────────────────────────────────────────
  {
    const row = (label, n) => `<tr><td>${label}</td>${Array.from({ length: n },
      () => '<td><input type="number"></td>').join('')}</tr>`;
    const html = `<body><div role="main"><p>Enter the effects. Amounts to be deducted with a minus sign.</p>
      <table><tr><th></th><th>Assets</th><th>Expenses</th></tr>
      ${row('June 12', 2)}${row('December 31', 2)}</table>
      <button class="next-button">Next</button></div></body>`;
    const values = ['$41,000', '(7,200)', '-7,200', '7200.50'];
    const p = boot(html, { installLayout: flat, storage: oneQuestion,
      reply: b => as(b, { action: 'fill', fills: values.map((value, index) => ({ index, value })) }) });
    p.pressPlay();
    const final = await settle(p);
    const got = Array.from(p.w.document.querySelectorAll('input')).map(i => i.value);
    check('number boxes: "$41,000", "(7,200)", "-7,200" and "7200.50" go in as numbers',
      got.join(' ') === '41000 -7200 -7200 7200.50', got.join(' '));
    check('number boxes: and the run finishes cleanly', !p.isError(), final);
  }
  {
    const html = `<body><div role="main"><table><tr><th></th><th>Assets</th></tr>
      ${['a', 'b', 'c', 'd'].map(r => `<tr><td>${r}</td><td><input type="number"></td></tr>`).join('')}
      </table></div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion,
      reply: b => as(b, { action: 'fill', fills: [0, 1, 2, 3].map(index => ({ index, value: index ? '5' : 'see above' })) }) });
    p.pressPlay();
    const final = await settle(p);
    check('number boxes: a value one won\'t take is reported, not passed off as filled',
      p.isError() && /wouldn't take "see above"/.test(final), final);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll fix checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
