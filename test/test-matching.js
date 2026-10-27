// A Connect matching question: "Match the classification with the correct
// description" — two labels with arrows to dashed drop boxes, and a pool of cards
// to drag into them. The run stopped with "Referred to item 0, which isn't on the
// page": nothing at all was in the list. Two ways that happens, both covered:
//
// - A matching question has no inputs, so a stray frame on the page with one
//   hidden input outscored the page the question is on, and the list was read from
//   the wrong frame. Now cards and buttons count when choosing, and a frame that
//   holds nothing is swapped for the busiest one.
// - Drag handles tagged by a newer library (hello-pangea's data-rfd-…, dnd-kit's
//   aria-roledescription) were not recognised, with or without role="button".
//
// And since the real markup could be something else again, "Copy page details" in
// the bar's settings says how the page is built, in every frame.
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
const indexOf = (body, label) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}`).exec(bodyText(body))?.[1]);
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const oneQuestion = { lastPresetIndex: 1, autoContinue: false };

const PAGE = (card = id => `data-rfd-drag-handle-draggable-id="${id}" data-rfd-draggable-id="${id}" tabindex="0"`) => `<body><div id="app">
  <h2>Matching Question</h2><p>Match the classification with the correct description.</p>
  <a href="#">Keyboard Help</a>
  <div class="row"><div class="label">Current liability</div><div class="zone" data-rfd-droppable-id="z1"></div></div>
  <div class="row"><div class="label">Long-term liability</div><div class="zone" data-rfd-droppable-id="z2"></div></div>
  <div class="pool" data-rfd-droppable-id="pool">
    <div class="card" ${card('a')}>Normally payable more than one year from now</div>
    <div class="card" ${card('b')}>Normally payable within one year</div>
  </div>
  <button aria-label="High Confidence">High</button><button>Medium</button><button>Low</button>
  <a href="#">Read About the Concept</a>
</div></body>`;

(async () => {
  // ── Cards tagged by hello-pangea, with no role: listed, and seen as a drag question ─
  {
    const p = boot(PAGE(), { installLayout: flat, url: CONNECT, storage: oneQuestion,
      reply: (b, n) => n === 1 ? as(b, { action: 'dragMove', index: indexOf(b, 'Normally payable within one year'), dir: 'up', steps: 1 }) : as(b, { action: 'none' }) });
    const r = await p.scrape();
    const texts = r.elements.map(e => e.text);
    check('the cards are in the list', texts.some(t => /more than one year/.test(t)) && texts.some(t => /within one year/.test(t)), texts.join(' | '));
    check('  and the page is seen as a drag question', r.isDrag === true);
    p.pressPlay();
    await settle(p);
    await wait(300);
    const keys = p.debuggerCalls.filter(c => c.type === 'keyDown' || c.type === 'rawKeyDown').map(c => c.key);
    check('a move is made with real keys: lift, up, drop', keys.join() === ' ,ArrowUp, ' || (keys[0] === ' ' && keys.includes('ArrowUp') && keys.at(-1) === ' '), keys.join('|'));
    check('  on the stronger model, as drag questions are', p.requests[0]?.model === 'claude-sonnet-5-5', p.requests[0]?.model);
  }

  // dnd-kit says it with aria-roledescription
  {
    const p = boot(PAGE(id => `aria-roledescription="draggable" tabindex="0" id="${id}"`), { installLayout: flat, url: CONNECT, reply: 'x' });
    const r = await p.scrape();
    check('dnd-kit style handles are listed and seen as drag too', r.isDrag === true && r.elements.some(e => /within one year/.test(e.text)), JSON.stringify(r.elements.map(e => e.text)));
  }

  // ── The wrong frame is chosen: nothing in it, so the busiest is used ─────
  {
    const p = boot(`<body><div role="main"><p>Click Done.</p><button id="done">Done</button><button>Other</button></div></body>`, {
      installLayout: flat, url: CONNECT, storage: oneQuestion,
      reply: (b, n) => n === 1 ? as(b, { action: 'click', index: indexOf(b, 'Done') }) : as(b, { action: 'none' })
    });
    // Two frames: the page (0), and a stray one (7) with a single hidden input, which outscores it
    p.bg.chrome.scripting.executeScript = async ({ func }) => {
      const src = String(func);
      if (/gridFields/.test(src)) return [{ frameId: 0, result: { fields: 0, choices: 0, drags: 0, buttons: 0, gridFields: 0 } }, { frameId: 7, result: { fields: 1, choices: 0, drags: 0, buttons: 0, gridFields: 0 } }];
      if (/a\[href\], input/.test(src)) return [{ frameId: 0, result: 12 }, { frameId: 7, result: 1 }];
      return [{ frameId: 0, result: {} }];
    };
    const real = p.bg.chrome.tabs.sendMessage;
    const asked = [];
    p.bg.chrome.tabs.sendMessage = (tabId, msg, opts, cb) => {
      if (opts?.frameId === 7) { asked.push(msg.type); setTimeout(() => cb(msg.type === 'SCRAPE' ? { text: '', elements: [] } : { success: true }), 0); return; }
      return real(tabId, msg, opts, cb);
    };
    let clicked = false;
    p.w.document.getElementById('done').addEventListener('click', () => { clicked = true; });
    p.pressPlay();
    const final = await settle(p);
    check('frame 7 chosen but empty: the run goes on to the page that has the question', asked.includes('SCRAPE') && clicked && !p.isError(), `${asked} clicked=${clicked} ${final}`);
  }

  // ── Nothing readable at all: said plainly, with what to do ────────────────
  {
    const p = boot('<body><div role="main"><p>Something drawn in a way nothing can read.</p></div></body>', {
      installLayout: flat, url: CONNECT, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    check('an empty list is explained, and points to Copy page details', p.isError() && /Couldn't see anything to click/.test(final) && /Copy page details/.test(final), final);
    check('  without a pointless retry', p.requests.length === 1, `${p.requests.length} calls`);
  }

  // ── Copy page details ─────────────────────────────────────────────────────
  {
    const p = boot(PAGE(), { installLayout: flat, url: CONNECT, reply: 'x' });
    const res = await p.send({ type: 'PAGE_DETAILS' });
    const d = JSON.parse(res.text);
    const f = d.frames[0];
    check('page details: the frames, with how many things are in each', d.frames.length >= 1 && f.elements > 10 && f.counts.buttons >= 3, JSON.stringify(f.counts));
    check('  the cards, with their attributes, so their library can be told', f.dragLike.some(c => /data-rfd-drag-handle-draggable-id/.test(c.attrs) && /one year/.test(c.text)), JSON.stringify(f.dragLike.slice(0, 2)));
    check('  and the page\'s own words', /Matching Question/.test(f.text), f.text);

    // the button in the bar copies it
    let copied = '';
    Object.defineProperty(p.w.navigator, 'clipboard', { value: { writeText: async t => { copied = t; } }, configurable: true });
    const btn = p.shadow().getElementById('copyDetails');
    check('the settings have the button', !!btn);
    btn.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await until(() => copied.length > 0, 8000);
    check('  and it puts the details on the clipboard', /"frames"/.test(copied) && /Matching Question/.test(copied), copied.slice(0, 120));
  }

  console.log(failed ? `\n${failed} failed` : '\nAll matching-question checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
