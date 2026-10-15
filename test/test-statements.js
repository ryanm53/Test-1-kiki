// Two things from real accounting questions:
//
// 1. A multiple-choice question with its data in a table: an inventory
//    schedule (units and unit costs) for a FIFO calculation. The table has to
//    reach the model, in columns, even when it sits outside the area the
//    question's choices are in.
//
// 2. A financial statement with a dropdown on every line for the account's
//    name and a box for its amount, drawn with divs rather than a <table>.
//    All of it has to be seen — two dozen dropdowns, each with the same long
//    list — and filled.
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
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const oneQuestion = { lastPresetIndex: 0, autoContinue: false };

(async () => {
  // ── 1. The inventory schedule ───────────────────────────────────────────
  {
    const html = `<body>
      <div class="exhibit"><p>Inventory records for Capetown, Incorporated revealed the following:</p>
        <table><tr><th>Date</th><th>Transaction</th><th>Number of Units</th><th>Unit Cost</th></tr>
          <tr><td>April 1</td><td>Beginning Inventory</td><td>450</td><td>$ 2.45</td></tr>
          <tr><td>April 20</td><td>Purchase</td><td>450</td><td>2.70</td></tr></table></div>
      <div role="main"><form></form>
        <p class="prompt">Capetown sold 580 units of inventory during the month. Ending inventory assuming FIFO would be:</p>
        ${['$784.', '$1,215.', '$864.', '$1,102.'].map((c, i) => `<input type="radio" name="q" id="c${i}" aria-label="${c}">`).join('')}
        <button class="next-button">Next</button></div></body>`;
    const p = boot(html, { installLayout: flat, storage: oneQuestion,
      reply: b => as(b, { action: 'click', index: 2 }) });
    p.pressPlay();
    await settle(p);
    const prompt = p.requests[0] ? promptOf(p.requests[0]) : '';
    check('the schedule reaches the model, one row a line, cells divided',
      /Beginning Inventory \| 450 \| \$ 2\.45/.test(prompt) && /Purchase \| 450 \| 2\.70/.test(prompt), prompt.slice(0, 400));
    check('with its column headings', /Date \| Transaction \| Number of Units \| Unit Cost/.test(prompt));
    check('and the question under it', prompt.includes('Capetown sold 580 units'));
    check('a question with sums goes to Sonnet 5.5', p.requests[0]?.model === 'claude-sonnet-5-5', p.requests[0]?.model);
    check('the choice it names is ticked', p.w.document.getElementById('c2').checked);
  }

  // ── 2. A statement of dropdowns and amounts, drawn with divs ────────────
  const ACCOUNTS = ['Cash', 'Accounts receivable', 'Inventory', 'Prepaid insurance', 'Equipment', 'Accumulated depreciation',
    'Accounts payable', 'Salaries payable', 'Unearned revenue', 'Notes payable', 'Common stock', 'Retained earnings',
    'Service revenue', 'Rent expense', 'Salaries expense', 'Supplies expense', 'Depreciation expense', 'Interest expense',
    'Dividends', 'Insurance expense', 'Utilities expense', 'Bad debt expense', 'Interest revenue', 'Gain on sale'];
  const LINES = 12;
  const statement = custom => `<body><div role="main">
    <p>Prepare a balance sheet from the adjusted trial balance below.</p>
    <p>Cash 5,000; Accounts receivable 3,000; Equipment 9,000; Accounts payable 4,000; Common stock 10,000; Retained earnings 3,000.</p>
    <div class="statement">
      ${Array.from({ length: LINES }, (_, i) => `<div class="line">
        ${custom
          ? `<div role="combobox" class="pick" tabindex="0" data-i="${i}" aria-expanded="false"></div>`
          : `<select data-i="${i}"><option value=""></option>${ACCOUNTS.map(a => `<option>${a}</option>`).join('')}</select>`}
        <input type="text" class="amt" data-i="${i}">
      </div>`).join('')}
    </div><button class="next-button">Next</button></div></body>`;
  const wire = w => {
    const d = w.document;
    d.querySelectorAll('.pick').forEach(box => {
      const close = () => { d.getElementById('lb')?.remove(); box.setAttribute('aria-expanded', 'false'); };
      box.addEventListener('click', () => {
        if (d.getElementById('lb')) return close();
        const list = d.createElement('ul');
        list.id = 'lb'; list.setAttribute('role', 'listbox');
        for (const a of ACCOUNTS) {
          const li = d.createElement('li');
          li.setAttribute('role', 'option'); li.textContent = a;
          li.addEventListener('click', () => { box.textContent = a; close(); });
          list.appendChild(li);
        }
        d.body.appendChild(list);
        box.setAttribute('aria-expanded', 'true');
      });
    });
  };
  const answer = [
    ['Cash', 5000], ['Accounts receivable', 3000], ['Equipment', 9000], ['Accounts payable', 4000],
    ['Common stock', 10000], ['Retained earnings', 3000]
  ];
  // The fake model: fills each line's dropdown with the account's name and the
  // box after it with the amount, wherever the prompt lists them
  const model = body => {
    const lines = promptOf(body).split('\n').map(l => /^\[(\d+)\] (.*)$/.exec(l)).filter(Boolean).map(m => [Number(m[1]), m[2]]);
    const drops = lines.filter(([, l]) => /^(select|div)\b/.test(l)), boxes = lines.filter(([, l]) => /^input\b/.test(l));
    const fills = [];
    answer.forEach(([name, amount], k) => {
      if (drops[k]) fills.push({ index: drops[k][0], value: name });
      if (boxes[k]) fills.push({ index: boxes[k][0], value: String(amount) });
    });
    return as(body, { action: 'fill', fills });
  };

  for (const custom of [false, true]) {
    const kind = custom ? 'custom dropdowns' : 'native selects';
    const p = boot(statement(custom), { installLayout: flat, storage: oneQuestion, reply: model, beforeLoad: wire });
    p.pressPlay();
    const final = await settle(p);
    await wait(300);
    const prompt = p.requests[0] ? promptOf(p.requests[0]) : '';
    const els = prompt.split('\n').filter(l => /^\[\d+\] /.test(l));
    const drops = els.filter(l => /^\[\d+\] (select|div)\b/.test(l));

    check(`${kind}: all ${LINES} dropdowns are shown`, drops.length === LINES, `${drops.length}`);
    check(`${kind}: every one with its list (the first in full, the rest "same as")`,
      /options=\[Cash \| Accounts receivable/.test(drops[0] ?? '') && drops.slice(1).every(l => /options=\(same as \[\d+\]\)/.test(l)),
      drops.slice(0, 2).join(' || ').slice(0, 300));
    check(`${kind}: the list is written out once, not ${LINES} times`, (prompt.match(/Prepaid insurance/g) ?? []).length === 1,
      `${(prompt.match(/Prepaid insurance/g) ?? []).length}`);
    check(`${kind}: seen as a worksheet, so the stronger model and the statement guidance`,
      p.requests[0]?.model === 'claude-sonnet-5-5' && /financial statement/.test(p.requests[0]?.system ?? ''),
      `${p.requests[0]?.model}`);
    check(`${kind}: boxes without a label take the text before them, or none`, els.filter(l => /^\[\d+\] input/.test(l)).length === LINES);

    const d = p.w.document;
    const chosen = custom ? Array.from(d.querySelectorAll('.pick')).map(e => e.textContent)
                          : Array.from(d.querySelectorAll('select')).map(e => e.value);
    const amounts = Array.from(d.querySelectorAll('.amt')).map(e => e.value);
    check(`${kind}: each line's account is picked`, answer.every(([n], i) => chosen[i] === n), chosen.slice(0, 7).join(', '));
    check(`${kind}: and its amount filled`, answer.every(([, a], i) => amounts[i] === String(a)), amounts.slice(0, 7).join(', '));
    check(`${kind}: finishes without an error`, !p.isError(), final);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll statement checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
