// Numbers on the screenshot, like Vimium's hints: for the instant of a capture,
// every listed item that's on screen is tagged with its number from the list.
// What's checked, and why it matters on a real exam page:
//   - the tags carry the SAME numbers as the list the model is given;
//   - they're up while the screen is captured, and gone straight after —
//     whatever happens (capture fails, page won't answer, run stopped);
//   - they never take a click, never change the page, never leak into what the
//     extension reads;
//   - they stay on screen and off each other, however crowded.
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
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };
const VW = 1024, VH = 768;   // jsdom's window

// Layout from data-box="left,top,width,height"; anything else is a small box
// near the top. (jsdom has no layout engine.)
const layout = w => {
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const b = this.getAttribute && this.getAttribute('data-box');
    const [x, y, ww, hh] = b ? b.split(',').map(Number) : [10, 10, 80, 20];
    return { left: x, top: y, width: ww, height: hh, right: x + ww, bottom: y + hh, x, y };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const hasImage = req => Array.isArray(req?.messages?.[0]?.content) && req.messages[0].content.some(b => b.type === 'image');
const words = req => {
  const m = req?.messages?.[0]?.content;
  return Array.isArray(m) ? m.find(b => b.type === 'text')?.text ?? '' : m ?? '';
};
const marksUp = w => w.document.querySelectorAll('#__cap-marks').length;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// A page of N buttons at the given positions, plus choices
const buttons = (boxes, extra = '') => `<body><div role="main"><p>Pick the right one of these items on the screen please.</p>
  ${boxes.map((b, i) => `<button data-box="${b}" id="b${i}">Item ${i}</button>`).join('')}${extra}</div></body>`;

(async () => {
  // ── The tags carry the list's own numbers ───────────────────────────────
  {
    const grid = Array.from({ length: 12 }, (_, i) => `${20 + (i % 4) * 150},${100 + Math.floor(i / 4) * 60},120,30`);
    const p = boot(buttons(grid), { installLayout: layout });
    const data = await p.scrape();                         // the list the model would be given
    const res = await p.toPage({ type: 'MARK' });
    check('every listed item on screen is tagged', res.marked === data.elements.length, `${res.marked} tagged, ${data.elements.length} listed`);
    const nums = res.boxes.map(b => b.i);
    check('with its own number from the list, in order', nums.join() === data.elements.map((_, i) => i).join(), nums.join());
    check('each tag is on its item\'s corner (or just clear of it)', res.boxes.every(b => {
      const el = p.w.document.getElementById('b' + (b.i - (data.elements.length - 12)));
      return !el || (Math.abs(b.x - Number(el.dataset.box.split(',')[0])) < 90 && Math.abs(b.y - Number(el.dataset.box.split(',')[1])) < 90);
    }));
    check('and each is outlined', res.outlined === res.marked, `${res.outlined} outlines`);
    await p.toPage({ type: 'UNMARK' });
    check('UNMARK takes every tag down', marksUp(p.w) === 0);
  }

  // ── Off screen, hidden, tiny, huge ──────────────────────────────────────
  {
    // A worksheet lists its blanks wherever they are; only those in view get a tag
    const rows = Array.from({ length: 8 }, (_, i) => `<tr><td>Row ${i}</td><td><input data-box="100,${i < 4 ? 100 + i * 40 : 2000 + i * 40},90,24"></td></tr>`).join('');
    const p = boot(`<body><div role="main"><p>Enter the amounts for each line below, please.</p><table>${rows}</table></div></body>`, { installLayout: layout });
    const data = await p.scrape();
    const res = await p.toPage({ type: 'MARK' });
    check('a worksheet lists all 8 blanks but only the 4 in view are tagged', data.elements.length === 8 && res.marked === 4, `${data.elements.length} listed, ${res.marked} tagged`);
    check('and the numbers are the right ones (0-3)', res.boxes.map(b => b.i).join() === '0,1,2,3', res.boxes.map(b => b.i).join());
    await p.toPage({ type: 'UNMARK' });
  }
  {
    // A sliver, a clipped edge, a container filling the screen
    const p = boot(buttons(['10,10,1,1', '-30,100,60,30', '1000,700,200,200', '0,0,1024,768', '500,300,100,40']), { installLayout: layout });
    const data = await p.scrape();
    const res = await p.toPage({ type: 'MARK' });
    const named = i => data.elements[i]?.text;
    check('a 1-pixel sliver is not tagged', !res.boxes.some(b => named(b.i) === 'Item 0'), JSON.stringify(res.boxes.map(b => named(b.i))));
    check('one half off the edge still is, with its tag on screen', res.boxes.some(b => named(b.i) === 'Item 1'));
    check('every tag lies inside the window', res.boxes.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= VW && b.y + b.h <= VH), JSON.stringify(res.boxes.filter(b => b.x < 0 || b.y < 0 || b.x + b.w > VW || b.y + b.h > VH)));
    check('one filling the whole screen is tagged but not framed', res.outlined === res.marked - 1, `${res.marked} tags, ${res.outlined} outlines`);
    await p.toPage({ type: 'UNMARK' });
  }

  // ── Crowded: tags keep off each other ───────────────────────────────────
  {
    const same = Array.from({ length: 20 }, () => '300,300,80,20');
    const p = boot(buttons(same), { installLayout: layout });
    await p.scrape();
    const res = await p.toPage({ type: 'MARK' });
    let clashes = 0;
    for (let a = 0; a < res.boxes.length; a++) for (let b = a + 1; b < res.boxes.length; b++) if (overlap(res.boxes[a], res.boxes[b])) clashes++;
    check('20 items on one spot: every one tagged, none on top of another', res.marked === 20 && clashes === 0, `${res.marked} tagged, ${clashes} overlapping pairs`);
    await p.toPage({ type: 'UNMARK' });
  }
  {
    const many = Array.from({ length: 220 }, (_, i) => `${(i % 20) * 50},${Math.floor(i / 20) * 40},40,24`);
    const p = boot(buttons(many), { installLayout: layout });
    await p.scrape();
    const res = await p.toPage({ type: 'MARK' });
    check('a screen of items is capped at 150 tags', res.marked <= 150, `${res.marked}`);
    check('even crowded, every tag stays inside the window', res.boxes.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= VW && b.y + b.h <= VH));
    await p.toPage({ type: 'UNMARK' });
  }

  // ── They change nothing, take no clicks, and aren't read ────────────────
  {
    const p = boot(buttons(['100,100,100,30', '300,100,100,30']), { installLayout: layout });
    const before = p.w.document.body.innerHTML;
    const textBefore = p.w.document.body.innerText;
    const listBefore = JSON.stringify((await p.scrape()).elements);
    await p.toPage({ type: 'MARK' });
    const host = p.w.document.getElementById('__cap-marks');
    check('the layer takes no clicks (pointer-events: none)', host?.style.pointerEvents === 'none');
    check('and is hidden from assistive tech', host?.getAttribute('aria-hidden') === 'true');
    check('the page\'s own markup is untouched while it is up', p.w.document.body.innerHTML === before);
    check('and what the page reads as is unchanged', p.w.document.body.innerText === textBefore);
    check('and its text isn\'t in the shadow root where a page script could read it (closed)', host?.shadowRoot === null);
    const listDuring = JSON.stringify((await p.scrape()).elements);
    check('scraping with the tags up gives the same list', listDuring === listBefore);
    await p.toPage({ type: 'UNMARK' });
    check('after UNMARK the page is exactly as it was', p.w.document.body.innerHTML === before && marksUp(p.w) === 0);
  }

  // ── MARK twice, UNMARK with nothing up ──────────────────────────────────
  {
    const p = boot(buttons(['100,100,100,30']), { installLayout: layout });
    await p.scrape();
    await p.toPage({ type: 'MARK' }); await p.toPage({ type: 'MARK' });
    check('MARK twice leaves one layer, not two', marksUp(p.w) === 1, `${marksUp(p.w)}`);
    await p.toPage({ type: 'UNMARK' }); const again = await p.toPage({ type: 'UNMARK' });
    check('UNMARK with none up is harmless', again.ok === true && marksUp(p.w) === 0);
    await p.toPage({ type: 'UNMARK' });
  }
  {
    // Nothing has been scraped, so nothing is listed
    const p = boot(buttons(['100,100,100,30']), { installLayout: layout });
    const none = await p.toPage({ type: 'MARK' });
    check('MARK before any scrape tags nothing, and does no harm', none.marked === 0 && none.boxes.length === 0, JSON.stringify(none));
    await p.toPage({ type: 'UNMARK' });
    check('and leaves nothing up', marksUp(p.w) === 0);
  }
  {
    // An item that has left the page since the list was made is skipped, not an error
    const p = boot(buttons(['100,100,100,30', '300,100,100,30']), { installLayout: layout });
    await p.scrape();
    p.w.document.getElementById('b0').remove();
    const res = await p.toPage({ type: 'MARK' });
    check('an item gone since the list was made is skipped, the rest still tagged', res.marked >= 1 && !res.error, JSON.stringify(res));
    await p.toPage({ type: 'UNMARK' });
  }
  {
    // A button inside the control bar's own host never gets a tag
    const p = boot(buttons(['100,100,100,30']), { installLayout: layout });
    await p.scrape();
    const res = await p.toPage({ type: 'MARK' });
    check('the control bar is never tagged', !res.boxes.some(b => b.i < 0), '');
    await p.toPage({ type: 'UNMARK' });
  }
  {
    const p = boot(buttons(['100,100,100,30']), { installLayout: layout });
    await p.scrape();
    await p.toPage({ type: 'MARK' });
    await wait(6400);
    check('if UNMARK never comes, the tags take themselves down within 6 seconds', marksUp(p.w) === 0, `${marksUp(p.w)} still up`);
  }

  // ── In a run: up for the capture, down after ────────────────────────────
  {
    let seen = null;
    const html = `<body><div role="main"><p>Which of these is an asset? Choose the right answer.</p><img src="x.png" alt="" data-box="400,50,300,150">
      <input type="radio" id="a" aria-label="Cash" data-box="50,300,16,16"><input type="radio" id="b" aria-label="Revenue" data-box="50,340,16,16">
      <button class="next-button" data-box="50,400,100,30">Next</button></div></body>`;
    const p = boot(html, { installLayout: layout, storage: oneQuestion,
      onCapture: w => { seen = { up: marksUp(w), pe: w.document.getElementById('__cap-marks')?.style.pointerEvents }; },
      reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    const req = p.requests[0];
    check('the tags are up at the instant the screen is captured', seen?.up === 1 && seen.pe === 'none', JSON.stringify(seen));
    check('and gone once the run is over', marksUp(p.w) === 0);
    const types = p.pageMessages.map(m => m.type).filter(t => ['SCRAPE', 'MARK', 'UNMARK'].includes(t));
    const iMark = types.indexOf('MARK'), iUn = types.indexOf('UNMARK');
    check('the order is scrape, mark, capture, unmark', types[0] === 'SCRAPE' && iMark > 0 && iUn > iMark, types.join());
    check('the picture is sent, and the model is told the tags are the list\'s numbers',
      hasImage(req) && /tagged in it with a small yellow number/.test(words(req)) && /off screen/.test(words(req)), words(req).slice(0, 150));
    check('the run still answers', p.w.document.getElementById('a').checked && !p.isError(), final);
  }

  // ── When things go wrong, the tags still come down ──────────────────────
  {
    const html = buttons(['100,100,100,30']).replace('</div></body>', '<img src="x.png" alt="" data-box="400,50,300,150"><input type="radio" aria-label="A"><input type="radio" aria-label="B"><button class="next-button">Next</button></div></body>');
    const p = boot(html, { installLayout: layout, storage: oneQuestion, captureFails: true, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    check('a capture that fails: tags taken down, question still answered',
      marksUp(p.w) === 0 && p.pageMessages.some(m => m.type === 'UNMARK') && !p.isError(), final);
  }
  {
    const html = buttons(['100,100,100,30']).replace('</div></body>', '<img src="x.png" alt="" data-box="400,50,300,150"><input type="radio" aria-label="A"><input type="radio" aria-label="B"><button class="next-button">Next</button></div></body>');
    const p = boot(html, { installLayout: layout, storage: oneQuestion, ignore: ['MARK'], reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    const final = await settle(p);
    const req = p.requests[0];
    check('a page that never answers MARK: the capture goes ahead without tags',
      hasImage(req) && !/small yellow number/.test(words(req)) && /screenshot of the page is attached/.test(words(req)), words(req).slice(0, 120));
    check('and UNMARK is still sent, and the question answered', p.pageMessages.some(m => m.type === 'UNMARK') && !p.isError(), final);
  }
  {
    const html = buttons(['100,100,100,30']).replace('</div></body>', '<img src="x.png" alt="" data-box="400,50,300,150"><input type="radio" aria-label="A"><input type="radio" aria-label="B"><button class="next-button">Next</button></div></body>');
    const p = boot(html, { installLayout: layout, storage: oneQuestion, tabHidden: true, reply: b => as(b, { action: 'click', index: 0 }) });
    p.pressPlay();
    await settle(p);
    check('a tab that isn\'t showing: nothing drawn at all, not even briefly',
      !p.pageMessages.some(m => m.type === 'MARK') && marksUp(p.w) === 0);
  }

  // ── Chrome hands back a stale picture: the extension notices, and looks again ──
  const picPage = () => `<body><div role="main"><p>Which of these is an asset? Choose the right answer please.</p><img src="x.png" alt="" data-box="400,50,300,150">
    <input type="radio" id="a" aria-label="Cash"><input type="radio" id="b" aria-label="Revenue"><button class="next-button">Next</button></div></body>`;
  {
    // The first two captures have no tags in them; the third does
    const p = boot(picPage(), { installLayout: layout, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    let counted = 0;
    p.bg.tagPixels = async () => (++counted < 3 ? 0 : 5000);
    p.pressPlay();
    const final = await settle(p);
    check('a capture without the tags is taken again until they show', p.screenshots.length === 3 && counted === 3, `${p.screenshots.length} captures`);
    check('and once they show, the model is told they are there', /small yellow number/.test(words(p.requests[0])), words(p.requests[0]).slice(0, 100));
    check('the tags are down after, and the question answered', marksUp(p.w) === 0 && p.w.document.getElementById('a').checked && !p.isError(), final);
  }
  {
    // They never show: three tries, then the model is told there are none
    const p = boot(picPage(), { installLayout: layout, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.bg.tagPixels = async () => 0;
    p.pressPlay();
    const final = await settle(p);
    const req = p.requests[0];
    check('tags that never show: no more than three captures', p.screenshots.length === 3, `${p.screenshots.length}`);
    check('and the model is not told there are tags in a picture that has none',
      hasImage(req) && !/small yellow number/.test(words(req)) && /screenshot of the page is attached/.test(words(req)), words(req).slice(0, 120));
    check('the tags are still taken down, and the question answered', marksUp(p.w) === 0 && p.pageMessages.some(m => m.type === 'UNMARK') && !p.isError(), final);
  }
  {
    // A counter that can't count (no canvas): trusted, one capture
    const p = boot(picPage(), { installLayout: layout, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.bg.tagPixels = async () => null;
    p.pressPlay();
    await settle(p);
    check('where the pixels can\'t be counted the tags are taken to be there, one capture',
      p.screenshots.length === 1 && /small yellow number/.test(words(p.requests[0])));
  }
  {
    // A counter that throws must not break the run
    const p = boot(picPage(), { installLayout: layout, storage: oneQuestion, reply: b => as(b, { action: 'click', index: 0 }) });
    p.bg.tagPixels = async () => { throw new Error('boom'); };
    p.pressPlay();
    const final = await settle(p);
    check('a counting failure is as if it couldn\'t count: the picture is still sent, tags taken to be there',
      hasImage(p.requests[0]) && p.screenshots.length === 1 && p.w.document.getElementById('a').checked && marksUp(p.w) === 0, final);
  }

  // ── SIMnet when stuck ───────────────────────────────────────────────────
  {
    const cells = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell has-value" id="cell-A${i + 1}" tabindex="0">${i}</td>`).join('');
    const page = `<body><div role="main"><p>Rename the sheet.</p><span>1 of 3 Attempts</span>
      <button class="shell-btn" data-box="20,20,80,24">Home</button><button class="shell-btn" data-box="110,20,80,24">Format</button>
      <table><tr>${cells}</tr></table></div></body>`;
    let tags = 0;
    const p = boot(page, { installLayout: layout, storage: { mode: 'one' },
      onCapture: w => { tags = marksUp(w); },
      reply: (b, n) => as(b, n === 1 ? { action: 'click', index: 0 } : { action: 'none' }) });
    p.pressPlay();
    await settle(p);
    const stuck = p.requests.find(r => hasImage(r));
    check('SIMnet, stuck: the screenshot carries tags for its buttons', !!stuck && tags === 1 && /small yellow number/.test(words(stuck)), `${tags}`);
    check('and they are down again', marksUp(p.w) === 0);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll mark checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
