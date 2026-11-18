// A question in three tabs that points to a website (EDGAR: ROE and ROA for two companies).
// A real run answered Required 1, then gave up on Required 2 and 3, left them empty, and went
// on to the next question as if they were done. Now: the model is told to answer from what it
// knows, a part called done with boxes empty is asked again, and parts still blank at the end
// are said in the bar and not rated.
const { boot, settle, bodyText } = require('./harness');

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
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const INTRO = 'EDGAR: Cisco and Arista. Visit www.sec.gov and search for the annual reports (10-K) of Cisco Systems and Arista Networks. Locate the balance sheet and income statement of each company.';
const PARTS = [
  ['Required 1', 'Calculate the return on equity (ROE) for both companies.', ['Cisco Systems', 'Arista Networks']],
  ['Required 2', 'Calculate the return on assets (ROA) for both companies.', ['Cisco Systems', 'Arista Networks']],
  ['Required 3', 'Explain how a company can have a slightly higher ROE than its competitor.', ['How can a company have a slightly higher ROE?']]
];
const page = `<body><div role="main"><p>${INTRO}</p>
  <ul>${PARTS.map(([t], i) => `<li><a role="tab" href="#p${i}" aria-selected="${i === 0}">${t}</a></li>`).join('')}</ul>
  <div id="part"></div><button class="next-button">Next</button></div></body>`;

function wire(p) {
  const d = p.w.document, saved = {};
  let cur = -1;
  const show = i => {
    if (cur >= 0) saved[cur] = d.getElementById('part').innerHTML;
    cur = i;
    d.getElementById('part').innerHTML = saved[i] ?? `<p>${PARTS[i][1]}</p><table>${PARTS[i][2].map(r => `<tr><td>${r}</td><td><input type="text" aria-label="${r}"></td></tr>`).join('')}</table>`;
    d.querySelectorAll('[role="tab"]').forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
  };
  d.querySelectorAll('[role="tab"]').forEach((t, i) => t.addEventListener('click', e => { e.preventDefault(); show(i); }));
  show(0);
}

(async () => {
  // Required 1 answered; the model gives up on the others
  const clicks = [];
  const p = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 0, autoContinue: false },
    reply: b => /Calculate the return on equity/.test(bodyText(b)) && !/ALREADY done/.test(bodyText(b))
      ? as(b, { action: 'fill', fills: [{ index: 3, value: '29.9' }, { index: 4, value: '27.7' }] })
      : as(b, { action: 'none' }) });
  wire(p);
  const els = [];
  p.w.document.querySelector('.next-button').addEventListener('click', () => clicks.push('next'));
  p.pressPlay();
  const final = await settle(p, 90000);
  check('parts left blank are said, not rated and gone on from', p.isError() && /Couldn't fill in Required 2 and Required 3/.test(final), final);
  check('  and why: the question needs figures from a website', /website/.test(final), final);
  check('  and Next was not pressed', clicks.length === 0, clicks.join());
  check('  every call to the model after the first was told to answer from what it knows', p.requests.filter(r => /Never leave a box empty/.test(bodyText(r))).length >= 3, `${p.requests.length} calls`);

  // The model does answer every part: nothing is said
  const q = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
    reply: b => {
      const t = bodyText(b);
      const m = [...t.matchAll(/\[(\d+)\] input[^\n]*/g)].map(x => Number(x[1]));
      return /ALREADY done/.test(t) && !/NOT done/.test(t) ? as(b, { action: 'none' }) : as(b, { action: 'fill', fills: m.map(index => ({ index, value: '12.5' })) });
    } });
  wire(q);
  q.pressPlay();
  const ok = await settle(q, 90000);
  check('a model that answers every part is not stopped', !q.isError() && !/Couldn't fill in/.test(ok), ok);

  console.log(failed ? `\n${failed} failed` : '\nAll blank-part checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
