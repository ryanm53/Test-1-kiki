// Canvas Classic Quizzes, end to end: the real background and content scripts
// on Canvas's markup, with only Claude's reply faked.
const { boot, settle, until } = require('./harness');
const { ALL_ON_ONE_PAGE, ONE_AT_A_TIME, installLayout } = require('./fixtures-canvas');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const checked = (w, id) => w.document.getElementById(id).checked;

(async () => {
  // ── 1. What Claude is shown ────────────────────────────────────────────
  {
    const page = boot(ALL_ON_ONE_PAGE, { installLayout, reply: '' });
    const r = await page.scrape();
    const el = r.elements;
    check('recognised as Canvas', r.isCanvas === true);
    check('every question on the page, not just the ones on screen',
      el.length === 14, `${el.length} elements`);
    check('only answer inputs — no sidebar links, no Submit Quiz',
      el.every(e => e.tag === 'input'), el.map(e => e.tag + ':' + e.text).join(', '));
    check('each choice names its own question',
      el[1].text === 'Cash' && /Question 1: Which of the following is an asset/.test(el[1].question)
      && el[12].text === 'Unearned revenue' && /Question 4: Select all/.test(el[12].question),
      `${el[1].question} | ${el[12].question}`);
    check('no typed blanks on this page', r.hasBlanks === false);

    page.w.document.getElementById('question_101_answer_1').checked = true;
    const again = await page.scrape();
    check('an already-ticked choice is marked', again.elements[1].selected === true
      && !again.elements[0].selected);
  }

  // ── 2. A whole page answered in one go ─────────────────────────────────
  {
    // Cash, True, A = L + E, Notes payable + Unearned revenue
    const page = boot(ALL_ON_ONE_PAGE, { installLayout, reply: 'clickMany","indexes":[1,4,6,10,12]}' });
    let submitted = false;
    page.w.document.getElementById('submit_quiz_button')
      .addEventListener('click', e => { submitted = true; e.preventDefault(); });

    page.pressPlay();
    const final = await settle(page);
    const w = page.w;

    check('Q1 answered', checked(w, 'question_101_answer_1'));
    check('Q2 answered', checked(w, 'question_102_answer_0'));
    check('Q3 answered', checked(w, 'question_103_answer_0'));
    check('Q4 both correct boxes ticked',
      checked(w, 'question_104_answer_0') && checked(w, 'question_104_answer_2'));
    check('Q4 wrong boxes left alone',
      !checked(w, 'question_104_answer_1') && !checked(w, 'question_104_answer_3'));
    check('Submit Quiz never pressed', !submitted);
    check('one API call for the whole page', page.requests.length === 1, `${page.requests.length}`);
    check('prompt tells Claude to answer every question',
      /SEVERAL questions/.test(page.requests[0]?.system ?? ''));
    check('prompt includes the last question, not just the first screenful',
      JSON.stringify(page.requests[0]?.messages).includes('Select all that are liabilities'));
    check('ends with a calm note, not an error',
      /Check it over, then submit/.test(final) && !page.isError(), final);
    check('does not go round again', (await wait(300), page.requests.length === 1));
    check('leaves no note to resume from',
      w.sessionStorage.getItem('__pageAgentResume') === null);
  }

  // ── 3. One question at a time: answer, then Next ───────────────────────
  {
    const page = boot(ONE_AT_A_TIME, { installLayout, reply: 'click","index":0}' });
    let nextClicked = false, submitted = false;
    page.w.document.querySelector('.next-question').addEventListener('click', () => { nextClicked = true; });
    page.w.document.getElementById('submit_quiz_button')
      .addEventListener('click', e => { submitted = true; e.preventDefault(); });

    page.pressPlay();
    await until(() => nextClicked);

    check('answered', checked(page.w, 'question_102_answer_0'));
    check('pressed Next', nextClicked);
    check('never pressed Submit Quiz', !submitted);
    check('left a note so the loop survives the page load',
      page.w.sessionStorage.getItem('__pageAgentResume') !== null);

    page.pressPlay();   // stop
    check('Stop removes the note', page.w.sessionStorage.getItem('__pageAgentResume') === null);
  }

  // ── 4. Arriving on the next page picks the loop back up ────────────────
  {
    const fresh = JSON.stringify({ at: Date.now() - 2000, answered: 3 });
    const page = boot(ONE_AT_A_TIME, {
      installLayout, reply: 'click","index":0}',
      beforeLoad: w => w.sessionStorage.setItem('__pageAgentResume', fresh)
    });
    await until(() => page.requests.length >= 1);
    check('carries on by itself', page.requests.length >= 1, `${page.requests.length} requests`);
    check('keeps counting from where it was', /· 4/.test(page.status()), page.status());
    page.pressPlay();
  }
  {
    const stale = JSON.stringify({ at: Date.now() - 10 * 60 * 1000, answered: 3 });
    const page = boot(ONE_AT_A_TIME, {
      installLayout, reply: 'click","index":0}',
      beforeLoad: w => w.sessionStorage.setItem('__pageAgentResume', stale)
    });
    await wait(2000);
    check('an old note does nothing', page.requests.length === 0, `${page.requests.length} requests`);
  }

  // ── 5. Back on a question that's already answered ─────────────────────
  {
    const page = boot(ONE_AT_A_TIME, {
      installLayout, storage: { autoContinue: false }, reply: 'none"}'
    });
    page.w.document.getElementById('question_102_answer_1').checked = true;
    let nextClicked = false;
    page.w.document.querySelector('.next-question').addEventListener('click', () => { nextClicked = true; });

    page.pressPlay();
    const final = await settle(page);
    check('an answered question moves on instead of giving up', nextClicked, final);
    check('and says nothing is wrong', !page.isError(), final);
  }

  // ── 6. Connect is untouched ─────────────────────────────────────────────
  {
    const connect = `<body><div role="main">
      <div class="prompt">Which is an asset?</div>
      <input type="radio" id="r1" aria-label="Cash"><input type="radio" id="r2" aria-label="Revenue">
      <button class="btn-confidence" aria-label="High Confidence">High</button>
      <button class="next-button">Next Question</button></div></body>`;
    const page = boot(connect, {
      installLayout: w => {
        w.HTMLElement.prototype.getBoundingClientRect = () =>
          ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
        w.HTMLElement.prototype.scrollIntoView = () => {};
      },
      reply: ''
    });
    const r = await page.scrape();
    check('a Connect question is not treated as Canvas', !r.isCanvas);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll Canvas checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
