// Every feature a user can reach, driven through the real extension with only
// Claude's replies faked. If a change breaks one of these, this says which.
const { boot, settle, until } = require('./harness');
const canvas = require('./fixtures-canvas');

// Each case gets its own page and runs alongside the others; results are
// printed in the order the cases are written, whatever order they finish in.
const cases = [];
const test = fn => cases.push(fn);
const wait = ms => new Promise(r => setTimeout(r, ms));

// Haiku continues a seeded '{"action":"'; Sonnet and Opus answer whole
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
// One question per press, so each check sees exactly one run
const ANSWER_ONLY = { lastPresetIndex: 1, autoContinue: false };

const MC = `<body><div role="main">
  <div class="prompt">Which of the following is an asset?</div>
  <input type="radio" id="a" aria-label="Cash"><input type="radio" id="b" aria-label="Revenue">
</div></body>`;

const run = async (html, opts) => {
  const page = boot(html, { installLayout: flat, ...opts });
  page.pressPlay();
  const final = await settle(page);
  return { page, final, doc: page.w.document };
};

  // ── Question types ─────────────────────────────────────────────────────
  test(async check => {
    const { doc, final } = await run(`<body><div role="main">
      <div class="prompt">Assets = Liabilities + ______</div>
      <input type="text" id="blank" aria-label="Answer">
    </div></body>`, { storage: ANSWER_ONLY,
      reply: b => as(b, { action: 'fill', fills: [{ index: 0, value: 'Equity' }] }) });
    check('fill in the blank', doc.getElementById('blank').value === 'Equity', final);
  });
  test(async check => {
    const { doc, final } = await run(`<body><div role="main">
      <div class="prompt">Select all that are liabilities.</div>
      <input type="checkbox" id="c0" aria-label="Notes payable">
      <input type="checkbox" id="c1" aria-label="Inventory">
      <input type="checkbox" id="c2" aria-label="Unearned revenue">
    </div></body>`, { storage: ANSWER_ONLY,
      reply: b => as(b, { action: 'clickMany', indexes: [0, 2] }) });
    const c = id => doc.getElementById(id).checked;
    check('select all that apply', c('c0') && !c('c1') && c('c2'), final);
  });
  test(async check => {
    const cell = id => `<td><input id="${id}"></td>`;
    const { page, doc, final } = await run(`<body><div role="main">
      <p>Record the December adjustments.</p>
      <table>
        <tr><td></td><td>Deferred Revenue</td><td>Service Revenue</td></tr>
        <tr><td>Adjustment</td>${cell('w1')}${cell('w2')}</tr>
        <tr><td>Ending balance</td>${cell('w3')}${cell('w4')}</tr>
      </table></div></body>`, { storage: ANSWER_ONLY,
      reply: b => as(b, { action: 'fill', fills: [
        { index: 0, value: '-500' }, { index: 1, value: '500' },
        { index: 2, value: '1500' }, { index: 3, value: '500' }] }) });
    const v = id => doc.getElementById(id).value;
    check('accounting worksheet: every cell filled',
      v('w1') === '-500' && v('w2') === '500' && v('w3') === '1500' && v('w4') === '500', final);
    check('accounting worksheet: upgraded model', page.requests[0]?.model === 'claude-sonnet-5',
      page.requests[0]?.model);
    check('accounting worksheet: cells labelled by column and row',
      JSON.stringify(page.requests[0]?.messages).includes('Deferred Revenue — Adjustment'));
  });
  test(async check => {
    const card = (id, t) =>
      `<div data-rbd-drag-handle-draggable-id="${id}" tabindex="0" role="button">${t}</div>`;
    const { page, final } = await run(`<body><div role="main">
      <div class="prompt">Put these in order, first to last.</div>
      <div data-rbd-droppable-id="list">${card('a', 'Third')}${card('b', 'First')}${card('c', 'Second')}</div>
    </div></body>`, { storage: ANSWER_ONLY,
      reply: (b, n) => as(b, n === 1 ? { action: 'dragMove', index: 0, dir: 'down', steps: 2 } : { action: 'none' }) });
    const keys = page.debuggerCalls
      .filter(c => c.method === 'Input.dispatchKeyEvent' && c.type !== 'keyUp')
      .map(c => c.code);
    check('drag and drop: lift, move twice, drop',
      keys.join(',') === 'Space,ArrowDown,ArrowDown,Space', keys.join(','));
    check('drag and drop: finishes cleanly', !page.isError(), final);
  });

  // ── Every model gets a request it accepts ──────────────────────────────
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']) test(async check => {
    const { page, final } = await run(MC, {
      storage: { ...ANSWER_ONLY, model, autoUpgrade: false },
      reply: b => as(b, { action: 'click', index: 0 }) });
    const req = page.requests[0] ?? {};
    const last = req.messages?.[req.messages.length - 1];
    const ok = model === 'claude-haiku-4-5'
      // Haiku: seeded reply, deterministic
      ? last?.role === 'assistant' && req.temperature === 0 && !req.output_config
      // Sonnet 5 / Opus 5 reject both of those with a 400; they get a schema
      : last?.role === 'user' && req.temperature === undefined
        && req.output_config?.format?.type === 'json_schema';
    check(`${model}: request in the shape it accepts`, ok && req.model === model,
      JSON.stringify({ model: req.model, last: last?.role, t: req.temperature, oc: !!req.output_config }));
    check(`${model}: answers`, page.w.document.getElementById('a').checked, final);
  });

  // ── Errors say what to do ──────────────────────────────────────────────
  const errorCase = (name, reply, pattern) => test(async check => {
    const { page, final } = await run(MC, { storage: ANSWER_ONLY, reply });
    check(name, pattern.test(final) && page.isError(), final);
  });
  errorCase('bad API key explains the key-vs-key-ID mix-up',
    () => ({ status: 401, body: '{"error":{"type":"authentication_error"}}' }), /key ID/);
  errorCase('no credit says to add some',
    () => ({ status: 400, body: '{"error":{"message":"Your credit balance is too low"}}' }), /out of credit/);
  errorCase('an index that is not on the page clicks nothing',
    b => as(b, { action: 'click', index: 99 }), /isn't on the page/);
  test(async check => {
    const { page, final } = await run(MC, { storage: ANSWER_ONLY,
      reply: () => ({ status: 529, body: 'overloaded' }) });
    check('Claude overloaded: retried before giving up', page.requests.length >= 2 && page.isError(),
      `${page.requests.length} calls: ${final}`);
  });
  test(async check => {
    const page = boot(MC, { installLayout: flat, storage: ANSWER_ONLY,
      reply: () => ({ status: 429, body: 'rate_limit_error' }) });
    page.pressPlay();
    await until(() => /Rate limited/.test(page.status()));
    check('rate limit counts down and will retry', /Rate limited · \d+s/.test(page.status()), page.status());
    page.pressPlay();
    check('stop cancels the countdown', !/Rate limited/.test(page.status()), page.status());
  });
  test(async check => {
    const { page, final } = await run(MC, { storage: ANSWER_ONLY,
      reply: (b, n) => n === 1 ? 'not json at all' : as(b, { action: 'click', index: 0 }) });
    check('garbled reply: retried and recovered',
      page.w.document.getElementById('a').checked && !page.isError(), final);
  });
  test(async check => {
    const { page, final } = await run(MC, { storage: ANSWER_ONLY, reply: b => as(b, { action: 'none' }) });
    check('nothing answerable: pauses and says so', /Couldn't find an answer/.test(final), final);
  });

  // ── Runs end when they should ──────────────────────────────────────────
  const SIM = `<body><div role="main"><p>Apply bold to cell A1.</p>
    <button class="shell-btn" aria-label="Home">Home</button>
    <button class="shell-btn" aria-label="Bold">Bold</button>
    <table><tr>${Array.from({ length: 60 }, (_, i) =>
      `<td class="grdbdy-cell has-value" id="cell-A${i + 1}">${i}</td>`).join('')}</tr></table>
  </div></body>`;
  test(async check => {
    const { page, final } = await run(SIM, { reply: b => as(b, { action: 'click', index: 1 }) });
    check('same step three times: stops and says the control is not responding',
      /Repeated the same step 3 times/.test(final) && page.requests.length === 3,
      `${page.requests.length} calls: ${final}`);
  });
  test(async check => {
    const page = boot(SIM, { installLayout: flat, reply: b => as(b, { action: 'click', index: 0 }) });
    page.pressPlay();
    await until(() => page.requests.length >= 1);
    page.pressPlay();                       // stop, mid-task
    const at = page.requests.length;
    await wait(3000);
    check('stop halts a run in the middle', page.requests.length <= at + 1,
      `${at} calls at stop, ${page.requests.length} after`);
    check('stop is not reported as an error', !page.isError(), page.status());
  });

  test(async check => {
    // Answer-only with auto-continue: the student clicks Next, whenever
    const page = boot(MC, { installLayout: flat, storage: { lastPresetIndex: 1, autoContinue: true },
                            reply: b => as(b, { action: 'click', index: 0 }) });
    page.pressPlay();
    await until(() => /Click Next when ready/.test(page.status()));
    await wait(6000);   // past the old 5s fallback, which is what this guards
    check('answer only: waits for you to click Next, however long',
      page.requests.length === 1 && /Click Next when ready/.test(page.status()),
      `${page.requests.length} calls, "${page.status()}"`);
    page.w.document.querySelector('.prompt').textContent = 'Which of the following is a liability?';
    await until(() => page.requests.length >= 2);
    check('answer only: answers the next question once you move on', page.requests.length === 2,
      `${page.requests.length} calls`);
    page.pressPlay();
  });

  // ── Check this page ────────────────────────────────────────────────────
  const runCheck = async (html, opts) => {
    const page = boot(html, { installLayout: flat, ...opts });
    const sh = page.w.document.getElementById('__cap-host').shadowRoot;
    sh.getElementById('checkPage').dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
    await until(() => sh.getElementById('checkResult').textContent);
    const rows = [...sh.getElementById('checkResult').children].map(d => `${d.className}: ${d.textContent}`);
    return { page, rows, text: rows.join(' | ') };
  };
  test(async check => {
    const { text, page } = await runCheck(canvas.ALL_ON_ONE_PAGE,
      { installLayout: canvas.installLayout, reply: 'x' });
    check('check page: recognises a Canvas quiz and counts it',
      text.includes('ok: Canvas quiz · 4 questions, 14 answers'), text);
    check('check page: confirms the key works', text.includes('ok: API key works'), text);
    check('check page: shows the settings in use', /Model: Auto/.test(text) && /Mode: Autopilot/.test(text), text);
    check('check page: costs one tiny request, answers nothing',
      page.requests.length === 1 && page.requests[0].max_tokens === 1
      && !page.w.document.querySelector('input:checked'), JSON.stringify(page.requests));
  });
  test(async check => {
    const { text } = await runCheck(MC, { reply: () => ({ status: 401, body: 'invalid x-api-key' }) });
    check('check page: a bad key says why', text.includes('bad: Your API key was rejected'), text);
    check('check page: still reports the question it found', text.includes('ok: Question page · 2 things'), text);
  });
  test(async check => {
    const { text, page } = await runCheck(`<body><div role="main"><p>Welcome back.</p></div></body>`,
      { storage: { apiKey: undefined }, reply: 'x' });
    check('check page: says when there is nothing to answer', text.includes('bad: Nothing to answer found'), text);
    check('check page: says when no key is saved', text.includes('bad: No API key saved'), text);
    check('check page: no key means no request', page.requests.length === 0);
  });

  // ── Settings ───────────────────────────────────────────────────────────
  test(async check => {
    const page = boot(MC, { installLayout: flat, storage: { apiKey: undefined, ...ANSWER_ONLY },
                            reply: b => as(b, { action: 'click', index: 0 }) });
    const sh = page.w.document.getElementById('__cap-host').shadowRoot;
    page.pressPlay();
    await wait(200);
    check('no key: opens settings instead of running',
      page.requests.length === 0 && sh.getElementById('panel').classList.contains('show'));

    sh.getElementById('key').value = '  sk-ant-api03-abc  ';
    sh.getElementById('saveKey').dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
    check('saving the key stores it, trimmed', page.store.apiKey === 'sk-ant-api03-abc', page.store.apiKey);

    page.pressPlay();
    await settle(page);
    check('with the key saved, play runs', page.requests.length === 1);
  });
  test(async check => {
    const { page } = await run(MC, { storage: { ...ANSWER_ONLY, notes: 'Use GAAP conventions.' },
                                     reply: b => as(b, { action: 'click', index: 0 }) });
    const sent = JSON.stringify(page.requests[0]);
    check('notes reach Claude', sent.includes('Use GAAP conventions.'));
  });

Promise.all(cases.map(async fn => {
  const results = [];
  try {
    await fn((name, ok, detail = '') => results.push({ name, ok, detail }));
  } catch (e) {
    results.push({ name: 'case crashed', ok: false, detail: e.stack });
  }
  return results;
})).then(all => {
  let failed = 0;
  for (const { name, ok, detail } of all.flat()) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
    if (!ok) failed++;
  }
  console.log(failed ? `\n${failed} failed` : '\nAll feature checks passed');
  process.exit(failed ? 1 : 0);
});
