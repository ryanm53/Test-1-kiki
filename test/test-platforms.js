// One set of settings, every platform. The defaults a new user has — the
// "Answer, confidence, next" mode, auto-continue on, Haiku — must do the right
// thing on SIMnet, Connect and Canvas without anything being switched.
const { boot, settle, until } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// Haiku's replies continue a seeded '{"action":"'; the larger models answer
// whole. Auto-upgrade decides which one a page gets, so answer either way.
const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice(PREFIX.length) : s;
};

const flatLayout = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};

(async () => {
  // ── SIMnet ─────────────────────────────────────────────────────────────
  {
    const cells = Array.from({ length: 60 }, (_, i) =>
      `<td class="grdbdy-cell has-value" id="cell-A${i + 1}" tabindex="0">${i}</td>`).join('');
    const html = `<body><div role="main">
      <p>Use the Formulas tab to insert a SUM function in cell A61.</p>
      <div class="Launch_exam-wrapper">
        <button class="Launch_submit-end-btn">Submit</button>
        <button class="shell-btn" aria-label="AutoSum">AutoSum</button>
        <div role="tab" aria-label="Formulas">Formulas</div>
        <table><tr>${cells}</tr></table>
      </div></div></body>`;

    const page = boot(html, {
      installLayout: flatLayout,
      // Click the Formulas tab, then report the task complete
      reply: (body, n) => as(body, n === 1 ? { action: 'click', index: 1 } : { action: 'none' })
    });
    const clicks = [];
    page.w.document.querySelectorAll('button, [role="tab"]').forEach(b =>
      b.addEventListener('click', () => clicks.push(b.textContent.trim())));

    page.pressPlay();
    const final = await settle(page);
    await wait(1500);

    check('SIMnet: carried out the step', clicks.includes('Formulas'), clicks.join(','));
    check('SIMnet: used the stronger model for it',
      page.requests[0]?.model === 'claude-opus-5-5', page.requests[0]?.model);
    check('SIMnet: finishes cleanly, no confidence-button error',
      /^Finished\. Check SIMnet agrees/.test(final) && !page.isError(), final);
    check('SIMnet: does not start the task over', page.requests.length === 2, `${page.requests.length} calls`);
    check('SIMnet: never pressed the exam\'s Submit', !clicks.includes('Submit'));
  }

  // ── Connect: answer, confidence, next — and keep going ─────────────────
  {
    const html = `<body><div role="main">
      <div class="prompt" id="prompt">Which of the following is an asset?</div>
      <input type="radio" id="a" aria-label="Cash"><input type="radio" id="b" aria-label="Revenue">
      <button data-automation-id="confidence-buttons--high_confidence" aria-label="High Confidence">High</button>
      <button class="next-button">Next Question</button>
    </div></body>`;

    const page = boot(html, {
      installLayout: flatLayout,
      reply: body => as(body, { action: 'click', index: 0 })
    });
    const doc = page.w.document;
    const order = [];
    doc.querySelector('[aria-label="High Confidence"]').addEventListener('click', () => order.push('confidence'));
    doc.querySelector('.next-button').addEventListener('click', () => {
      order.push('next');
      // Connect swaps the question in place
      doc.getElementById('prompt').textContent = `Question ${order.length}: which is a liability?`;
      doc.getElementById('a').checked = false;
    });

    page.pressPlay();
    await until(() => page.requests.length >= 2);
    await wait(1200);

    check('Connect: answered', order.length > 0);
    check('Connect: confidence, then next',
      order[0] === 'confidence' && order[1] === 'next', order.join(' → '));
    check('Connect: went on to the next question by itself', page.requests.length >= 2,
      `${page.requests.length} calls`);
    check('Connect: stayed on the cheap model', page.requests[0]?.model === 'claude-haiku-4-5');
    page.pressPlay();   // stop
  }

  // ── Connect page with no confidence rating ─────────────────────────────
  {
    const html = `<body><div role="main">
      <div class="prompt">Which of the following is an asset?</div>
      <input type="radio" aria-label="Cash"><input type="radio" aria-label="Revenue">
      <button class="next-button">Next Question</button>
    </div></body>`;
    const page = boot(html, { installLayout: flatLayout, storage: { autoContinue: false },
                              reply: body => as(body, { action: 'click', index: 0 }) });
    let next = false;
    page.w.document.querySelector('.next-button').addEventListener('click', () => { next = true; });

    page.pressPlay();
    const final = await settle(page);
    check('No confidence button: goes straight to Next', next);
    check('No confidence button: no error', !page.isError(), final);
  }

  // ── Browsing never starts a run on its own ─────────────────────────────
  {
    const page = boot(`<body><div role="main"><button>Inbox</button><button>Sent</button></div></body>`,
                      { installLayout: flatLayout, reply: body => as(body, { action: 'click', index: 0 }) });
    page.w.history.pushState({}, '', '/mail/sent');
    page.w.history.pushState({}, '', '/mail/drafts');
    page.w.dispatchEvent(new page.w.HashChangeEvent('hashchange'));
    await wait(1800);
    check('changing page inside a web app does not start the agent', page.requests.length === 0,
      `${page.requests.length} calls`);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll platform checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
