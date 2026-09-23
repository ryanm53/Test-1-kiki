// SIMnet's Excel moves: double-click, right-click, type, key — and the task
// that exposed their absence, "Rename Sheet1: Dec 16". Also that running out
// of steps is reported as unfinished, never as done.
const { boot, settle, until } = require('./harness');

const cases = [];
const test = fn => cases.push(fn);
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const grid = Array.from({ length: 60 }, (_, i) =>
  `<td class="grdbdy-cell" id="cell-A${i + 1}" tabindex="0"></td>`).join('');

// A sheet-tab bar that renames the way Excel does: double-click opens a name
// box, typing fills it, Enter commits
const RENAME = `<body><div role="main">
  <p>Rename Sheet1: Dec 16</p>
  <button class="shell-btn" aria-label="Home">Home</button>
  <div class="sheet-tabs"><div role="tab" id="t1">Dec 2</div><div role="tab" id="tab">Sheet1</div></div>
  <table><tr>${grid}</tr></table></div></body>`;
const wireRename = w => {
  const tab = w.document.getElementById('tab');
  tab.addEventListener('dblclick', () => {
    const box = w.document.createElement('input');
    box.value = tab.textContent;
    tab.textContent = '';
    tab.appendChild(box);
    box.focus();
    box.addEventListener('keydown', e => {
      if (e.keyCode === 13) { tab.textContent = box.value; }
    });
  });
};

const run = async (html, opts, wire) => {
  const page = boot(html, { installLayout: flat, url: 'https://simnet.mheducation.com/exam', ...opts });
  if (wire) wire(page.w);
  page.pressPlay();
  const final = await settle(page);
  return { page, final, doc: page.w.document };
};

test(async check => {
  // Element order in the SIMnet list: Home, Dec 2, Sheet1, then cells
  const steps = [
    { action: 'doubleClick', index: 2 },
    { action: 'type', text: 'Dec 16' },
    { action: 'key', key: 'Enter' },
    { action: 'none' }
  ];
  const { page, final, doc } = await run(RENAME, { reply: (b, n) => as(b, steps[n - 1] ?? { action: 'none' }) }, wireRename);
  check('rename: the tab now reads "Dec 16"', doc.getElementById('tab').textContent === 'Dec 16',
    JSON.stringify(doc.getElementById('tab').textContent));
  check('rename: four steps, then finished', page.requests.length === 4 && /^Finished/.test(final), `${page.requests.length} calls: ${final}`);
  check('rename: each step is told what came before',
    JSON.stringify(page.requests[3]?.messages).includes('pressed Enter')
    && JSON.stringify(page.requests[3]?.messages).includes('typed \\"Dec 16\\"'));
  check('rename: the prompt teaches the new moves', /doubleClick/.test(page.requests[0]?.system ?? ''));
});

test(async check => {
  // The name box that opens has no label; it must still be offered, with its contents
  const page = boot(RENAME, { installLayout: flat, url: 'https://simnet.mheducation.com/exam', reply: 'x' });
  wireRename(page.w);
  page.w.document.getElementById('tab').dispatchEvent(new page.w.MouseEvent('dblclick'));
  const r = await page.scrape();
  const box = r.elements.find(e => e.tag === 'input');
  check('an unlabelled box being edited is in the list', !!box, JSON.stringify(r.elements.slice(0, 5)));
  check('with what it holds', box?.value === 'Sheet1', box?.value);
});

test(async check => {
  const html = `<body><div role="main"><p>Delete the Dec 2 sheet.</p>
    <div role="tab" id="t1">Dec 2</div><div id="menu"></div>
    <table><tr>${grid}</tr></table></div></body>`;
  let opened = false;
  const { page } = await run(html, {
    reply: (b, n) => as(b, n === 1 ? { action: 'rightClick', index: 0 } : { action: 'none' })
  }, w => w.document.getElementById('t1').addEventListener('contextmenu', () => { opened = true; }));
  check('right-click opens the context menu', opened);
});

test(async check => {
  // A grid cell edits only on real key presses, which go through the debugger
  const html = `<body><div role="main"><p>Type 42 in cell A1.</p>
    <table><tr>${grid}</tr></table></div></body>`;
  const { page, doc } = await run(html, {
    reply: (b, n) => as(b, n === 1 ? { action: 'type', index: 0, text: '42' } : { action: 'none' })
  });
  const typed = page.debuggerCalls.filter(c => c.type === 'keyDown').map(c => c.text).join('');
  check('typing into a grid cell uses real key presses', typed === '42', JSON.stringify(typed));
  check('with the cell focused first', doc.activeElement?.id === 'cell-A1', doc.activeElement?.id);
});

test(async check => {
  const html = `<body><div role="main"><p>Rename the sheet.</p><button class="shell-btn">Home</button>
    <table><tr>${grid}</tr></table></div></body>`;
  const { page, final } = await run(html, {
    reply: b => as(b, { action: 'type', text: 'Dec 16' })   // the same mistake on the retry too
  });
  check('typing with nothing being edited is refused, not sent as stray keys',
    page.debuggerCalls.length === 0 && /Nothing is being edited/.test(final), final);
});

test(async check => {
  // Alternating steps get past the repeat guard; running out must not read as done
  const html = `<body><div role="main"><p>Do something hard.</p>
    <button class="shell-btn" aria-label="Home">Home</button><button class="shell-btn" aria-label="Insert">Insert</button>
    <table><tr>${grid}</tr></table></div></body>`;
  const { page, final } = await run(html, { reply: (b, n) => as(b, { action: 'click', index: n % 2 }) });
  check('out of steps: reported as unfinished', /Used all 8 steps without finishing/.test(final) && page.isError(), final);
  check('out of steps: never "Finished"', !/Finished/.test(final));
});

test(async check => {
  const html = `<body><div role="main"><p>Q</p><input type="password" aria-label="Password" value="hunter2">
    <input type="text" aria-label="Name" value="Ken"><input type="checkbox" aria-label="Agree"></div></body>`;
  const page = boot(html, { installLayout: flat, reply: 'x' });
  const r = await page.scrape();
  const byLabel = l => r.elements.find(e => e.text === l);
  check('a password is never read out', byLabel('Password')?.value === undefined);
  check('a text box shows what it holds', byLabel('Name')?.value === 'Ken');
  check('a tick box shows no "on"', byLabel('Agree')?.value === undefined);
});

// ── The rest of what a SIMnet exercise asks for ───────────────────────────
const events = (w, el, types) => {
  const got = [];
  for (const t of types) el.addEventListener(t, e => got.push({ t, shift: e.shiftKey, ctrl: e.ctrlKey, key: e.key, code: e.keyCode }));
  return got;
};
const PLAIN = task => `<body><div role="main"><p>${task}</p>
  <button class="shell-btn" aria-label="Bold" aria-pressed="true">B</button>
  <button class="shell-btn" aria-label="Format" aria-expanded="true">Format</button>
  <button class="shell-btn" aria-label="Paste" aria-disabled="true">Paste</button>
  <div role="tab" id="t1" aria-selected="true">Dec 2</div><div role="tab" id="t2">Dec 9</div>
  <select aria-label="Category" id="cat"><option>General</option><option>Number</option><option>Currency</option></select>
  <table><tr>${grid}</tr></table></div></body>`;
const one = (action, then = { action: 'none' }) => (b, n) => as(b, n === 1 ? action : then);

test(async check => {
  // The task doesn't name the cell, so it isn't among the few cells listed
  const page = boot(PLAIN('Enter the Friday total.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: one({ action: 'click', cell: 'A45' }) });
  const r = await page.scrape();
  const got = events(page.w, page.w.document.getElementById('cell-A45'), ['click']);
  page.pressPlay(); await settle(page);
  check('a cell that is not in the list can still be named',
    !r.elements.some(e => e.cell === 'A45') && got.length > 0, `clicks: ${got.length}`);
  check('its step reads as the cell', JSON.stringify(page.requests[1]?.messages).includes('clicked cell A45'));
});

test(async check => {
  const page = boot(PLAIN('Select A2:A5.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: one({ action: 'selectRange', from: 'a2', to: '$A$5' }) });
  const first = events(page.w, page.w.document.getElementById('cell-A2'), ['mousedown']);
  const last = events(page.w, page.w.document.getElementById('cell-A5'), ['mousedown', 'click']);
  page.pressPlay(); await settle(page);
  check('selectRange: clicks the first cell', first.length === 1 && !first[0].shift);
  check('selectRange: shift-clicks the last', last.length >= 2 && last.every(e => e.shift), JSON.stringify(last));
  check('selectRange: addresses are tidied ("a2", "$A$5")', JSON.stringify(page.requests[1]?.messages).includes('selected A2:A5'));
});

test(async check => {
  const page = boot(PLAIN('Group Dec 2 and Dec 9.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: one({ action: 'click', index: 4, ctrl: true }) });
  const got = events(page.w, page.w.document.getElementById('t2'), ['mousedown', 'click']);
  page.pressPlay(); await settle(page);
  check('ctrl-click holds Ctrl through the whole click', got.length >= 2 && got.every(e => e.ctrl), JSON.stringify(got));
});

test(async check => {
  const page = boot(PLAIN('Go to A1.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: one({ action: 'key', key: 'Home', ctrl: true }) });
  const got = events(page.w, page.w.document.body, ['keydown']);
  page.pressPlay(); await settle(page);
  check('Ctrl+Home is pressed as Ctrl+Home', got[0]?.key === 'Home' && got[0]?.ctrl && got[0]?.code === 36, JSON.stringify(got));
  check('and reads that way in the history', JSON.stringify(page.requests[1]?.messages).includes('pressed Ctrl+Home'));
});

test(async check => {
  const page = boot(PLAIN('Set the category to Currency.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: (b, n) => n === 1
      ? as(b, { action: 'fill', fills: [{ index: Number(/\[(\d+)\][^\n]*"Category"/.exec(b.messages[0].content)[1]), value: 'Currency' }] })
      : as(b, { action: 'none' }) });
  page.pressPlay(); await settle(page);
  const list = page.requests[0]?.messages[0].content ?? '';
  check('a dropdown shows its choices and what is chosen',
    /"Category"[^\n]*value="General"[^\n]*options=\[General \| Number \| Currency\]/.test(list),
    list.split('\n').find(l => /Category/.test(l)));
  check('and one is picked by its text', page.w.document.getElementById('cat').value === 'Currency');
});

test(async check => {
  const page = boot(PLAIN('Anything.'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam', reply: 'x' });
  const r = await page.scrape();
  const st = t => r.elements.find(e => e.text === t)?.state;
  check('a toggle that is on says so', st('Bold') === 'on', st('Bold'));
  check('an open menu says so', st('Format') === 'open', st('Format'));
  check('an unusable control says so', st('Paste') === 'disabled', st('Paste'));
  check('the current tab says so', st('Dec 2') === 'selected' && st('Dec 9') === undefined);
});

test(async check => {
  const page = boot(PLAIN('x'), { installLayout: flat, url: 'https://simnet.mheducation.com/exam',
    reply: b => as(b, { action: 'click', cell: 'not-a-cell' }) });
  page.pressPlay(); const final = await settle(page);
  check('a malformed cell address is refused', /must be a cell address/.test(final), final);
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
  console.log(failed ? `\n${failed} failed` : '\nAll SIMnet move checks passed');
  process.exit(failed ? 1 : 0);
});
