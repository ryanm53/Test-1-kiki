// The answer log: off by default; when on, each run records the prompt each
// model saw, the answer, how it ended, and the page afterwards (where Connect
// and SIMnet show their verdict); thumbs-down marks a run; download and a
// two-tap clear. It exists to build a test set from real questions.
const { boot, settle, until } = require('./harness');

const cases = [];
const test = fn => cases.push(fn);
const wait = ms => new Promise(r => setTimeout(r, ms));
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/static/awd/index.html';

// A Connect question that shows its verdict once rated, then moves on at Next
const connectPage = () => `<body><div role="main">
  <div class="prompt" id="p">An adjustment for accrued expenses results in a(n):</div>
  <input type="checkbox" aria-label="decrease in liabilities"><input type="checkbox" aria-label="increase in liabilities">
  <input type="checkbox" aria-label="increase in expenses"><input type="checkbox" aria-label="decrease in expenses">
  <div id="feedback"></div>
  <button data-automation-id="confidence-buttons--high_confidence" aria-label="High Confidence">High</button>
  <button class="next-button">Next Question</button></div></body>`;
const wireConnect = page => {
  const d = page.w.document;
  d.querySelector('[aria-label="High Confidence"]').addEventListener('click', () => {
    d.getElementById('feedback').textContent = 'Incorrect. The correct answers are increase in liabilities and increase in expenses.';
  });
  d.querySelector('.next-button').addEventListener('click', () => {
    d.getElementById('p').textContent = 'Which account is a contra asset?';
    d.getElementById('feedback').textContent = '';
  });
};

const open = (html, opts) => {
  const page = boot(html, { installLayout: flat, url: CONNECT, ...opts });
  const sh = page.shadow();
  const $ = id => sh.getElementById(id);
  const click = el => el.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
  return { page, $, click };
};

test(async check => {
  const { page, $ } = open(connectPage(), { storage: { mode: 'one' },
    reply: b => as(b, { action: 'clickMany', indexes: [1, 3] }) });
  page.pressPlay(); await settle(page);
  check('off by default: nothing is saved', page.store.answerLog === undefined, JSON.stringify(page.store.answerLog)?.slice(0, 80));
  check('off by default: no thumbs-down on the bar', $('flag').hidden);
});

test(async check => {
  const { page } = open(connectPage(), { storage: { mode: 'one', keepLog: true },
    reply: b => as(b, { action: 'clickMany', indexes: [1, 3] }) });
  wireConnect(page);
  page.pressPlay(); await settle(page);
  const e = page.store.answerLog?.[0] ?? {};
  check('on: one entry per run', page.store.answerLog?.length === 1, JSON.stringify(page.store.answerLog)?.slice(0, 80));
  check('on: records the site', e.host === 'learning.mheducation.com', e.host);
  check('on: records the exact prompt the model saw',
    e.steps?.[0]?.prompt?.includes('accrued expenses') && e.steps[0].prompt.includes('Elements (click by index)'));
  check('on: records which model and what kind of page', e.steps?.[0]?.model === 'claude-haiku-4-5' && e.steps[0].kind === 'question',
    `${e.steps?.[0]?.model} / ${e.steps?.[0]?.kind}`);
  check('on: records the answer in words',
    e.steps?.[0]?.answer === 'selected "increase in liabilities", "decrease in expenses"', e.steps?.[0]?.answer);
  check("on: catches Connect's verdict, shown after rating and before Next",
    /Incorrect\. The correct answers are/.test(e.after ?? '') && !/contra asset/.test(e.after ?? ''), (e.after ?? '').slice(0, 120));
  check('on: records how the run ended', e.outcome === 'done', e.outcome);
});

test(async check => {
  const { page, $, click } = open(connectPage(), { storage: { mode: 'one', keepLog: true },
    reply: b => as(b, { action: 'clickMany', indexes: [1, 2] }) });
  check('thumbs-down: hidden until something has been answered', $('flag').hidden);
  page.pressPlay(); await settle(page);
  check('thumbs-down: shown once a run has finished', !$('flag').hidden);
  click($('flag'));
  await until(() => page.store.answerLog?.[0]?.flagged === true);
  check('thumbs-down: marks the run', page.store.answerLog?.[0]?.flagged === true);
  check('thumbs-down: says so', /Marked as wrong/.test(page.status()), page.status());
  check('thumbs-down: one mark per answer', $('flag').hidden);
});

test(async check => {
  const cells = Array.from({ length: 60 }, (_, i) =>
    `<td class="grdbdy-cell has-value" id="cell-A${i + 1}">${i}</td>`).join('');
  const { page } = open(`<body><div role="main"><p>Apply bold to cell A1.</p>
    <button class="shell-btn" aria-label="Home">Home</button>
    <button class="shell-btn" aria-label="Bold" id="bold">Bold</button>
    <div id="popup"></div>
    <table><tr>${cells}</tr></table></div></body>`, {
    url: 'https://simnet.mheducation.com/exam', storage: { keepLog: true },
    reply: (b, n) => as(b, n === 1 ? { action: 'click', index: 1 } : { action: 'none' }) });
  page.w.document.getElementById('bold').addEventListener('click', () => {
    page.w.document.getElementById('popup').textContent = 'Incorrect. Hint: select cell A1 first.';
  });
  page.pressPlay(); await settle(page);
  const e = page.store.answerLog?.[0] ?? {};
  check('SIMnet: every step of the task in one entry', e.steps?.length === 2 && e.steps[0].kind === 'simnet',
    `${e.steps?.length} steps`);
  check("SIMnet: catches the incorrect popup and its hint", /Hint: select cell A1 first/.test(e.after ?? ''),
    (e.after ?? '').slice(0, 100));
});

test(async check => {
  const { page } = open(connectPage(), { storage: { mode: 'one', keepLog: true },
    reply: () => ({ json: { stop_reason: 'refusal', content: [] } }) });
  page.pressPlay(); await settle(page);
  check('a run that never got an answer is not logged', page.store.answerLog === undefined || page.store.answerLog.length === 0);
});

test(async check => {
  const { page, $, click } = open(connectPage(), { storage: { mode: 'one', keepLog: true },
    reply: b => as(b, { action: 'clickMany', indexes: [1, 2] }) });
  page.pressPlay(); await settle(page);
  click($('moreBtn'));
  await until(() => /^\d+ answers? logged$/.test($('logCount').textContent));
  check('settings: shows how many are logged', $('logCount').textContent === '1 answer logged', $('logCount').textContent);

  let downloaded = null;
  page.w.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; };
  page.w.URL.revokeObjectURL = () => {};
  const clicked = [];
  page.w.HTMLAnchorElement.prototype.click = function () { clicked.push(this.download); };
  click($('logDownload'));
  await until(() => clicked.length);
  check('download: saves a dated .json file', /^page-agent-log-\d{4}-\d{2}-\d{2}\.json$/.test(clicked[0] ?? ''), clicked[0]);
  const text = downloaded ? await downloaded.text() : '';
  check('download: the file holds the entries', JSON.parse(text || '{}').entries?.length === 1);

  click($('logClear'));
  await wait(300);
  check('clear: one tap does nothing', page.store.answerLog?.length === 1);
  check('clear: and asks for a second', /Tap again/.test($('logClear').textContent));
  click($('logClear'));
  await until(() => page.store.answerLog?.length === 0);
  check('clear: two taps clear it', page.store.answerLog?.length === 0);
});

test(async check => {
  const { page, $, click } = open(connectPage(), { reply: 'x' });
  click($('moreBtn'));
  click($('logSw'));
  check('switch: turning it on is saved', page.store.keepLog === true && $('logSw').classList.contains('on'));
  click($('logSw'));
  check('switch: and off', page.store.keepLog === false && !$('logSw').classList.contains('on'));
});

Promise.all(cases.map(async fn => {
  const results = [];
  try { await fn((name, ok, detail = '') => results.push({ name, ok, detail })); }
  catch (e) { results.push({ name: 'case crashed', ok: false, detail: e.stack }); }
  return results;
})).then(all => {
  let failed = 0;
  for (const { name, ok, detail } of all.flat()) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
    if (!ok) failed++;
  }
  console.log(failed ? `\n${failed} failed` : '\nAll answer-log checks passed');
  process.exit(failed ? 1 : 0);
});
