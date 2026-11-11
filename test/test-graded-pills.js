// Two things from a real Connect log (53 questions, 41 right, 3 wrong):
//
// - A graded multiple-select question shows each choice with a "correct" / "incorrect"
//   pill, which the page's text reads as part of the choice. So the right answer, as
//   the page gave it, never matched the question as it was asked, and no multiple-select
//   answer was ever remembered.
// - A select-all-that-apply answer that named a header button ("Progress information")
//   along with the real choices clicked the button as an answer.
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
const idx = (body, text) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${text}`).exec(bodyText(body))?.[1]);

const CHOICES = ['decreased by dividends.', 'increased by net income.', "all of the company's earnings not distributed to stockholders.", 'decreased by purchases of land.', 'equal to cash.'];
const RIGHT = CHOICES.slice(0, 3);
const html = `<body><div role="main">
  <button>Exit Assignment</button><button>Progress information</button>
  <h3>Multiple Select Question</h3><p>Retained earnings are:</p>
  <fieldset><legend>Multiple select question.</legend>
  ${CHOICES.map((c, i) => `<div><input type="checkbox" id="c${i}"><label for="c${i}">${c}<span class="pill"></span></label></div>`).join('')}
  </fieldset>
  <div id="slot"></div>
  <button aria-label="High Confidence">High</button><button class="next-button">Next Question</button>
</div></body>`;

// How the page looks once graded, and once it has moved on
const grade = d => {
  d.getElementById('slot').innerHTML = `<div id="verdict">Your Answer <span>incorrect</span></div><div id="key"><h4>Correct Answer</h4>${RIGHT.map(c => `<p>${c}</p>`).join('')}</div>`;
  d.querySelectorAll('.pill').forEach((x, i) => { x.textContent = i === 2 ? ' correct' : i < 2 ? ' incorrect' : ''; });
};
const moveOn = d => { d.getElementById('slot').innerHTML = ''; d.querySelectorAll('.pill').forEach(x => { x.textContent = ''; }); };

(async () => {
  // ── The right answer is kept, though the graded choices carry pills ───────
  {
    const p = boot(html, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 0, autoContinue: false, keepLog: true },
      reply: b => as(b, { action: 'clickMany', indexes: [idx(b, "all of the company's")] }) });
    const d = p.w.document;
    // answering one shows how it was graded; Next moves on
    d.addEventListener('click', e => { if (e.target.matches?.('input[type="checkbox"]')) grade(d); });
    d.querySelector('.next-button').addEventListener('click', () => moveOn(d));
    p.pressPlay();
    const final = await settle(p, 60000);
    await until(() => p.store.answerBook && Object.keys(p.store.answerBook).length > 0, 8000).catch(() => {});
    const entry = Object.values(p.store.answerBook ?? {})[0];
    check('the graded multiple-select answer is remembered', !!entry, `${JSON.stringify(p.store.answerBook)} / ${final}`);
    check('  as the three right choices, worded as they were asked, no pills',
      JSON.stringify([...(entry?.a ?? [])].sort()) === JSON.stringify([...RIGHT].map(c => c.toLowerCase()).sort()), JSON.stringify(entry?.a));

    // ...and given back, all three, the next time
    const again = boot(html, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false, answerBook: p.store.answerBook }, reply: 'x' });
    again.pressPlay();
    await settle(again, 30000);
    const ticked = [...again.w.document.querySelectorAll('input[type="checkbox"]')].map(c => c.checked);
    check('  and the next time all three are ticked with no call to Claude', again.requests.length === 0 && ticked.join() === 'true,true,true,false,false', `${again.requests.length} calls ${ticked}`);
  }

  // ── A header button among a select-all answer is left alone ──────────────
  {
    const clicks = [];
    const p = boot(html, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: b => as(b, { action: 'clickMany', indexes: [idx(b, 'Progress information'), idx(b, 'decreased by dividends'), idx(b, 'increased by net')] }) });
    p.w.document.querySelectorAll('button').forEach(x => x.addEventListener('click', () => clicks.push(x.textContent.trim())));
    p.pressPlay();
    const final = await settle(p, 30000);
    const ticked = [...p.w.document.querySelectorAll('input[type="checkbox"]')].map(c => c.checked);
    check('"Progress information" is not clicked as an answer; the two choices are ticked',
      !clicks.includes('Progress information') && ticked.join() === 'true,true,false,false,false', `${clicks} ${ticked} / ${final}`);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll graded-pill checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
