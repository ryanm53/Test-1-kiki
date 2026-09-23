// "Change the tab colour for Dec 9 to Dark Red": Format opens a menu that the
// page adds at the very end, after a ribbon that fills the list on its own.
// Reported: it kept opening Format and "going out" — the menu's items had
// fallen past the cutoff, so the model never saw them.
const { boot, settle, until } = require('./harness');

const cases = [];
const test = fn => cases.push(fn);
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.model === 'claude-haiku-4-5' ? s.slice('{"action":"'.length) : s;
};
// The fake model reads the list it was actually sent, like the real one
const indexOf = (body, label) => {
  const m = new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`).exec(body.messages[0].content);
  return m ? Number(m[1]) : null;
};

const grid = Array.from({ length: 60 }, (_, i) => `<td class="grdbdy-cell" id="cell-A${i + 1}"></td>`).join('');
const ribbon = Array.from({ length: 120 }, (_, i) => `<button class="shell-btn">Ribbon ${i}</button>`).join('');
const PAGE = `<body><div role="main">
  <p>Change the color of the sheet tab for the Dec 9 worksheet to Dark Red.</p>
  <button class="shell-btn" id="fmt">Format</button>${ribbon}
  <table><tr>${grid}</tr></table>
  <div class="sheet-tabs"><div role="tab" id="tab">Dec 9</div></div></div></body>`;

// Menus land at the end of the body, as real ones do; the swatches are bare
// divs with only a title
const wire = w => {
  const d = w.document;
  d.getElementById('fmt').addEventListener('click', () => {
    if (d.getElementById('menu')) { d.getElementById('menu').remove(); return; }   // a second click closes it
    d.body.insertAdjacentHTML('beforeend',
      '<div id="menu"><button id="tabColor">Tab Color</button><button>Rename Sheet</button></div>');
    d.getElementById('tabColor').addEventListener('click', () => {
      d.body.insertAdjacentHTML('beforeend', `<div id="palette">
        <div class="swatch" title="Dark Red" id="darkred"></div><div class="swatch" title="Red"></div>
        <div class="swatch" title="Orange"></div></div>`);
      d.getElementById('darkred').addEventListener('click', () => {
        d.getElementById('tab').dataset.color = 'dark-red';
        d.getElementById('menu')?.remove(); d.getElementById('palette')?.remove();
      });
    });
  });
};

test(async check => {
  const seen = [];
  let page;
  page = boot(PAGE, { installLayout: flat, url: 'https://simnet.mheducation.com/exam', reply: (b, n) => {
    seen.push(b.messages[0].content);
    // Done once the colour is on, as the real model would see from the tab
    if (page.w.document.getElementById('tab').dataset.color === 'dark-red') return as(b, { action: 'none' });
    if (n === 1) return as(b, { action: 'click', index: indexOf(b, 'Format') });
    const tc = indexOf(b, 'Tab Color'), dr = indexOf(b, 'Dark Red');
    if (dr !== null) return as(b, { action: 'click', index: dr });
    if (tc !== null) return as(b, { action: 'click', index: tc });
    return as(b, { action: 'click', index: indexOf(b, 'Format') });   // what it did before: open it again
  } });
  wire(page.w);
  page.pressPlay();
  await until(() => page.w.document.getElementById('tab').dataset.color === 'dark-red', 60000);
  const final = await settle(page, 60000);
  check('the tab is now Dark Red', page.w.document.getElementById('tab').dataset.color === 'dark-red');
  check('in four steps, then finished', page.requests.length === 4 && /^Finished/.test(final), `${page.requests.length} calls: ${final}`);
  check('the opened menu is in the list, even past a full ribbon', /"Tab Color"[^\n]*\(just appeared\)/.test(seen[1] ?? ''),
    (seen[1] ?? '').split('\n').filter(l => /Tab Color/.test(l)).join(' | ') || 'Tab Color not listed');
  check('and listed first', /^\[0\][^\n]*"(Tab Color|Rename Sheet)"/m.test((seen[1] ?? '').split('Elements (click by index):\n')[1] ?? ''));
  check('bare colour swatches that appear are offered too', /"Dark Red"[^\n]*\(just appeared\)/.test(seen[2] ?? ''),
    (seen[2] ?? '').split('\n').filter(l => /Dark Red/.test(l)).join(' | ') || 'Dark Red not listed');
  check('nothing is marked new on the first look', !/\(just appeared\)/.test(seen[0] ?? ''));
  check('the prompt explains the marker', /just appeared/.test(page.requests[0]?.system ?? ''));
});

test(async check => {
  // An idle look between steps (the bar recognising the page) must not
  // swallow what "just appeared"
  const page = boot(PAGE, { installLayout: flat, url: 'https://simnet.mheducation.com/exam', reply: 'x' });
  wire(page.w);
  await page.toPage({ type: 'SCRAPE', firstLook: true });
  page.w.document.getElementById('fmt').click();
  await page.toPage({ type: 'SCRAPE', peek: true });
  const r = await page.toPage({ type: 'SCRAPE' });
  const tc = r.elements.find(e => e.text === 'Tab Color');
  check('a peek in between leaves "just appeared" intact', tc?.fresh === true, JSON.stringify(tc));
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
  console.log(failed ? `\n${failed} failed` : '\nAll SIMnet menu checks passed');
  process.exit(failed ? 1 : 0);
});
