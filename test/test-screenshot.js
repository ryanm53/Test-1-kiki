// When the text of a page isn't enough to read a question — a chart or table
// drawn as a picture, hardly any text at all, or the model finding nothing to
// answer — the visible part of the tab goes to Claude as an image too. Only
// then, only of the tab being looked at, and never for SIMnet.
const { boot, settle } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const PREFIX = '{"action":"';
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice(PREFIX.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 300, height: 120, top: 10, bottom: 130, left: 10, right: 310 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };
const content = req => req?.messages?.[0]?.content;
const hasImage = req => Array.isArray(content(req)) && content(req).some(b => b.type === 'image');
const textOf = req => Array.isArray(content(req)) ? content(req).find(b => b.type === 'text')?.text : content(req);

const CHOICES = `<input type="radio" id="a" aria-label="Option A"><input type="radio" id="b" aria-label="Option B">
  <button class="next-button">Next</button>`;
const WORDS = '<p class="prompt">Which of the following best describes how the allowance method treats a write-off of a specific account?</p>';

(async () => {
  // A question with a picture in it
  {
    const p = boot(`<body><div role="main">${WORDS}<img src="exhibit.png" alt="">${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    const req = p.requests[0];
    check('a picture in the question: a screenshot is sent with it', hasImage(req), JSON.stringify(content(req))?.slice(0, 120));
    const img = Array.isArray(content(req)) ? content(req).find(b => b.type === 'image') : null;
    check('as a jpeg image block, with the picture\'s data', img?.source?.type === 'base64' && img.source.media_type === 'image/jpeg' && img.source.data === '/9j/AAAA', JSON.stringify(img?.source));
    check('and the model is told it is there', /screenshot of the page is attached/.test(textOf(req) ?? ''));
    check('the text of the question goes too', /allowance method/.test(textOf(req) ?? ''));
    check('the capture asked for the tab\'s window, as a jpeg', p.screenshots.length === 1 && p.screenshots[0].format === 'jpeg', JSON.stringify(p.screenshots));
    check('the question is answered', p.w.document.getElementById('a').checked && !p.isError(), final);
  }

  // An ordinary page of words: no picture, no screenshot
  {
    const p = boot(`<body><div role="main">${WORDS}${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('a page of words: nothing captured, plain text request',
      p.screenshots.length === 0 && typeof content(p.requests[0]) === 'string', `${p.screenshots.length} captures`);
  }

  // The page's own logo and icons don't count
  {
    const p = boot(`<body><header><img src="logo.png" alt="logo"></header><div role="main">${WORDS}${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('a logo in the header is not a picture to read', p.screenshots.length === 0);
  }

  // Almost no text: the question is drawn
  {
    const p = boot(`<body><div role="main"><canvas></canvas>${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('a question with no text of its own: a screenshot', hasImage(p.requests[0]));
  }

  // The text gave the model nothing: a look at the page before a stronger model
  {
    const p = boot(`<body><div role="main">${WORDS}${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion,
        reply: b => hasImage(b) ? as(b, { action: 'click', index: 1 }) : as(b, { action: 'none' }) });
    p.pressPlay();
    const final = await settle(p);
    const seen = p.requests.map(r => `${r.model}${hasImage(r) ? '+shot' : ''}`).join(', ');
    check('"none" from the text alone: tried again with a screenshot, on the same model',
      p.requests.length === 2 && !hasImage(p.requests[0]) && hasImage(p.requests[1]) && p.requests[0].model === p.requests[1].model, seen);
    check('and the answer from the picture is used', p.w.document.getElementById('b').checked && !p.isError(), final);
  }

  // A table or a worksheet with a picture: the stronger model reads it
  {
    const html = `<body><div role="main"><p>Capetown sold 580 units. Ending inventory is: $784, $1,215, $864 or $1,102?</p><img src="exhibit.png" alt="">${CHOICES}</div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('a question with sums AND a picture: Haiku reads it, picture and all',
      hasImage(p.requests[0]) && p.requests[0].model === 'claude-haiku-5-5', `${p.requests[0]?.model}`);
  }
  {
    const html = `<body><div role="main">${WORDS}<img src="exhibit.png" alt="">${CHOICES}</div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('an ordinary question with a picture stays on Haiku, picture and all',
      hasImage(p.requests[0]) && p.requests[0].model === 'claude-haiku-5-5', `${p.requests[0]?.model}`);
  }
  {
    const html = `<body><div role="main"><p>Capetown sold 580 units. Ending inventory is: $784, $1,215, $864 or $1,102?</p>${CHOICES}</div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion, reply: b => as(b, { action: 'none' }) });
    p.pressPlay();
    await settle(p);
    const seen = p.requests.map(r => `${r.model}${hasImage(r) ? '+shot' : ''}`).join(', ');
    check('when it gives up, Auto steps up to Sonnet, and the picture goes with it',
      /claude-sonnet-5-5\+shot$/.test(seen), seen);
  }

  // The tab isn't the one showing: a capture would be of another page
  {
    const p = boot(`<body><div role="main">${WORDS}<img src="exhibit.png" alt="">${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, tabHidden: true, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    check('a background tab is never captured; the question goes by its text',
      p.screenshots.length === 0 && !hasImage(p.requests[0]) && p.w.document.getElementById('a').checked, `${p.screenshots.length} captures, ${final}`);
  }

  // A capture that fails must not stop the question
  {
    const p = boot(`<body><div role="main">${WORDS}<img src="exhibit.png" alt="">${CHOICES}</div></body>`,
      { installLayout: flat, storage: oneQuestion, captureFails: true, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    check('a failed capture: answered from the text instead, no error',
      !hasImage(p.requests[0]) && p.w.document.getElementById('a').checked && !p.isError(), final);
  }

  // SIMnet: not on every step, only when a task is going wrong
  {
    const cells = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell has-value" id="cell-A${i + 1}" tabindex="0">${i}</td>`).join('');
    const page = `<body><div role="main"><p>Rename the sheet.</p><span>1 of 3 Attempts</span><img src="x.png" alt=""><button class="shell-btn">Home</button>
      <table><tr>${cells}</tr></table></div></body>`;
    // Clicks Home, then claims to be done — which nothing graded, twice
    const p = boot(page, { installLayout: flat, storage: { mode: 'one' },
      reply: (b, n) => as(b, n === 1 ? { action: 'click', index: 0 } : { action: 'none' }) });
    p.pressPlay();
    await settle(p);
    const shots = p.requests.map(r => hasImage(r));
    check('SIMnet: the first looks are text only', shots[0] === false && shots[1] === false, shots.join());
    check('SIMnet: once a "done" goes ungraded, the next step comes with a screenshot',
      shots.length >= 3 && shots[2] === true && p.requests[2].model === 'claude-haiku-5-5', `${shots.join()} ${p.requests[2]?.model}`);
  }
  {
    const cells = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell has-value" id="cell-A${i + 1}" tabindex="0">${i}</td>`).join('');
    const p = boot(`<body><div role="main"><p>Rename the sheet.</p><img src="x.png" alt=""><button class="shell-btn">Home</button>
      <table><tr>${cells}</tr></table></div></body>`, { installLayout: flat, storage: { mode: 'one' }, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('SIMnet: a run going well takes no screenshots', p.screenshots.length === 0, `${p.screenshots.length}`);
  }

  // The answer log says there was a picture, without keeping it
  {
    const p = boot(`<body><div role="main">${WORDS}<img src="exhibit.png" alt="">${CHOICES}</div></body>`,
      { installLayout: flat, storage: { ...oneQuestion, keepLog: true }, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    const step = p.store.answerLog?.[0]?.steps?.[0];
    check('the log notes the screenshot and keeps no image data',
      /a screenshot of the page was attached/.test(step?.prompt ?? '') && !JSON.stringify(p.store.answerLog).includes('/9j/AAAA'));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll screenshot checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
