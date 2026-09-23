// SIMnet's result popup, as reported: "Incorrect", a HINT with the exact
// steps, and one Continue button — back to the question after a wrong try, on
// to the next after a right one — with "1 of 3 Attempts" in the header.
const { boot, settle, until } = require('./harness');

const cases = [];
const test = fn => cases.push(fn);
const wait = ms => new Promise(r => setTimeout(r, ms));
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
const indexOf = (body, label) => {
  const m = new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`).exec(body.messages[0].content);
  return m ? Number(m[1]) : null;
};

const HINT = 'HINT: Right-click the Salaries sheet tab, and select Move or Copy... Expand the To book list and select (new book). Click the Create a copy check box. Click OK.';
const grid = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell" id="cell-A${i + 1}"></td>`).join('');
// As on the real SIMnet, the task text is part of what the extension reads
const page = ({ attempt = 1, total = 3, counter = true, popup = '' } = {}) => `<body>
  <div role="main">
    <div class="Launch_header"><span id="task">Copy the Salaries worksheet to a new workbook.</span>
      ${counter ? `<span id="attempts">${attempt} of ${total} Attempts</span>` : ''}</div>
    <button class="shell-btn" aria-label="Right way">Right way</button>
    <button class="shell-btn" aria-label="Wrong way">Wrong way</button>
    <table><tr>${grid}</tr></table><div role="tab">Salaries</div>
    <div>Correct</div>
  </div>${popup}</body>`;
const POPUP = (v, hint = '') => `<div class="modal" id="popup"><h2>${v}</h2>${hint ? `<p>${hint}</p>` : ''}<button id="continue">Continue</button></div>`;

// A small SIMnet: grades on the graded button, counts attempts, and Continue
// either returns to the question or moves to the next one
function wire(w, state) {
  const d = w.document;
  state.continues = 0;
  const show = right => {
    d.body.insertAdjacentHTML('beforeend', POPUP(right ? 'Correct' : 'Incorrect', right ? '' : HINT));
    d.getElementById('continue').addEventListener('click', () => {
      state.continues++;
      d.getElementById('popup').remove();
      if (right) { d.getElementById('task').textContent = 'Question 2: Rename the Summary sheet.'; state.advanced = true; }
      else if (d.getElementById('attempts')) {
        state.attempt++;
        d.getElementById('attempts').textContent = `${state.attempt} of ${state.total} Attempts`;
      }
    });
  };
  d.querySelector('[aria-label="Right way"]').addEventListener('click', () => show(true));
  d.querySelector('[aria-label="Wrong way"]').addEventListener('click', () => show(false));
}

const start = (opts, reply, storage = {}) => {
  const state = { attempt: opts.attempt ?? 1, total: opts.total ?? 3 };
  const p = boot(page(opts), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    storage: { mode: 'one', keepLog: true, ...storage }, reply });
  wire(p.w, state);
  return { p, state };
};
// The fake model: follows SIMnet's hint when it has one, otherwise does as told
const model = firstTry => b => {
  const prompt = b.messages[0].content;
  if (/marked your previous attempt at this task INCORRECT/.test(prompt)) {
    return as(b, { action: 'click', index: indexOf(b, 'Right way') });
  }
  return as(b, { action: 'click', index: indexOf(b, firstTry) });
};

test(async check => {
  const { p, state } = start({}, model('Right way'), { mode: 'autopilot' });
  p.pressPlay();
  await until(() => state.advanced && p.requests.length >= 2, 30000);
  check('correct: presses Continue once', state.continues === 1, state.continues);
  check('correct: Autopilot goes straight on to the next question',
    (p.requests[1]?.messages[0].content ?? '').includes('Question 2: Rename the Summary sheet'));
  check('correct: without asking Claude again about the graded task', p.requests.length >= 2);
  p.pressPlay();
});

test(async check => {
  const { p, state } = start({}, model('Wrong way'));
  p.pressPlay(); const final = await settle(p, 40000);
  const retry = p.requests.find(r => /INCORRECT/.test(r.messages[0].content));
  check('wrong then right: retried once, with the hint word for word',
    !!retry && retry.messages[0].content.includes('Click the Create a copy check box'));
  check('wrong then right: the retry thinks harder', retry?.output_config?.effort === 'medium', retry?.output_config?.effort);
  check('wrong then right: Continue pressed for the retry and after', state.continues === 2, state.continues);
  check('wrong then right: ends well', !p.isError(), final);
  const log = p.store.answerLog?.[0];
  check('wrong then right: the log records both verdicts and the hint',
    log?.verdicts?.map(v => v.verdict).join() === 'incorrect,correct' && /Create a copy/.test(log.verdicts[0].hint),
    JSON.stringify(log?.verdicts));
});

test(async check => {
  const { p, state } = start({}, b => as(b, { action: 'click', index: indexOf(b, 'Wrong way') }));
  p.pressPlay(); const final = await settle(p, 40000);
  check('wrong twice: stops and says so, with the hint', /Marked incorrect again\. SIMnet's hint: Right-click the Salaries/.test(final) && p.isError(), final);
  check('wrong twice: pressed Continue only for the one retry', state.continues === 1, state.continues);
  check('wrong twice: the last attempt is left alone', state.attempt === 2, `on attempt ${state.attempt} of 3`);
});

test(async check => {
  const { p, state } = start({ attempt: 2 }, model('Wrong way'));
  p.pressPlay(); const final = await settle(p, 40000);
  check('on attempt 2 of 3: no retry, which would spend the last one',
    state.continues === 0 && /would use your last attempt/.test(final), `${state.continues} continues: ${final}`);
});

test(async check => {
  const { p, state } = start({}, model('Wrong way'), { mode: 'answer' });
  p.pressPlay(); const final = await settle(p, 40000);
  check('answer only, wrong: no Continue, no retry, the hint shown',
    state.continues === 0 && /^Marked incorrect\. SIMnet's hint/.test(final), `${state.continues}: ${final}`);
});

test(async check => {
  const { p, state } = start({}, model('Right way'), { mode: 'answer' });
  p.pressPlay(); const final = await settle(p, 40000);
  check('answer only, right: says so and leaves Continue to you',
    state.continues === 0 && /^Correct! Click Continue/.test(final) && !p.isError(), `${state.continues}: ${final}`);
});

test(async check => {
  const { p, state } = start({ counter: false }, model('Wrong way'));
  p.pressPlay(); const final = await settle(p, 40000);
  check('no attempt counter to read: no retry', state.continues === 0 && /^Marked incorrect\./.test(final), `${state.continues}: ${final}`);
});

test(async check => {
  // Pressing play while a verdict is already showing
  const { p, state } = start({ popup: POPUP('Correct') }, model('Right way'));
  p.w.document.getElementById('continue').addEventListener('click', () => { state.continues++; p.w.document.getElementById('popup').remove(); });
  p.pressPlay(); await settle(p, 20000);
  check('a verdict already up is acted on without asking Claude', state.continues === 1 && p.requests.length === 0,
    `${state.continues} continues, ${p.requests.length} calls`);
});

test(async check => {
  // The page has a cell reading "Correct" but no popup
  const { p } = start({}, 'x');
  const v = await p.toPage({ type: 'SIMNET_VERDICT' });
  check('a stray "Correct" with no Continue beside it is not a verdict', v.verdict === null, JSON.stringify(v));
  check('the attempt counter is read', v.attempts?.current === 1 && v.attempts?.total === 3, JSON.stringify(v.attempts));
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
  console.log(failed ? `\n${failed} failed` : '\nAll SIMnet verdict checks passed');
  process.exit(failed ? 1 : 0);
});
