// Replays the failures in a real SIMnet answer log (Excel Ch. 4 SIMpath):
//  - "Hide the TimeSheets worksheet": Format > POINT TO Hide & Unhide > Hide
//    Sheet. Clicking Hide & Unhide was graded wrong; the submenu opens on hover.
//  - Group / ungroup / rename / add sheet: the sheet tabs and the + button
//    were never in the list, so the model saw nothing to act on.
//  - "Hide column B": SIMnet's hint is "click the column selector Column B" —
//    the header letter, which couldn't be clicked.
//  - "Unhide the Dec 2 worksheet": said done, SIMnet graded nothing.
// The page is laid out by position (data-rect), since finding headers and
// the tab strip depends on where things sit, as on the real page.
const { boot, settle, until } = require('./harness');

const cases = [];
const test = fn => cases.push(fn);
const wait = ms => new Promise(r => setTimeout(r, ms));
const geo = w => {
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const host = this.closest('[data-rect]');
    if (!host) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const [l, t, wd, h] = host.dataset.rect.split(',').map(Number);
    return { left: l, top: t, width: wd, height: h, right: l + wd, bottom: t + h };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
const list = b => b.messages[0].content.split('Elements (click by index):\n')[1] ?? '';
const idx = (b, label) => {
  const m = new RegExp(`^\\[(\\d+)\\][^\\n]*"${label.replace(/[+&]/g, '\\$&')}"`, 'm').exec(list(b));
  return m ? Number(m[1]) : null;
};

const COLS = ['A', 'B', 'C', 'D', 'E'];
const ROWS = 12;
const cells = [];
for (let r = 1; r <= ROWS; r++) {
  for (const [c, col] of COLS.entries()) {
    cells.push(`<td class="grdbdy-cell" id="cell-${col}${r}" data-rect="${50 + c * 80},${120 + (r - 1) * 20},80,20"></td>`);
  }
}
const PAGE = ({ counter = true, task = 'Hide the TimeSheets worksheet.' } = {}) => `<body><div role="main" data-rect="0,0,1000,500">
  <div data-rect="0,0,600,20"><span id="task">${task}</span>${counter ? '<span>1 of 3 Attempts</span>' : ''}</div>
  <div role="menu" data-rect="0,20,300,20"><button class="shell-btn" aria-label="Save">Save</button><button class="shell-btn" aria-label="Undo">Undo</button></div>
  <button class="shell-btn" id="bold" data-rect="130,40,20,20">B</button>
  <button class="shell-btn" id="format" data-rect="400,40,60,20">Format</button>
  ${COLS.map((c, i) => `<div class="colhdr" id="col-${c}" data-rect="${50 + i * 80},100,80,20">${c}</div>`).join('')}
  ${Array.from({ length: ROWS }, (_, r) => `<div class="rowhdr" id="row-${r + 1}" data-rect="0,${120 + r * 20},40,20">${r + 1}</div>`).join('')}
  <table><tr>${cells.join('')}</tr></table>
  <div class="tabs" data-rect="0,380,600,20">
    <div class="tab" id="tab-dec2" data-rect="50,380,70,20">Dec 2</div>
    <div class="tab" id="tab-dec9" data-rect="130,380,70,20">Dec 9</div>
    <div class="tab" id="tab-ts" data-rect="210,380,90,20">TimeSheets</div>
    <div class="add" id="add" aria-label="New sheet" data-rect="310,380,20,20">+</div>
  </div></div></body>`;

// A small SIMnet: Format's menu, a hover-only submenu, grading popups
function wire(w, state) {
  const d = w.document;
  state.verdicts = [];
  const grade = right => {
    state.verdicts.push(right ? 'correct' : 'incorrect');
    d.body.insertAdjacentHTML('beforeend', `<div id="popup" data-rect="300,150,300,120"><h2>${right ? 'Correct' : 'Incorrect'}</h2>
      ${right ? '' : '<p>HINT: On the Home tab, in the Cells group, click the Format button. Point to Hide &amp; Unhide and click Hide Sheet.</p>'}
      <button id="continue">Continue</button></div>`);
  };
  d.getElementById('format').addEventListener('click', () => {
    if (d.getElementById('menu')) return;
    d.body.insertAdjacentHTML('beforeend', `<div id="menu" data-rect="400,60,160,60">
      <div class="mi" id="hu" data-rect="400,60,160,20">Hide &amp; Unhide</div>
      <div class="mi" data-rect="400,80,160,20">Tab Color</div></div>`);
    const hu = d.getElementById('hu');
    hu.addEventListener('click', () => grade(false));   // clicking a submenu parent: graded wrong
    hu.addEventListener('mouseenter', () => {           // pointing to it opens the submenu
      if (d.getElementById('sub')) return;
      d.body.insertAdjacentHTML('beforeend', `<div id="sub" data-rect="560,60,140,40">
        <div class="mi" id="hide-sheet" data-rect="560,60,140,20">Hide Sheet</div>
        <div class="mi" data-rect="560,80,140,20">Hide Columns</div></div>`);
      d.getElementById('hide-sheet').addEventListener('click', () => grade(true));
    });
  });
}

const start = (opts, reply) => {
  const state = {};
  const p = boot(PAGE(opts), { installLayout: geo, url: 'https://colostate.simnetonline.com/sp', storage: { mode: 'one' }, reply });
  wire(p.w, state);
  return { p, state };
};

test(async check => {
  const seen = [];
  const { p, state } = start({}, b => {
    seen.push(list(b));
    const hs = idx(b, 'Hide Sheet'), hu = idx(b, 'Hide & Unhide');
    if (hs !== null) return as(b, { action: 'click', index: hs });
    if (hu !== null) return as(b, { action: 'hover', index: hu });
    return as(b, { action: 'click', index: idx(b, 'Format') });
  });
  p.pressPlay();
  await until(() => state.verdicts.length > 0, 60000);
  await settle(p, 60000);
  check('hide sheet: pointing to Hide & Unhide opens its submenu', seen.some(l => /"Hide Sheet"[^\n]*\(just appeared\)/.test(l)));
  check('hide sheet: graded correct, never wrong', state.verdicts.join() === 'correct', state.verdicts.join());
  check('hide sheet: the prompt teaches pointing', /SIMnet grades a click on a submenu's parent as a WRONG answer/.test(p.requests[0]?.system ?? ''));
});

test(async check => {
  const { p } = start({ task: 'Group together the Dec 2 and Dec 9 worksheets.' }, 'x');
  const r = await p.toPage({ type: 'SCRAPE', firstLook: true });
  const pos = t => r.elements.findIndex(e => e.text === t);
  check('tabs: every sheet tab is in the list', pos('Dec 2') >= 0 && pos('Dec 9') >= 0 && pos('TimeSheets') >= 0,
    r.elements.slice(0, 8).map(e => e.text).join(' | '));
  check('tabs: and the New Sheet button', pos('New sheet') >= 0);
  check('tabs: near the top, ahead of the ribbon',
    pos('Dec 2') >= 0 && pos('New sheet') >= 0 && Math.max(pos('Dec 2'), pos('New sheet')) < pos('Format'),
    `Dec 2 at ${pos('Dec 2')}, New sheet at ${pos('New sheet')}, Format at ${pos('Format')}`);
  check('first look: nothing marked as just appeared, even inside a menu-like toolbar',
    !r.elements.some(e => e.fresh), r.elements.filter(e => e.fresh).map(e => e.text).join(', '));
  check('the grid cells themselves are not taken for tabs', !r.elements.some(e => e.tag === 'td' && !e.cell));
});

test(async check => {
  const { p } = start({ task: 'Group together the Dec 2 and Dec 9 worksheets.' }, (b, n) => {
    if (n === 1) return as(b, { action: 'click', index: idx(b, 'Dec 2') });
    return as(b, { action: 'click', index: idx(b, 'Dec 9'), ctrl: true });
  });
  const got = [];
  p.w.document.getElementById('tab-dec9').addEventListener('click', e => got.push(e.ctrlKey));
  p.pressPlay();
  await until(() => got.length > 0, 60000);
  check('tabs: ctrl-clicking a second tab groups them', got[0] === true, JSON.stringify(got));
  p.pressPlay();
});

test(async check => {
  const { p } = start({ task: 'Hide the column showing 2022 data.' }, (b, n) =>
    n === 1 ? as(b, { action: 'click', column: 'b' }) : as(b, { action: 'click', column: 'D', shift: true }));
  const hits = [];
  for (const id of ['col-B', 'col-D', 'bold']) {
    p.w.document.getElementById(id).addEventListener('click', e => hits.push(`${id}${e.shiftKey ? '+shift' : ''}`));
  }
  p.pressPlay();
  await until(() => hits.length >= 2, 60000);
  check('column selector: clicks the header B, not the Bold button that also reads "B"', hits[0] === 'col-B', hits.join());
  check('column selector: shift-click extends to D', hits[1] === 'col-D+shift', hits.join());
  check('column selector: reads as such in the history',
    JSON.stringify(p.requests[1]?.messages).includes('clicked the column B header'));
  p.pressPlay();
});

test(async check => {
  const { p } = start({ task: 'Delete row 5.' }, b => as(b, { action: 'rightClick', row: 5 }));
  let opened = false;
  p.w.document.getElementById('row-5').addEventListener('contextmenu', () => { opened = true; });
  p.pressPlay();
  await until(() => opened, 60000);
  check('row selector: right-clicks the row 5 header', opened);
  p.pressPlay();
});

test(async check => {
  // Said done at once, nothing graded: told so, then does the task
  const seen = [];
  const { p, state } = start({}, b => {
    seen.push(b.messages[0].content);
    const tried = /SIMnet graded nothing/.test(b.messages[0].content);
    if (!tried) return as(b, { action: 'none' });
    const hs = idx(b, 'Hide Sheet'), hu = idx(b, 'Hide & Unhide');
    if (hs !== null) return as(b, { action: 'click', index: hs });
    if (hu !== null) return as(b, { action: 'hover', index: hu });
    return as(b, { action: 'click', index: idx(b, 'Format') });
  });
  p.pressPlay();
  await until(() => state.verdicts.length > 0, 60000);
  check('"done" with nothing graded: told it isn\'t done, and carries on to do it', state.verdicts.join() === 'correct', state.verdicts.join());
});

test(async check => {
  const { p } = start({}, b => as(b, { action: 'none' }));
  p.pressPlay(); const final = await settle(p, 60000);
  check('"done" three times with nothing graded: stops and says so',
    /SIMnet hasn't graded anything/.test(final) && p.requests.length === 3, `${p.requests.length} calls: ${final}`);
});

test(async check => {
  // No attempt counter: not a graded page; "done" is taken at its word
  const { p } = start({ counter: false }, b => as(b, { action: 'none' }));
  p.pressPlay(); const final = await settle(p, 60000);
  check('ungraded SIMnet: no nagging, one call', p.requests.length === 1, `${p.requests.length} calls: ${final}`);
});

// Q29 "Modify this worksheet so gridlines will print": Sheet Options has two
// "Print" boxes; the one under Headings was clicked, graded wrong
test(async check => {
  const seen = [];
  const { p, state } = start({ task: 'Modify this worksheet so gridlines will print.' }, b => {
    seen.push(list(b));
    const m = /^\[(\d+)\][^\n]*"Print"[^\n]*\(in: Gridlines\)/m.exec(list(b));
    return m ? as(b, { action: 'click', index: Number(m[1]) }) : as(b, { action: 'none' });
  });
  const d = p.w.document;
  d.querySelector('[role="main"]').insertAdjacentHTML('beforeend', `<div class="sheet-options" data-rect="600,40,200,60">
    <div data-rect="600,40,100,60"><span>Gridlines</span>
      <div role="checkbox" id="gv" data-rect="600,60,100,20">View</div><div role="checkbox" id="gp" data-rect="600,80,100,20">Print</div></div>
    <div data-rect="700,40,100,60"><span>Headings</span>
      <div role="checkbox" id="hv" data-rect="700,60,100,20">View</div><div role="checkbox" id="hp" data-rect="700,80,100,20">Print</div></div></div>`);
  const grade = right => d.body.insertAdjacentHTML('beforeend',
    `<div id="popup" data-rect="300,150,300,120"><h2>${right ? 'Correct' : 'Incorrect'}</h2><button id="continue">Continue</button></div>`);
  d.getElementById('gp').addEventListener('click', () => { state.verdicts.push('correct'); grade(true); });
  d.getElementById('hp').addEventListener('click', () => { state.verdicts.push('incorrect'); grade(false); });
  p.pressPlay();
  await until(() => state.verdicts.length > 0, 60000);
  check('two "Print" boxes are told apart by their group', /"Print"[^\n]*\(in: Gridlines\)/.test(seen[0]) && /"Print"[^\n]*\(in: Headings\)/.test(seen[0]),
    seen[0]?.split('\n').filter(l => /"Print"|"View"/.test(l)).join(' | '));
  check('the Gridlines one is clicked, and graded correct', state.verdicts.join() === 'correct', state.verdicts.join());
});

// Q36 "Print the entire workbook": set the setting, then said done without
// pressing Print — nothing graded
test(async check => {
  const { p, state } = start({ task: 'Print the entire workbook.' }, b => {
    const text = b.messages[0].content;
    if (/Print Entire Workbook[^\n]*\(selected\)/.test(list(b)) && !/SIMnet graded nothing/.test(text)) return as(b, { action: 'none' });
    if (/SIMnet graded nothing/.test(text)) return as(b, { action: 'click', index: idx(b, 'Print') });
    return as(b, { action: 'click', index: idx(b, 'Print Entire Workbook') });
  });
  const d = p.w.document;
  d.querySelector('[role="main"]').insertAdjacentHTML('beforeend', `<div data-rect="600,40,200,60">
    <div role="option" id="entire" data-rect="600,40,200,20">Print Entire Workbook</div>
    <button class="shell-btn" id="print" data-rect="600,70,80,20">Print</button></div>`);
  d.getElementById('entire').addEventListener('click', () => d.getElementById('entire').setAttribute('aria-selected', 'true'));
  d.getElementById('print').addEventListener('click', () => {
    state.verdicts.push('correct');
    d.body.insertAdjacentHTML('beforeend', '<div id="popup" data-rect="300,150,300,120"><h2>Correct</h2><button id="continue">Continue</button></div>');
  });
  p.pressPlay();
  await until(() => state.verdicts.length > 0, 60000);
  check('choosing the setting is not the end: told so, it presses Print', state.verdicts.join() === 'correct', state.verdicts.join());
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
  console.log(failed ? `\n${failed} failed` : '\nAll SIMnet log-replay checks passed');
  process.exit(failed ? 1 : 0);
});
