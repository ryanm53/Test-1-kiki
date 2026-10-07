// A real Connect SmartBook log (accounting, allowance for uncollectible
// accounts), replayed. Every question with a calculation in it went wrong:
//
// - The page text sent was empty. The page's first main/form is an empty one,
//   and the question only reached the model as "(question: ...)" beside each
//   element, cut to 120 characters — before the amounts it needed.
// - Haiku, given half a question, answered "none" or clicked the question's
//   own box, and the run stopped or failed to find Next.
//
// The page below has the same shape: an empty form first, the app after.
const { boot, settle, until } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice(PREFIX.length) : s;
};
const promptOf = body => body.messages[0].content;
const indexOf = (body, label) =>
  Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label.replace(/[$]/g, '\\$')}"`).exec(promptOf(body))?.[1]);

const flatLayout = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};

const CALC = 'On January 1, Clayton Carpentry reported a balance in the Allowance for Uncollectible '
  + 'Accounts of $5,000. During the year, $4,000 of uncollectible accounts were written off. At the '
  + 'end of the year, the company estimated uncollectible accounts of $9,000. As a result of the '
  + 'year-end adjusting entry, the Allowance for Uncollectible Accounts is:';
const WORDS = "At the beginning of the year, Gerta Company's allowance account has a positive balance "
  + 'of $10,000. This may indicate that the company\'s:';

const page = (question, choices) => `<body>
  <header>
    <form class="search"></form>
    <button>Exit Assignment</button><button>Progress information</button><button>Time Check</button>
  </header>
  <div role="main">
    <avalon-probe-renderer data-automation-id="probe">
      <h2>Multiple Choice Question</h2>
      <div class="prompt" id="prompt">${question}</div>
      <div class="choices">
        ${choices.map((c, i) => `<input type="radio" name="mc" id="c${i}" aria-label="${c}">`).join('\n')}
      </div>
    </avalon-probe-renderer>
    <button aria-label="High Confidence">High</button>
    <button aria-label="Medium Confidence">Medium</button>
    <button aria-label="Low Confidence">Low</button>
    <button class="next-button">Next Question</button>
  </div>
</body>`;

const CALC_CHOICES = ['decreased by $4,000', 'decreased by $9,000', 'increased by $7,000', 'increased by $3,000'];
const WORD_CHOICES = ['estimate of uncollectible accounts was too high.', "company's credit department is inefficient.",
                      "company's credit policy was too lenient.", 'estimate of uncollectible accounts was too low.'];

// Answer, confidence and Next, once — then stop, so each case is one question
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };

(async () => {
  // ── The whole question reaches the model, once, with its amounts ────────
  {
    const p = boot(page(CALC, CALC_CHOICES), {
      installLayout: flatLayout, storage: oneQuestion,
      reply: body => as(body, { action: 'click', index: indexOf(body, 'increased by $3,000') })
    });
    p.pressPlay();
    await settle(p);
    const prompt = p.requests[0] ? promptOf(p.requests[0]) : '';
    const pageText = /Page text:\n([^\n]*)/.exec(prompt)?.[1] ?? '';

    check('page text is the question area, not an empty form', pageText.includes('Clayton Carpentry'), JSON.stringify(pageText.slice(0, 80)));
    check('the question is there in full, amounts and all', prompt.includes('estimated uncollectible accounts of $9,000'));
    check('stated once, not cut short beside every element', !prompt.includes('(question:'));
    check('a question with sums in it goes to Sonnet 5.5 on Auto', p.requests[0]?.model === 'claude-sonnet-5-5', p.requests[0]?.model);
    check('picked the choice it was told to', p.w.document.getElementById('c3').checked);
  }

  // ── A question that is words, not sums, stays cheap ─────────────────────
  {
    const p = boot(page(WORDS, WORD_CHOICES), {
      installLayout: flatLayout, storage: oneQuestion,
      reply: body => as(body, { action: 'click', index: indexOf(body, WORD_CHOICES[0]) })
    });
    p.pressPlay();
    await settle(p);
    check('a one-amount wording question stays on Haiku', p.requests[0]?.model === 'claude-haiku-5-5', p.requests[0]?.model);
    check('and is answered in one call', p.requests.length === 1 && p.w.document.getElementById('c0').checked,
      `${p.requests.length} calls`);
  }

  // ── Haiku gives up: on Auto, Sonnet 5.5 gets one look before it stops ───
  {
    const p = boot(page(WORDS, WORD_CHOICES), {
      installLayout: flatLayout, storage: oneQuestion,
      reply: body => body.model === 'claude-haiku-5-5'
        ? as(body, { action: 'none' })
        : as(body, { action: 'click', index: indexOf(body, WORD_CHOICES[0]) })
    });
    let next = false;
    p.w.document.querySelector('.next-button').addEventListener('click', () => { next = true; });
    p.pressPlay();
    const final = await settle(p);
    check('"none" from Haiku is handed to Sonnet 5.5',
      p.requests.length === 2 && p.requests[1].model === 'claude-sonnet-5-5', p.requests.map(r => r.model).join(', '));
    check('which answers it, and it moves on', p.w.document.getElementById('c0').checked && next, final);
  }

  // ── Haiku clicks the question's own box: same, not "Next not found" ─────
  {
    const p = boot(page(WORDS, WORD_CHOICES), {
      installLayout: flatLayout, storage: oneQuestion,
      reply: body => body.model === 'claude-haiku-5-5'
        ? as(body, { action: 'click', index: /\[(\d+)\] avalon-probe-renderer/.exec(promptOf(body))[1] * 1 })
        : as(body, { action: 'click', index: indexOf(body, WORD_CHOICES[0]) })
    });
    p.pressPlay();
    const final = await settle(p);
    check('clicking no answer choice is handed to Sonnet 5.5 too',
      p.requests.length === 2 && p.requests[1].model === 'claude-sonnet-5-5', p.requests.map(r => r.model).join(', '));
    check('and the question gets answered', p.w.document.getElementById('c0').checked && !p.isError(), final);
  }

  // ── A model picked by hand is kept to, and stops honestly ───────────────
  {
    const p = boot(page(CALC, CALC_CHOICES), {
      installLayout: flatLayout, storage: { ...oneQuestion, autoUpgrade: false },
      reply: body => as(body, { action: 'none' })
    });
    p.pressPlay();
    await settle(p);
    await wait(300);
    check('with Auto off, Haiku stays Haiku, one call', p.requests.length === 1 && p.requests[0].model === 'claude-haiku-5-5',
      p.requests.map(r => r.model).join(', '));
  }

  // ── Answer only: the next question is noticed despite the empty form ────
  {
    let n = 0;
    const p = boot(page(WORDS, WORD_CHOICES), {
      installLayout: flatLayout, storage: { lastPresetIndex: 1, autoContinue: true },
      reply: body => { n++; return as(body, { action: 'click', index: indexOf(body, WORD_CHOICES[0]) }); }
    });
    p.pressPlay();
    await until(() => /Click Next when ready/.test(p.status()));
    // The student clicks Next; Connect swaps the question in place
    p.w.document.getElementById('prompt').textContent = 'Which of the following is a contra-asset account?';
    p.w.document.getElementById('c0').checked = false;
    await until(() => n >= 2);
    check('answer only: answers the next question once it appears', n >= 2, `${n} calls`);
    p.pressPlay();   // stop
  }

  console.log(failed ? `\n${failed} failed` : '\nAll Connect log checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
