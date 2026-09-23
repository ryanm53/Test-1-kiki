// The settings panel: one Mode control, Model with Auto, a key that folds
// away once saved, "More" for the rest, and the page type shown in the bar.
// Also that settings saved by the old panel still mean the same thing.
const { boot, settle, until } = require('./harness');
const canvas = require('./fixtures-canvas');

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
const MC = `<body><div role="main">
  <div class="prompt">Which of the following is an asset?</div>
  <input type="radio" id="a" aria-label="Cash"><input type="radio" id="b" aria-label="Revenue">
</div></body>`;

const open = (html, opts = {}) => {
  const page = boot(html, { installLayout: flat, reply: 'x', ...opts });
  const sh = page.shadow();
  const $ = id => sh.getElementById(id);
  const click = el => el.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
  const selectedMode = () => [...$('mode').querySelectorAll('button.on')].map(b => b.textContent);
  return { page, $, click, selectedMode };
};

// ── Mode ─────────────────────────────────────────────────────────────────
test(async check => {
  const { page, $, click, selectedMode } = open(MC);
  check('mode: Autopilot out of the box', selectedMode().join() === 'Autopilot', selectedMode().join());
  check('mode: says what it does', /keeps going/.test($('modeHint').textContent));

  click($('mode').querySelector('[data-mode="one"]'));
  check('mode: One question is saved as one step then stop',
    page.store.mode === 'one' && page.store.autoContinue === false && page.store.lastPresetIndex === 0,
    JSON.stringify(page.store));
  check('mode: only one option is ever selected', selectedMode().join() === 'One question', selectedMode().join());

  click($('mode').querySelector('[data-mode="answer"]'));
  check('mode: Answer only is saved as no clicks, waiting for you',
    page.store.mode === 'answer' && page.store.lastPresetIndex === 1 && page.store.autoContinue === true,
    JSON.stringify(page.store));
  check('mode: hint follows the choice', /waits for you/.test($('modeHint').textContent));
});

test(async check => {
  // One question on Connect: answer, confidence, next — and then stop
  const html = `<body><div role="main">
    <div class="prompt" id="p">Which of the following is an asset?</div>
    <input type="radio" aria-label="Cash"><input type="radio" aria-label="Revenue">
    <button data-automation-id="confidence-buttons--high_confidence" aria-label="High Confidence">High</button>
    <button class="next-button">Next Question</button></div></body>`;
  const { page } = open(html, { url: 'https://learning.mheducation.com/static/awd/index.html',
    storage: { mode: 'one' }, reply: b => as(b, { action: 'click', index: 0 }) });
  let next = 0;
  page.w.document.querySelector('.next-button').addEventListener('click', () => {
    next++;
    page.w.document.getElementById('p').textContent = 'Which is a liability?';
  });
  page.pressPlay();
  await until(() => next > 0);
  await wait(3000);
  check('One question: answers, clicks Next, then stops', next === 1 && page.requests.length === 1,
    `${page.requests.length} calls, Next ×${next}`);
});

test(async check => {
  const a = open(MC, { storage: { lastPresetIndex: 1, autoContinue: false } });
  check('old settings: "Answer only" still reads as Answer only',
    a.selectedMode().join() === 'Answer only', a.selectedMode().join());
  const b = open(MC, { storage: { lastPresetIndex: 0, autoContinue: false } });
  check('old settings: auto-continue off reads as One question',
    b.selectedMode().join() === 'One question', b.selectedMode().join());
});

// ── Model ────────────────────────────────────────────────────────────────
const SHEET = `<body><div role="main"><p>Record the adjustments.</p><table>
  <tr><td></td><td>Cash</td><td>Revenue</td></tr>
  <tr><td>Adjustment</td><td><input></td><td><input></td></tr>
  <tr><td>Ending</td><td><input></td><td><input></td></tr></table></div></body>`;
const fill4 = b => as(b, { action: 'fill', fills: [0, 1, 2, 3].map(i => ({ index: i, value: '1' })) });

test(async check => {
  const { page, $ } = open(SHEET, { storage: { mode: 'answer' }, reply: fill4 });
  check('model: Auto out of the box', $('model').value === 'auto', $('model').value);
  check('model: menu has Auto and the three models',
    [...$('model').options].map(o => o.textContent).join() === 'Auto,Haiku 4.5,Sonnet 5,Opus 5.5');
  page.pressPlay(); await settle(page);
  check('model: Auto upgrades a worksheet to Opus 5.5', page.requests[0]?.model === 'claude-opus-5-5', page.requests[0]?.model);
});

test(async check => {
  const { page, $ } = open(SHEET, { storage: { mode: 'answer' }, reply: fill4 });
  $('model').value = 'claude-haiku-4-5';
  $('model').dispatchEvent(new page.w.Event('change'));
  check('model: naming one turns the upgrade off',
    page.store.model === 'claude-haiku-4-5' && page.store.autoUpgrade === false, JSON.stringify(page.store));
  page.pressPlay(); await settle(page);
  check('model: a named model is used even on a worksheet',
    page.requests[0]?.model === 'claude-haiku-4-5', page.requests[0]?.model);

  $('model').value = 'auto';
  $('model').dispatchEvent(new page.w.Event('change'));
  check('model: back to Auto turns the upgrade on',
    page.store.model === 'claude-haiku-4-5' && page.store.autoUpgrade === true, JSON.stringify(page.store));
});

test(async check => {
  const { page, $ } = open(MC, { storage: { model: 'claude-sonnet-5', autoUpgrade: true } });
  check('old settings: Sonnet-with-upgrade shows as Sonnet 5, and is saved that way',
    $('model').value === 'claude-sonnet-5' && page.store.autoUpgrade === false,
    `${$('model').value} / ${page.store.autoUpgrade}`);
});

// ── API key ──────────────────────────────────────────────────────────────
test(async check => {
  const { page, $, click } = open(MC, { storage: { apiKey: undefined } });
  check('key: none saved — the box is open and says what it needs',
    !$('keyEdit').hidden && $('keySaved').hidden && !$('keyHint').hidden);
  check('key: nothing to cancel back to', $('cancelKey').hidden);
  check('key: the bar says to add one', /Add your API key/.test(page.status()), page.status());

  $('key').value = ' sk-ant-api03-secret ';
  click($('saveKey'));
  check('key: saved, trimmed', page.store.apiKey === 'sk-ant-api03-secret', page.store.apiKey);
  check('key: folds to one line once saved', $('keyEdit').hidden && !$('keySaved').hidden && $('keyHint').hidden);
  check('key: the bar is ready', /^Ready/.test(page.status()), page.status());

  click($('changeKey'));
  check('key: Change opens an empty box — the saved key is never shown back',
    !$('keyEdit').hidden && $('key').value === '' && !$('cancelKey').hidden);
  click($('cancelKey'));
  check('key: Cancel keeps the saved key', !$('keySaved').hidden && page.store.apiKey === 'sk-ant-api03-secret');
});

// ── More ─────────────────────────────────────────────────────────────────
test(async check => {
  const { $, click } = open(MC);
  check('more: model, notes and troubleshooting start tucked away', $('more').hidden);
  click($('moreBtn'));
  check('more: open on request', !$('more').hidden && $('moreBtn').getAttribute('aria-expanded') === 'true');
  click($('moreBtn'));
  check('more: and closed again', $('more').hidden);
});

// ── The page type in the bar ─────────────────────────────────────────────
test(async check => {
  const { page } = open(canvas.ALL_ON_ONE_PAGE, { installLayout: canvas.installLayout });
  await until(() => /·/.test(page.status()));
  check('bar: recognises a Canvas quiz', page.status() === 'Ready · Canvas quiz', page.status());
});
test(async check => {
  const cells = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell" id="cell-A${i + 1}"></td>`).join('');
  const { page } = open(`<body><div role="main"><button class="shell-btn">Home</button>
    <table><tr>${cells}</tr></table></div></body>`, { url: 'https://simnet.mheducation.com/exam' });
  await until(() => /·/.test(page.status()));
  check('bar: recognises SIMnet', page.status() === 'Ready · SIMnet', page.status());
});
test(async check => {
  const { page } = open(MC, { url: 'https://learning.mheducation.com/static/awd/index.html' });
  await until(() => /·/.test(page.status()));
  check('bar: recognises Connect', page.status() === 'Ready · Connect', page.status());
});
test(async check => {
  const { page } = open(`<body><div role="main"><button>Inbox</button><input type="checkbox"></div></body>`,
                        { url: 'https://mail.example.com/' });
  await wait(7000);
  const peeks = page.pageMessages.filter(m => m.type === 'SCRAPE' && m.peek).length;
  check('bar: an ordinary site gets a plain "Ready"', page.status() === 'Ready', page.status());
  check('bar: and is looked at no more than twice', peeks <= 2, `${peeks} looks in 7s`);
  check('bar: looking never calls Claude', page.requests.length === 0);
});
test(async check => {
  const { page } = open(canvas.ALL_ON_ONE_PAGE, { installLayout: canvas.installLayout, storage: { apiKey: undefined } });
  await wait(2500);
  check('bar: no key, no looking', !page.pageMessages.some(m => m.type === 'SCRAPE'), JSON.stringify(page.pageMessages));
});

// ── A look at the page can't move a run's click ──────────────────────────
test(async check => {
  const { page } = open(`<body><div role="main"><button id="first">Cash</button></div></body>`);
  await page.toPage({ type: 'SCRAPE' });                 // a run reads the page
  const main = page.w.document.querySelector('[role="main"]');
  main.insertAdjacentHTML('afterbegin', '<button id="intruder">Revenue</button>');
  await page.toPage({ type: 'SCRAPE', peek: true });     // an idle look in between
  let clicked = '';
  page.w.document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { clicked = b.id; }));
  await page.toPage({ type: 'EXECUTE', action: { action: 'click', index: 0 } });
  check('peek: the run still clicks what it read', clicked === 'first', `clicked "${clicked}"`);
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
  console.log(failed ? `\n${failed} failed` : '\nAll panel checks passed');
  process.exit(failed ? 1 : 0);
});
