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
