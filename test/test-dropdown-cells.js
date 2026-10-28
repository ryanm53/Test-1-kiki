// Connect worksheet cells whose editor is a dropdown (a table of items with a
// "Reporting Method" column, a list of names opening beside the cell as you type).
// In a real run some cells took and some didn't, a couple took the wrong entry, and
// every one was reported as filled: the answer was typed and Enter pressed 60ms
// later, before the list had opened, and nothing was ever read back.
//
// A cell is now read back after every try, tried again a different way if it doesn't
// show what was meant, and reported — with the entries the list really offers — if
// it never does. Those entries then go to the model on the retry, so a label that
// isn't one of them gets corrected. The simulator below has the ways such an
// editor misbehaves: Enter ignored until the list has opened; Enter that never
// commits (the entry has to be clicked); Enter that commits the wrong entry.
const { boot, settle, until, bodyText } = require('./harness');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};
const as = (body, obj) => {
  const s = JSON.stringify(obj);
  return body.messages.at(-1)?.role === 'assistant' ? s.slice('{"action":"'.length) : s;
};
const flat = w => {
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/x';
const OPTIONS = ['Current liability', 'Long-term liability', 'Disclosure note only'];
const ITEMS = ['1. Accounts payable.', '2. Sales tax collected from customers.', '3. Notes payable due in 2 years.', '4. Unused line of credit.'];
const RIGHT = ['Current liability', 'Current liability', 'Long-term liability', 'Disclosure note only'];

const page = (numbers = false) => `<body><div role="main"><p>Select the appropriate reporting method for each of the items listed below.</p>
  <table><tr><th>Item</th><th>${numbers ? 'Amount' : 'Reporting Method'}</th></tr>
  ${ITEMS.map((t, i) => `<tr><td>${t}</td><td class="responseCell" tabindex="0" id="c${i + 1}"></td></tr>`).join('')}</table>
  <button class="next-button">Next Question</button></div></body>`;

// The editor. mode: 'race' Enter works once the list has opened; 'clickonly' Enter
// never commits; 'wrong' Enter commits the first entry whatever was typed; 'deaf'
// nothing typed ever takes. numbers: the cell formats what is typed, as an amount.
function sheet(p, mode, { numbers = false } = {}) {
  const d = p.w.document, cells = Array.from(d.querySelectorAll('td.responseCell'));
  const st = { cell: null, text: '', popup: null, timer: null, enters: 0, ignored: 0, clicked: 0, escapes: 0 };
  const close = () => { st.popup?.remove(); st.popup = null; clearTimeout(st.timer); };
  const commit = v => {
    st.cell.textContent = numbers ? Number(v).toLocaleString('en-US') : v;
    close(); st.text = '';
  };
  const open = () => {
    close();
    const ul = d.createElement('ul');
    ul.className = 'ui-autocomplete';
    OPTIONS.filter(o => o.toLowerCase().startsWith(st.text.toLowerCase().slice(0, 1))).forEach(o => {
      const li = d.createElement('li');
      li.className = 'ui-menu-item'; li.textContent = o;
      li.addEventListener('click', () => { st.clicked++; if (mode !== 'deaf') commit(o); });
      ul.appendChild(li);
    });
    d.body.appendChild(ul); st.popup = ul;
  };
  cells.forEach(td => td.addEventListener('mousedown', () => { close(); st.cell = td; st.text = ''; }));
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method !== 'Input.dispatchKeyEvent' || !st.cell) return;
    if (params.type === 'keyDown' && params.key === 'Enter') {
      st.enters++;
      if (mode === 'deaf') { st.ignored++; return; }
      if (numbers) { if (st.text) commit(st.text); return; }
      if (mode === 'clickonly') { st.ignored++; return; }
      if (!st.popup) { st.ignored++; return; }            // the list had not opened yet
      if (mode === 'wrong') { commit(OPTIONS[0]); return; }
      if (OPTIONS.includes(st.text)) commit(st.text); else st.ignored++;
    } else if (params.type === 'keyDown' && params.text && params.text !== '\r') {
      st.text += params.text;
      if (!numbers) { clearTimeout(st.timer); st.timer = setTimeout(open, 250); }   // the list opens a quarter second after the last letter
    } else if (params.type === 'rawKeyDown' && params.key === 'Escape') {
      st.escapes++; close(); st.text = '';
    }
  };
  return { st, values: () => cells.map(c => c.textContent) };
}

const fillAll = values => b => {
  const idx = ITEMS.map(t => Number(new RegExp(`\\[(\\d+)\\] td "[^"]*${t.slice(3, 15).replace(/[.]/g, '\\.')}`).exec(bodyText(b))?.[1]));
  return as(b, { action: 'fill', fills: idx.map((index, i) => ({ index, value: values[i] })) });
};
const run = async (mode, reply, opts) => {
  const p = boot(page(opts?.numbers), { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false }, reply });
  const s = sheet(p, mode, opts);
  p.pressPlay();
  const final = await settle(p, 120000);
  return { p, s, final };
};

(async () => {
  // ── The list opens a moment after the letters: wait for it ───────────────
  {
    const { p, s, final } = await run('race', fillAll(RIGHT));
    check('Enter waits for the list: every cell shows what was meant', s.values().join() === RIGHT.join(), s.values().join(' | '));
    check('  nothing needed asking twice, and the bar shows no error', p.requests.length === 1 && !p.isError(), `${p.requests.length} calls / ${final}`);
  }

  // ── Enter never commits: the entry is picked from the list ───────────────
  {
    const { s, p, final } = await run('clickonly', fillAll(RIGHT));
    check('when Enter does nothing, the entry is clicked in the list', s.values().join() === RIGHT.join() && s.st.clicked === 4, `${s.values().join(' | ')} / clicked ${s.st.clicked}`);
    check('  and it is a success', !p.isError(), final);
  }

  // ── Enter commits the wrong entry: noticed, put right ────────────────────
  {
    const { s, p, final } = await run('wrong', fillAll(RIGHT));
    check('an entry that took the wrong value is noticed and put right', s.values().join() === RIGHT.join(), s.values().join(' | '));
    check('  with no error shown', !p.isError(), final);
  }

  // ── A label that is not in the list: said so, with what the list offers, and corrected ──
  {
    const wrongFirst = [...RIGHT]; wrongFirst[2] = 'Long-term debt';
    let seenOffer = false;
    const reply = b => {
      const t = bodyText(b);
      if (/the list for cell \[\d+\] showed: .*Long-term liability/.test(t)) seenOffer = true;
      return fillAll(seenOffer ? RIGHT : wrongFirst)(b);
    };
    const { s, p, final } = await run('race', reply);
    check('a label the list does not have is not called done: the retry corrects it', s.values()[2] === 'Long-term liability', s.values().join(' | '));
    check('  the retry is told what the list showed, and uses it', seenOffer && p.requests.length === 2 && s.values().join() === RIGHT.join(), `${p.requests.length} calls, ${s.values().join(' | ')}`);
  }

  // ── A cell that takes nothing at all is reported, not called filled ──────
  {
    const { s, p, final } = await run('deaf', fillAll(RIGHT));
    check('cells that take nothing are reported as missed, with what they show', p.isError() && /shows ""/.test(final) && /Filled 0\/4|No cells could be filled|missed/.test(final), final);
    check('  and the editor is closed, not left half-open', s.st.escapes >= 1);
  }

  // ── Amounts: formatted by the cell, still read as what was typed ─────────
  {
    const { s, p, final } = await run('race', fillAll(['5000', '1200.5', '-300', '0']), { numbers: true });
    check('amounts the cell formats ("5,000") are accepted as what was typed', s.values().join() === '5,000,1,200.5,-300,0' || s.values().join('|') === '5,000|1,200.5|-300|0', s.values().join(' | '));
    check('  with no retypes', s.st.enters === 4 && !p.isError(), `${s.st.enters} Enters / ${final}`);
  }
  {
    const { s, p, final } = await run('deaf', fillAll(['5000', '1200', '300', '40']), { numbers: true });
    check('an amount that does not take is retried once, then reported', p.isError() && s.st.enters >= 8, `${s.st.enters} Enters / ${final}`);
  }

  console.log(failed ? `\n${failed} failed` : '\nAll dropdown-cell checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
