// A quiz with every question on one page that isn't Canvas Classic — the newer
// Canvas quizzes: each question a block of its own (a number, "True or False",
// "2 points", the prose, two choices), a Submit button and a question list at the
// side, and the choices drawn by the page: the real radio input sits over a styled
// circle, see-through. It found nothing ("Couldn't find an answer here"): a
// see-through input was counted as not on the page, and the page was taken to be
// one question anyway. Rare, but wanted: all of them at once, never submitted.
const { boot, settle, until, bodyText } = require('./harness');

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
const Q = [
  ['Workforce planning means deciding what work needs to be done and how to fill it.', 'True'],
  ['A labor shortage means there are more workers than jobs.', 'False'],
  ['A selection tool can be valid without being reliable.', 'True'],
  ['In a structured interview, every applicant gets the same job-related questions.', 'True']
];
// the real input see-through over its stand-in, as the page draws it
const choice = (q, label, hidden) => `<label class="choice"><span class="facade"></span>
  <input type="radio" name="q${q}" id="q${q}-${label}" aria-label="${label}" ${hidden ? 'style="opacity:0;position:absolute"' : ''}> <span>${label}</span></label>`;
const quiz = (hidden = true) => `<body>
  <nav><button>1</button><button>2</button><button>3</button><button>4</button></nav>
  <button class="submit" id="submit">Submit</button>
  <div role="main">${Q.map(([text], i) => `<section class="question-block">
    <div class="head"><span class="num">${i + 1}</span><span>True or False</span><span>2 points</span></div>
    <p>${text}</p>${choice(i + 1, 'True', hidden)}${choice(i + 1, 'False', hidden)}</section>`).join('')}</div></body>`;

const indexFor = (b, keyword, label) => {
  for (const l of bodyText(b).split('\n')) {
    const m = /^\[(\d+)\] input type="radio" "([^"]*)".*\(question: "([^"]*)"/.exec(l);
    if (m && m[2] === label && m[3].includes(keyword)) return Number(m[1]);
  }
  return NaN;
};
const answers = b => as(b, { action: 'clickMany', indexes: Q.map(([text, label]) => indexFor(b, text.slice(0, 20), label)) });

(async () => {
  // ── The page, as it is read ──────────────────────────────────────────────
  {
    const p = boot(quiz(), { installLayout: flat, reply: 'x' });
    const r = await p.scrape();
    check('a page of question blocks is read as a quiz, every question at once', r.isCanvas === true && r.quizLabel === 'Quiz page', JSON.stringify({ c: r.isCanvas, l: r.quizLabel }));
    check('  the 8 see-through radios are the choices; nothing else (no Submit, no question list)',
      r.elements.length === 8 && r.elements.every(e => e.tag === 'input' && e.type === 'radio'), r.elements.map(e => `${e.tag}:${e.text}`).join(' '));
    check('  each choice carries its own question, in words', r.elements[2].question.includes('A labor shortage') && r.elements[7].question.includes('structured interview'), r.elements.map(e => e.question).join(' | ').slice(0, 300));
    check('  the questions are numbered in the page text', /Question 1: Workforce planning/.test(r.text) && /Question 4: In a structured/.test(r.text), r.text.slice(0, 200));
    check('  the choices\' labels are True and False', r.elements.map(e => e.text).join() === 'True,False,True,False,True,False,True,False', r.elements.map(e => e.text).join());
  }

  // ── Answered in one go; Submit never touched ─────────────────────────────
  {
    const p = boot(quiz(), { installLayout: flat, storage: { lastPresetIndex: 0, autoContinue: true }, reply: answers });
    let submitted = false;
    p.w.document.getElementById('submit').addEventListener('click', () => { submitted = true; });
    p.pressPlay();
    const final = await settle(p);
    const ticked = Q.map((_, i) => ['True', 'False'].find(l => p.w.document.getElementById(`q${i + 1}-${l}`).checked));
    check('all four are answered in one call, as told', ticked.join() === Q.map(q => q[1]).join() && p.requests.length === 1, `${ticked} / ${p.requests.length} calls`);
    check('  and Submit is never pressed: it says to look it over and submit it yourself', !submitted && /submit it yourself/.test(final), `${submitted} / ${final}`);
    check('  the prompt is the several-questions one', /SEVERAL questions/.test(p.requests[0]?.system ?? ''));
  }

  // ── Not hidden at all: the same page, ordinary radios ────────────────────
  {
    const p = boot(quiz(false), { installLayout: flat, reply: 'x' });
    const r = await p.scrape();
    check('visible radios work the same', r.isCanvas === true && r.elements.length === 8);
  }

  // ── One question, see-through choices: the ordinary path finds them ───────
  {
    const one = `<body><div role="main"><p>Workforce planning means deciding what work needs to be done and how to fill it.</p>
      ${choice(1, 'True', true)}${choice(1, 'False', true)}<button class="next-button">Next</button></div></body>`;
    const p = boot(one, { installLayout: flat, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: b => as(b, { action: 'click', index: Number(/\[(\d+)\] input type="radio" "True"/.exec(bodyText(b))?.[1]) }) });
    const r = await p.scrape();
    check('one question with see-through radios: they are listed', r.isCanvas !== true && r.elements.filter(e => e.type === 'radio').length === 2, r.elements.map(e => e.tag + ':' + e.type).join());
    p.pressPlay(); await settle(p);
    check('  and answered', p.w.document.getElementById('q1-True').checked);
  }

  // ── Connect has one question to a page: left as it was ───────────────────
  {
    const p = boot(quiz(), { installLayout: flat, url: 'https://learning.mheducation.com/smartbook/1', reply: 'x' });
    const r = await p.scrape();
    check('on Connect, two groups of choices are still taken as one page\'s question', r.isCanvas !== true, JSON.stringify(r.isCanvas));
  }

  // ── A rating scale beside a question is not a second question ─────────────
  {
    const html = `<body><div role="main"><p>Which of these is an asset? Pick the best answer from those below.</p>
      <label><input type="radio" name="a" aria-label="Cash"> Cash</label><label><input type="radio" name="a" aria-label="Debt"> Debt</label>
      <div class="scale">Confidence <label><input type="radio" name="c" aria-label="High"> High</label><label><input type="radio" name="c" aria-label="Low"> Low</label></div>
      <button class="next-button">Next</button></div></body>`;
    const p = boot(html, { installLayout: flat, reply: 'x' });
    const r = await p.scrape();
    check('a short rating scale next to a question does not make a quiz of it', r.isCanvas !== true, JSON.stringify(r.isCanvas));
  }

  // ── The label in the bar ─────────────────────────────────────────────────
  {
    const p = boot(quiz(), { installLayout: flat, reply: 'x' });
    const { kind } = await p.send({ type: 'DETECT_PAGE', host: 'school.instructure.com' });
    check('the bar says what it is', kind === 'Quiz page', kind);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll quiz-page checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
