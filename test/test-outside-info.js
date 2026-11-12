// A Connect question that sends the student to a website for its figures ("Go to the SASB
// website and search for Columbia Sportswear Company... what percentage of employees
// identified as underrepresented groups?"). Nothing on the page holds the answer, so
// the model gives up; the run used to go on to a screenshot and then the stronger model,
// which cannot find it either, and then say "Couldn't find an answer here". Now it says
// what the question is, after the first try.
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
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const oneQuestion = { lastPresetIndex: 1, autoContinue: false };
const cell = id => `<td><input id="${id}" aria-label="answer"></td><td>%</td>`;

const html = `<body><div role="main"><p>Go to the SASB website (https://www.sasb.org/company-use/sasb-reporters/) and search for Columbia Sportswear Company. Click on the Corporate Responsibility Report for 2019.</p>
  <p>Required: 1. In 2019, what percentage of employees identified as underrepresented groups? What percentage of manager-level employees were women?</p>
  <table><tr><td>What percentage of employees identified as underrepresented groups?</td>${cell('a')}</tr>
  <tr><td>What percentage of manager-level employees were women?</td>${cell('b')}</tr>
  <tr><td>A third thing</td>${cell('c')}</tr><tr><td>A fourth thing</td>${cell('d')}</tr></table>
  <button class="next-button">Next</button></div></body>`;

(async () => {
  {
    const p = boot(html, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: b => as(b, { action: 'none' }) });
    p.pressPlay();
    const final = await settle(p, 30000);
    check('it says the question sends you to a website, and what to do', p.isError() && /sends you to a website/.test(final) && /press play/.test(final), final);
    check('  after one try: no screenshot, no stronger model', p.requests.length === 1, `${p.requests.length} calls: ${p.requests.map(r => r.model).join()}`);
  }
  {
    // Gives an answer: nothing is said, and the answer is typed as usual
    const p = boot(html, { installLayout: flat, url: CONNECT, storage: oneQuestion,
      reply: b => as(b, { action: 'fill', fills: [0, 1, 2, 3].map(i => ({ index: i, value: '35' })) }) });
    p.pressPlay();
    const final = await settle(p, 30000);
    check('a model that does answer is not stopped', !/website/.test(final) && p.w.document.getElementById('a').value === '35', final);
  }
  {
    // A question with no website in it keeps the old message
    const plain = '<body><div role="main"><p>Pick one.</p><input type="radio" aria-label="Yes"><input type="radio" aria-label="No"></div></body>';
    const p = boot(plain, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: b => as(b, { action: 'none' }) });
    p.pressPlay();
    const final = await settle(p, 30000);
    check('any other question the model gives up on keeps the usual message', /Couldn't find an answer here/.test(final), final);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll outside-information checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
