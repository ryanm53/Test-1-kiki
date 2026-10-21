// "Financial statement effects": Connect's table that asks what a transaction
// does to the statements, not what the statements are. A Balance Sheet (Assets,
// Liabilities, Stockholders' Equity with Common Stock and Retained Earnings)
// above an Income Statement (Revenues, Expenses, Net Income). Every line of
// Assets, Liabilities, Revenues and Expenses is a dropdown for the account
// and a box beside it for the amount; Common Stock, Retained Earnings and Net
// Income are boxes only.
//
// What had to be right: a box belongs to the dropdown beside it — not the
// first dropdown in the row, which was the Assets one for every box after it
// — and each box says which column and which line it is.
const { boot, settle, until, bodyText } = require('./harness');

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
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };

const ACCOUNTS = ['Cash', 'Equipment', 'Inventory', 'Accounts payable', 'Notes payable', 'Service revenue', 'Insurance expense', 'Rent expense'];
let custom = false;   // dropdowns built out of divs, as Angular apps do
const select = (id, group) => custom
  ? `<div role="combobox" tabindex="0" aria-expanded="false" data-id="${id}" data-group="${group}"></div>`
  : `<select data-id="${id}" data-group="${group}"><option value=""></option>${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select>`;
const box = (id, group) => `<input type="text" data-id="${id}" data-group="${group}">`;
const lines = 4;
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('');

const pageHtml = () => `<body><div role="main">
  <p>Lapeer Flour Mills purchased new equipment and made the following expenditures:</p>
  <pre>Purchase price                          $ 72,000
Sales tax                                  5,850
Shipment of equipment                        970
Insurance on the equipment for the first year  670
Installation of equipment                  1,940</pre>
  <p><b>Required:</b> Determine the initial cost and the financial statement effects of the above expenditures for the new equipment. All expenditures were paid in cash.</p>
  <p class="note">Note: Amounts to be deducted should be indicated by a minus sign.</p>
  <table>
    <tr><th colspan="6">Balance Sheet</th></tr>
    <tr><th rowspan="2" colspan="2">Assets</th><th rowspan="2" colspan="2">Liabilities</th><th colspan="2">Stockholders' Equity</th></tr>
    <tr><th>Common Stock</th><th>Retained Earnings</th></tr>
    ${rows(lines, i => `<tr><td>${select('as-name' + i, 'assets')}</td><td>${box('as-amt' + i, 'assets')}</td>
      <td>${select('li-name' + i, 'liabilities')}</td><td>${box('li-amt' + i, 'liabilities')}</td>
      <td>${box('cs' + i, 'common')}</td><td>${box('re' + i, 'retained')}</td></tr>`)}
  </table>
  <table>
    <tr><th colspan="5">Income Statement</th></tr>
    <tr><th colspan="2">Revenues</th><th colspan="2">Expenses</th><th>Net Income</th></tr>
    ${rows(lines, i => `<tr><td>${select('rv-name' + i, 'revenues')}</td><td>${box('rv-amt' + i, 'revenues')}</td>
      <td>${select('ex-name' + i, 'expenses')}</td><td>${box('ex-amt' + i, 'expenses')}</td>
      <td>${box('ni' + i, 'net')}</td></tr>`)}
  </table>
  <button class="next-button">Next Question</button>
</div></body>`;

// Per the page, the effects of buying the equipment for cash: its cost is
// 72,000 + 5,850 + 970 + 1,940 = 80,760; insurance is an expense
const ANSWER = {
  'as-name1': 'Equipment', 'as-amt1': '80760', 'as-name2': 'Cash', 'as-amt2': '-81430',
  're1': '-670', 'ex-name1': 'Insurance expense', 'ex-amt1': '-670', 'ni1': '-670'
};

(async () => {
  // What the model is told about each box
  const PAGE = pageHtml();
  const probe = boot(PAGE, { installLayout: flat, storage: oneQuestion, reply: () => '' });
  const page = await probe.scrape();
  const byId = {};
  const all = Array.from(probe.w.document.querySelectorAll('[data-id]'));
  // Elements come back in page order, which is document order for these
  page.elements.filter(e => e.tag === 'select' || e.tag === 'input' || e.tag === 'div').forEach((e, i) => { byId[all[i]?.dataset.id] = e; });
  const says = (id, re) => re.test(byId[id]?.text ?? '');

  check('every dropdown and box is listed', Object.keys(byId).length === lines * 11, `${Object.keys(byId).length}`);
  check('an Assets dropdown says it is a name in the Assets column, and which line', says('as-name2', /^Assets — row 2's name$/), byId['as-name2']?.text);
  check('the box beside it is that line\'s amount, named by that dropdown', says('as-amt2', /^Assets — row 2, named by its dropdown/), byId['as-amt2']?.text);
  check('a Liabilities box is tied to the Liabilities dropdown, not the Assets one',
    says('li-amt1', /^Liabilities — row 1, named by its dropdown/) && says('li-name1', /^Liabilities — row 1's name$/), `${byId['li-amt1']?.text} / ${byId['li-name1']?.text}`);
  check('Common Stock and Retained Earnings are plain boxes, named by their column and line',
    says('cs3', /^Common Stock — row 3$/) && says('re3', /^Retained Earnings — row 3$/), `${byId['cs3']?.text} / ${byId['re3']?.text}`);
  check('the Income Statement starts again at row 1, Revenues and Expenses each with their own dropdown',
    says('rv-name1', /^Revenues — row 1's name$/) && says('ex-amt1', /^Expenses — row 1, named by its dropdown/), `${byId['rv-name1']?.text} / ${byId['ex-amt1']?.text}`);
  check('Net Income is a plain box', says('ni1', /^Net Income — row 1$/), byId['ni1']?.text);
  check('no two boxes share a label', new Set(Object.values(byId).map(e => e.text)).size === Object.keys(byId).length,
    `${Object.keys(byId).length - new Set(Object.values(byId).map(e => e.text)).size} repeated`);
  check('read as a worksheet', page.isWorksheet === true, String(page.isWorksheet));

  // The run: the model answers by the labels it was given
  const model = body => {
    const found = {};
    for (const l of bodyText(body).split('\n')) {
      const m = /^\[(\d+)\] (select|input)(?: type="[^"]*")? "([^"]*)"/.exec(l);
      if (m) found[m[3]] = Number(m[1]);
    }
    const at = (col, row, kind) => found[Object.keys(found).find(k => k.startsWith(`${col} — row ${row}${kind}`))];
    const fills = [
      { index: at('Assets', 1, "'s name"), value: ANSWER['as-name1'] }, { index: at('Assets', 1, ','), value: ANSWER['as-amt1'] },
      { index: at('Assets', 2, "'s name"), value: ANSWER['as-name2'] }, { index: at('Assets', 2, ','), value: ANSWER['as-amt2'] },
      { index: at('Retained Earnings', 1, ''), value: ANSWER.re1 },
      { index: at('Expenses', 1, "'s name"), value: ANSWER['ex-name1'] }, { index: at('Expenses', 1, ','), value: ANSWER['ex-amt1'] },
      { index: at('Net Income', 1, ''), value: ANSWER.ni1 }
    ];
    return as(body, { action: 'fill', fills });
  };
  const p = boot(PAGE, { installLayout: flat, storage: oneQuestion, reply: model });
  p.pressPlay();
  const final = await settle(p);
  await wait(300);
  const get = id => {
    const el = p.w.document.querySelector(`[data-id="${id}"]`);
    return el?.value ?? '';
  };
  const wrong = Object.entries(ANSWER).filter(([id, v]) => get(id) !== v).map(([id, v]) => `${id}=${JSON.stringify(get(id))} (wanted ${v})`);
  check('every line it was told to fill lands in the right box', wrong.length === 0, wrong.join('; '));
  const empty = Array.from(p.w.document.querySelectorAll('[data-id]')).filter(el => !(el.dataset.id in ANSWER)).filter(el => el.value);
  check('and no other box is touched', empty.length === 0, empty.map(e => e.dataset.id).join());
  check('it goes to Sonnet 5.5 (a worksheet), in one call', p.requests.length === 1 && p.requests[0].model === 'claude-sonnet-5-5', `${p.requests.map(r => r.model)}`);
  check('with the guidance for effects tables: changes, minus signs, balancing',
    /EFFECTS of a transaction/.test(p.requests[0]?.system ?? '') && /It must balance/.test(p.requests[0]?.system ?? ''));
  check('and the figures and the note are in what it reads', /72,000/.test(bodyText(p.requests[0])) && /minus sign/.test(bodyText(p.requests[0])));
  check('the bar shows no error', !p.isError(), final);

  // The same table, its dropdowns built out of divs: the boxes read the same
  custom = true;
  const cp = boot(pageHtml(), { installLayout: flat, storage: oneQuestion, reply: () => '' });
  const cpage = await cp.scrape();
  const cby = {};
  const call = Array.from(cp.w.document.querySelectorAll('[data-id]'));
  cpage.elements.filter(e => e.tag === 'select' || e.tag === 'input' || e.tag === 'div').forEach((e, i) => { cby[call[i]?.dataset.id] = e; });
  check('with dropdowns built from divs, each is still its column\'s name and each box its line\'s amount',
    /^Liabilities — row 1's name$/.test(cby['li-name1']?.text ?? '') && /^Liabilities — row 1, named by its dropdown/.test(cby['li-amt1']?.text ?? '')
    && /^Common Stock — row 3$/.test(cby['cs3']?.text ?? '') && /^Expenses — row 2's name$/.test(cby['ex-name2']?.text ?? ''),
    [cby['li-name1']?.text, cby['li-amt1']?.text, cby['cs3']?.text, cby['ex-name2']?.text].join(' / '));

  console.log(failed ? `\n${failed} failed` : '\nAll financial-statement-effects checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
