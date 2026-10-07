// A Connect accounting question as it really comes (Underwood Corporation,
// allowance for uncollectible accounts): two tabs, Required 1 and Required 2.
// Required 1 is an 81-box table of financial statement effects under two rows
// of headers, with dates that span two lines. Required 2 has a dropdown that
// names a row ("Less: Allowance for uncollectible accounts").
//
// What went wrong on the real one: only the first 60 boxes were ever sent, so
// it stopped after July 2; dates over two lines shifted every column after
// them; and Required 2 was never opened.
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
// Every element line, as [index, rest of line]
const linesOf = body => promptOf(body).split('\n')
  .map(l => /^\[(\d+)\] (.*)$/.exec(l)).filter(Boolean).map(m => [Number(m[1]), m[2]]);

const flatLayout = w => {
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 };
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
};

const COLS = ['Assets', 'Liabilities', 'Common Stock', 'Retained Earnings', 'Revenues', 'Expenses', 'Net Income'];
// [date, lines, boxes on each line]
const DATES = [
  ['June 12, 2026', [7]], ['September 17, 2026', [7, 7]], ['December 31, 2026', [7]],
  ['March 4, 2027', [7]], ['May 20, 2027', [7, 7]], ['July 2, 2027', [7, 4]],
  ['October 19, 2027', [7, 7]], ['December 31, 2027', [7]]
];
const box = () => '<td class="sign">$</td><td><input type="text"></td>';

const required1 = () => {
  let rows = '';
  for (const [date, lines] of DATES) {
    lines.forEach((n, i) => {
      rows += '<tr>' + (i === 0 ? `<td rowspan="${lines.length}">${date}</td>` : '')
        + Array.from({ length: n }, box).join('')
        + (n < 7 ? `<td colspan="${(7 - n) * 2}"></td>` : '') + '</tr>';
    });
  }
  return `<p>Determine the financial statement effects for each date.
    Note: Amounts to be deducted should be indicated by a minus sign.</p>
    <table>
      <tr><th rowspan="2"></th><th colspan="8">Balance Sheet</th><th colspan="6">Income Statement</th></tr>
      <tr>${COLS.map(c => `<th colspan="2">${c}</th>`).join('')}</tr>
      ${rows}
    </table>`;
};

const dropdown = custom => custom
  ? '<div role="combobox" aria-haspopup="listbox" aria-expanded="false" class="pick" tabindex="0"></div>'
  : `<select><option value=""></option><option value="a1">Add: Allowance for uncollectible accounts</option>
      <option value="a2">Add: Bad debts</option><option value="l1">Less: Allowance for uncollectible accounts</option>
      <option value="l2">Less: Bad debts</option></select>`;
const required2 = custom => `<p>Calculate net accounts receivable reported in the balance sheet at the end of 2026 and 2027.</p>
  <table>
    <tr><th></th><th colspan="2">2026</th><th colspan="2">2027</th></tr>
    <tr><td>Total accounts receivable</td>${box()}${box()}</tr>
    <tr><td>${dropdown(custom)}</td>${box()}${box()}</tr>
    <tr><td>Net accounts receivable</td>${box()}${box()}</tr>
  </table>`;

const page = `<body><div role="main">
  <p>The following events occur for The Underwood Corporation during 2026 and 2027.
     June 12, 2026 Provide services to customers on account for $41,000.
     September 17, 2026 Receive $25,000 from customers on account.</p>
  <ul role="tablist">
    <li class="active"><a role="tab" href="#r1" aria-selected="true">Required 1</a></li>
    <li><a role="tab" href="#r2" aria-selected="false">Required 2</a></li>
  </ul>
  <div id="part"></div>
  <button class="next-button">Next</button>
</div></body>`;

const CHOICES = ['Add: Allowance for uncollectible accounts', 'Add: Bad debts',
                 'Less: Allowance for uncollectible accounts', 'Less: Bad debts'];

// The page's own behaviour: tabs swap the part shown; a custom dropdown builds
// its list only when opened and takes it away again.
function wire(w, custom) {
  const d = w.document;
  const values = { r1: null, r2: null };
  const show = which => {
    const part = d.getElementById('part');
    if (values[part.dataset.which]) values[part.dataset.which] = part.innerHTML;
    part.dataset.which = which;
    part.innerHTML = which === 'r1' ? required1() : required2(custom);
    d.querySelectorAll('[role="tab"]').forEach(t => {
      const on = t.getAttribute('href') === `#${which}`;
      t.setAttribute('aria-selected', String(on));
      t.parentElement.className = on ? 'active' : '';
    });
    if (custom) wireDropdown(w);
  };
  d.querySelectorAll('[role="tab"]').forEach(t => t.addEventListener('click', e => {
    e.preventDefault();
    show(t.getAttribute('href').slice(1));
  }));
  show('r1');
}
function wireDropdown(w) {
  const d = w.document;
  const box = d.querySelector('.pick');
  if (!box) return;
  const close = () => { d.getElementById('lb')?.remove(); box.setAttribute('aria-expanded', 'false'); };
  box.addEventListener('click', () => {
    if (d.getElementById('lb')) return close();
    const list = d.createElement('ul');
    list.id = 'lb';
    list.setAttribute('role', 'listbox');
    for (const c of CHOICES) {
      const li = d.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = c;
      li.addEventListener('click', () => { box.textContent = c; close(); });
      list.appendChild(li);
    }
    d.body.appendChild(list);
    box.setAttribute('aria-expanded', 'true');
  });
  d.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// The fake model: fills every box with a number, and the dropdown with the
// words "Less: Allowance" (short of the option's full text)
const model = body => {
  const fills = [];
  for (const [i, line] of linesOf(body)) {
    if (/^(input|select|div)/.test(line) && !/^div "(Required|Next)/.test(line)) {
      fills.push({ index: i, value: /^(select|div)/.test(line) ? 'Less: Allowance' : String(1000 + i) });
    }
  }
  return as(body, { action: 'fill', fills });
};

async function run(custom) {
  const p = boot(page, { installLayout: flatLayout, storage: { lastPresetIndex: 0, autoContinue: false },
                         reply: model, beforeLoad: w => wire(w, custom) });
  let nexts = 0;
  p.w.document.querySelector('.next-button').addEventListener('click', () => nexts++);
  p.pressPlay();
  const final = await settle(p);
  await wait(300);
  return { p, final, nexts };
}

(async () => {
  // ── Native <select> ─────────────────────────────────────────────────────
  {
    const { p, final, nexts } = await run(false);
    const [first, second] = p.requests;
    const labels = first ? linesOf(first).map(([, l]) => l) : [];
    const inputs = labels.filter(l => l.startsWith('input'));

    check('Required 1: every one of the 81 boxes is sent', inputs.length === 81, `${inputs.length} sent`);
    check('the last date is there', labels.some(l => l.includes('"Net Income — December 31, 2027"')));
    check('headers under two rows: the Income Statement columns are named',
      labels.some(l => l.includes('"Expenses — December 31, 2026"')));
    check('a date over two lines keeps its columns and says which line',
      labels.some(l => l.includes('"Retained Earnings — September 17, 2026 (line 2 of 2)"'))
      && labels.some(l => l.includes('"Assets — July 2, 2027 (line 1 of 2)"')),
      labels.filter(l => l.includes('September 17')).slice(0, 2).join(' | '));
    check('the "$" beside each box is never taken for a row name', !labels.some(l => /— \$"/.test(l)));
    check('worksheets go to Sonnet 5.5, thinking harder, with room to',
      first?.model === 'claude-sonnet-5-5' && first?.output_config?.effort === 'medium' && first?.max_tokens >= 16000,
      `${first?.model} ${first?.output_config?.effort} ${first?.max_tokens}`);

    const d = p.w.document;
    check('Required 2 is opened and answered in the same run', !!second && promptOf(second).includes('Total accounts receivable'),
      `${p.requests.length} calls, ${final}`);
    const l2 = second ? linesOf(second).map(([, l]) => l) : [];
    check('the dropdown is shown with its options and which row it names',
      l2.some(l => /^select "row 2's name".*options=\[.*Less: Allowance for uncollectible accounts/.test(l)), l2.find(l => l.startsWith('select')));
    check('the amounts in that row say the dropdown names it',
      l2.some(l => l.includes('"2026 — row 2, named by its dropdown (not chosen yet)"')),
      l2.filter(l => l.includes('2026')).join(' | '));
    const sel = d.querySelector('select');
    check('the dropdown is set to the option meant, from a shortened name',
      sel?.selectedOptions[0]?.textContent === 'Less: Allowance for uncollectible accounts', sel?.value);
    check('every Required 2 box is filled', Array.from(d.querySelectorAll('#part input')).every(i => i.value !== ''));
    check('Next is pressed once, after both parts', nexts === 1 && p.requests.length === 2, `${nexts} Next, ${p.requests.length} calls`);
    check('finishes without an error', !p.isError(), final);
  }

  // ── A dropdown built from divs, with no list until it's opened ──────────
  {
    const { p, final } = await run(true);
    const second = p.requests[1];
    const l2 = second ? linesOf(second).map(([, l]) => l) : [];
    const dd = l2.find(l => l.startsWith('div'));
    check('custom dropdown: its options are read by opening it', /options=\[.*Less: Allowance for uncollectible accounts/.test(dd ?? ''), dd);
    check('custom dropdown: its list is closed again before the model looks',
      !!second && !l2.some(l => l.startsWith('li')), l2.filter(l => l.startsWith('li')).join(' | '));
    check('custom dropdown: the option is picked', p.w.document.querySelector('.pick')?.textContent
      === 'Less: Allowance for uncollectible accounts', p.w.document.querySelector('.pick')?.textContent);
    check('custom dropdown: finishes without an error', !p.isError(), final);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll multi-part worksheet checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
