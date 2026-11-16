// Connect fill-in-the-blank questions: a real log had eight of them fail the same way. The
// question was in the page's text and nothing at all was listed to type into, so the model
// could only guess "[0]" and the run stopped. When nothing on a page can be answered, the
// scan now looks harder: inside shadow roots, at see-through boxes, at role="textbox" and
// other kinds of editable. And when a list comes back empty anyway, the answer log keeps
// what the page is made of, so that the next fix is in the file that is sent.
const { boot, settle, until, bodyText } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
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
const oneQuestion = { lastPresetIndex: 1, autoContinue: false, keepLog: true };
const QUESTION = '<h2>Fill in the Blank Question</h2><p>Fill in the blank question.</p>';
const indexOf = (body, re) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*${re}`, 'i').exec(bodyText(body))?.[1]);

(async () => {
  // ── A box inside a shadow root ───────────────────────────────────────────
  {
    const p = boot(`<body><div role="main">${QUESTION}<p>An <span id="host"></span> investor is wealthy.</p><button>Read About the Concept</button></div></body>`,
      { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'blank'), value: 'angel' }] }) : as(b, { action: 'none' }) });
    const root = p.w.document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input type="text" aria-label="Blank">';
    const box = root.querySelector('input');
    const r = await p.scrape();
    check('a box in a shadow root is listed, named by its label', r.elements.some(e => e.tag === 'input' && /blank/i.test(e.text)), JSON.stringify(r.elements.map(e => e.text)));
    check('  and it comes first, with no empty-list probe', r.elements[0].tag === 'input' && r.empty === undefined);
    p.pressPlay();
    const final = await settle(p, 30000);
    check('  and it is typed into', box.value === 'angel' && !p.isError(), `${JSON.stringify(box.value)} / ${final}`);
  }

  // ── ...and the buttons that go with it, in the same shadow root ─────────
  {
    const clicks = [];
    const p = boot(`<body><div role="main">${QUESTION}<span id="host"></span></div></body>`,
      { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 0, autoContinue: false, keepLog: true }, reply: (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'Blank'), value: 'angel' }] }) : as(b, { action: 'none' }) });
    const root = p.w.document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p>An investor is wealthy.</p><input type="text" aria-label="Blank"><button aria-label="High Confidence">High</button><button class="next-button">Next Question</button>';
    root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => clicks.push(b.textContent.trim())));
    p.pressPlay();
    const final = await settle(p, 30000);
    await wait(500);
    check('the confidence rating and Next are pressed inside the shadow root too', clicks.join() === 'High,Next Question' && root.querySelector('input').value === 'angel', `${clicks} / ${final}`);
  }

  // ── A see-through box, with a search box in the page's header ───────────
  {
    const p = boot(`<body><header><input type="text" aria-label="Search contents"></header><div role="main">${QUESTION}<p><input id="b" type="text" style="opacity:0"> investors are wealthy.</p><button>Read About the Concept</button></div></body>`,
      { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'blank'), value: 'angel' }] }) : as(b, { action: 'none' }) });
    const r = await p.scrape();
    const blank = r.elements.find(e => e.tag === 'input' && e.text === 'the blank');
    check('a see-through box is listed as the blank, though the page has a search box too', !!blank, JSON.stringify(r.elements.map(e => `${e.tag}:${e.text}`)));
    p.pressPlay();
    const final = await settle(p, 30000);
    check('  and typed into', p.w.document.getElementById('b').value === 'angel', `${p.w.document.getElementById('b').value} / ${final}`);
  }

  // ── role="textbox", and a contenteditable the browser doesn't call editable ─
  {
    const p = boot(`<body><div role="main">${QUESTION}<p>A corporation is owned by its <span id="t" role="textbox" aria-label="Blank"></span>.</p><button>Read About the Concept</button></div></body>`,
      { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'Blank'), value: 'shareholders' }] }) : as(b, { action: 'none' }) });
    p.pressPlay();
    const final = await settle(p, 30000);
    check('role="textbox" is listed and typed into as text', p.w.document.getElementById('t').textContent === 'shareholders' && !p.isError(), `${p.w.document.getElementById('t').textContent} / ${final}`);
  }

  // ── What it leaves alone ─────────────────────────────────────────────────
  {
    // an ordinary page with a visible box: the list is as it always was
    const p = boot(`<body><div role="main">${QUESTION}<input type="text" aria-label="Blank"><button>Read About the Concept</button></div></body>`, { installLayout: flat, url: CONNECT, reply: 'x' });
    const r = await p.scrape();
    check('an ordinary blank is found the ordinary way, with no probe', r.elements.map(e => e.tag).join() === 'input,button' && r.empty === undefined, r.elements.map(e => e.tag).join());
    // the bar's own boxes are never taken for the page's
    const q = boot('<body><div role="main"><p>Nothing to answer here.</p></div></body>', { installLayout: flat, url: CONNECT, reply: 'x' });
    const e = await q.scrape();
    check('the control bar\'s own inputs are never listed as blanks', e.elements.length === 0, JSON.stringify(e.elements));
    check('  and an empty list says what the page is made of', e.empty && e.empty.frame === 'top' && typeof e.empty.buttons === 'number' && Array.isArray(e.empty.boxes), JSON.stringify(e.empty));
  }

  // ── The frame the question is read from: only one that is drawn ─────────
  // (what the log showed: Connect's eBook reader, in a frame that isn't displayed, has a
  // search box and buttons of its own and outscored a page with one blank and no choices;
  // scripts/real-chrome-blank.js has that page for real)
  {
    const page = `<body><div role="main">${QUESTION}<p><input id="b" type="text" aria-label="Blank 1 of 1"> investors are wealthy.</p><button>Read About the Concept</button></div></body>`;
    const frames = hidden => [
      { frameId: 0, result: { shown: true, fields: 1, choices: 0, drags: 0, buttons: 3, gridFields: 0, things: 5 } },
      // the reader and its contents list: more boxes and far more things, and not drawn
      { frameId: 7, result: hidden ? { shown: false, fields: 0, choices: 0, drags: 0, buttons: 0, gridFields: 0, things: 0 } : { shown: true, fields: 3, choices: 0, drags: 0, buttons: 10, gridFields: 0, things: 16 } },
      { frameId: 9, result: hidden ? { shown: false, fields: 0, choices: 0, drags: 0, buttons: 0, gridFields: 0, things: 0 } : { shown: true, fields: 1, choices: 0, drags: 0, buttons: 0, gridFields: 0, things: 81 } }
    ];
    const start = hidden => {
      const p = boot(page, { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'Blank'), value: 'angel' }] }) : as(b, { action: 'none' }) });
      p.bg.chrome.scripting.executeScript = async ({ func }) => /gridFields/.test(String(func)) ? frames(hidden) : [{ frameId: 0, result: {} }];
      const real = p.bg.chrome.tabs.sendMessage, asked = [];
      p.bg.chrome.tabs.sendMessage = (tabId, msg, opts, cb) => {
        if (opts?.frameId === 7 || opts?.frameId === 9) { asked.push(`${opts.frameId}:${msg.type}`); setTimeout(() => cb(msg.type === 'SCRAPE' ? { text: 'ContentsTable of Contents', elements: [] } : { success: true }), 0); return; }
        return real(tabId, msg, opts, cb);
      };
      return { p, asked };
    };
    // as the probe reports them: not drawn, so never chosen and never read
    const a = start(true);
    a.p.pressPlay();
    const final = await settle(a.p, 30000);
    check('frames that are not drawn are never the question\'s: the blank on the page is typed into', a.p.w.document.getElementById('b').value === 'angel' && !a.p.isError(), `${a.p.w.document.getElementById('b').value} / ${final}`);
    check('  and nothing is read from them', !a.asked.some(x => /SCRAPE/.test(x)), a.asked.join());
    check('  nor their text put in front of the model', !/ContentsTable/.test(bodyText(a.p.requests[0])));

    // drawn, outscoring the page, and holding nothing to act on: the others in turn, best first
    const b = start(false);
    b.p.pressPlay();
    const final2 = await settle(b.p, 30000);
    check('a frame chosen that turns out empty: the rest are tried in turn until one has the question', b.p.w.document.getElementById('b').value === 'angel' && !b.p.isError(), `${b.p.w.document.getElementById('b').value} / ${final2}`);
    check('  the likeliest first', b.asked.filter(x => /SCRAPE/.test(x)).join() === '7:SCRAPE', b.asked.join());
  }

  // ── A blank answered wrong is remembered, by the page's words ────────────
  {
    const blankPage = sentence => `<body><div role="main">${QUESTION}<p><input id="b" type="text" aria-label="Blank 1 of 1"> ${sentence}</p><div id="slot"></div>
      <button aria-label="High Confidence">High</button><button class="next-button">Next Question</button></div></body>`;
    const ANGEL = 'investors are wealthy individuals in the business community willing to risk investment funds on a promising business venture.';
    const fill = word => (b, n) => n === 1 ? as(b, { action: 'fill', fills: [{ index: indexOf(b, 'Blank 1 of 1'), value: word }] }) : as(b, { action: 'none' });
    const first = boot(blankPage(ANGEL), { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 0, autoContinue: false, keepLog: true }, reply: fill('Venture') });
    const d = first.w.document;
    // the rating grades it; Next moves on
    d.querySelector('[aria-label="High Confidence"]').addEventListener('click', () => {
      d.getElementById('slot').innerHTML = '<div>Your Answer <span>incorrect</span></div><div><h4>Correct Answer</h4><p>Angel</p></div>';
    });
    d.querySelector('.next-button').addEventListener('click', () => { d.getElementById('slot').innerHTML = ''; });
    first.pressPlay();
    const final = await settle(first, 60000);
    await until(() => first.store.answerBook && Object.keys(first.store.answerBook).length > 0, 8000).catch(() => {});
    const entry = Object.values(first.store.answerBook ?? {})[0];
    check('a blank answered wrong: what Connect showed as right is kept', /Angel/.test(entry?.n ?? ''), `${JSON.stringify(first.store.answerBook)} / ${final}`);

    const again = boot(blankPage(ANGEL), { installLayout: flat, url: CONNECT, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: fill('Angel') });
    again.pressPlay();
    await settle(again, 30000);
    check('  the next time that blank comes up, the model is told the right word', /came up before/.test(bodyText(again.requests[0])) && /Angel/.test(bodyText(again.requests[0]).split('came up before')[1] ?? ''), bodyText(again.requests[0]).slice(0, 200));

    // every blank is called "Blank 1 of 1": another sentence is another question
    const other = boot(blankPage('A corporation is owned by its shareholders, who elect the board.'), { installLayout: flat, url: CONNECT, storage: { ...oneQuestion, answerBook: first.store.answerBook }, reply: fill('x') });
    other.pressPlay();
    await settle(other, 30000);
    check('  a blank in another sentence gets no such note', !/came up before/.test(bodyText(other.requests[0])));
  }

  // ── An empty list is kept, with the page's structure, in the answer log ──
  {
    const p = boot('<body><div role="main"><p>Fill in the blank question. A thing is its ___.</p></div></body>',
      { installLayout: flat, url: CONNECT, storage: oneQuestion, reply: (b, n) => as(b, { action: 'fill', fills: [{ index: 0, value: 'x' }] }) });
    p.pressPlay();
    await settle(p, 30000);
    await until(() => (p.store.answerLog ?? []).length > 0, 8000);
    const entry = p.store.answerLog?.[0];
    check('the entry has details of the page', !!entry?.details && entry.details.empty?.frame === 'top' && typeof entry.details.page === 'string', JSON.stringify(entry?.details).slice(0, 200));
    check('  the frames, boxes and shadow roots among them', /"frames"/.test(entry?.details?.page ?? '') && /shadowHosts/.test(entry?.details?.page ?? '') && /"boxes"/.test(entry?.details?.page ?? ''), (entry?.details?.page ?? '').slice(0, 200));
    check('  and the run still says what to do', /Copy page details/.test(entry?.outcome ?? ''), entry?.outcome);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll blank-box checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
