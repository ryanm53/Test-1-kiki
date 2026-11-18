// A question in three tabs that points to a website (EDGAR: ROE and ROA for two companies).
// A real run answered Required 1, then gave up on Required 2 and 3, left them empty, and went
// on to the next question as if they were done. Now: the model is told to answer from what it
// knows, a part called done with boxes empty is asked again, and parts still blank at the end
// are said in the bar and not rated.
const { boot, settle, bodyText } = require('./harness');

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
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
};
const CONNECT = 'https://learning.mheducation.com/smartbook/1';
const INTRO = 'EDGAR: Cisco and Arista. Visit www.sec.gov and search for the annual reports (10-K) of Cisco Systems and Arista Networks. Locate the balance sheet and income statement of each company.';
const PARTS = [
  ['Required 1', 'Calculate the return on equity (ROE) for both companies.', ['Cisco Systems', 'Arista Networks']],
  ['Required 2', 'Calculate the return on assets (ROA) for both companies.', ['Cisco Systems', 'Arista Networks']],
  ['Required 3', 'Explain how a company can have a slightly higher ROE than its competitor.', ['How can a company have a slightly higher ROE?']]
];
const page = `<body><div role="main"><p>${INTRO}</p>
  <ul>${PARTS.map(([t], i) => `<li><a role="tab" href="#p${i}" aria-selected="${i === 0}">${t}</a></li>`).join('')}</ul>
  <div id="part"></div><button class="next-button">Next</button></div></body>`;

// The real page's boxes are worksheet cells (typed into with real keys, Enter to commit),
// so both kinds are run: ordinary boxes, and cells
function keys(p) {
  const d = p.w.document; let cell = null, text = '';
  d.addEventListener('mousedown', e => { const td = e.target.closest?.('td.responseCell'); if (td) { cell = td; text = ''; } }, true);
  p.bg.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method !== 'Input.dispatchKeyEvent' || !cell || params.type === 'keyUp') return;
    if (params.key === 'Enter') { if (text) cell.textContent = text; text = ''; }
    else if (params.text && params.text !== '\r') text += params.text;
  };
}

function wire(p, cells = false) {
  const d = p.w.document, saved = {};
  if (cells) keys(p);
  let cur = -1;
  const show = i => {
    if (cur >= 0) saved[cur] = d.getElementById('part').innerHTML;
    cur = i;
    d.getElementById('part').innerHTML = saved[i] ?? `<p>${PARTS[i][1]}</p><table>${PARTS[i][2].map(r => `<tr><td>${r}</td>${cells ? '<td class="responseCell" tabindex="0"></td>' : `<td><input type="text" aria-label="${r}"></td>`}</tr>`).join('')}</table>`;
    d.querySelectorAll('[role="tab"]').forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
  };
  d.querySelectorAll('[role="tab"]').forEach((t, i) => t.addEventListener('click', e => { e.preventDefault(); show(i); }));
  show(0);
}

(async () => {
  for (const cells of [false, true]) {
    const kind = cells ? 'worksheet cells' : 'ordinary boxes';
    // Required 1 answered; the model gives up on the others
    const clicks = [];
    const p = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 0, autoContinue: false },
      reply: b => /Calculate the return on equity/.test(bodyText(b)) && !/ALREADY done/.test(bodyText(b))
        ? as(b, { action: 'fill', fills: [...bodyText(b).matchAll(/\[(\d+)\] (?:input|td)/g)].slice(0, 2).map((m, i) => ({ index: Number(m[1]), value: ['29.9', '27.7'][i] })) })
        : as(b, { action: 'none' }) });
    wire(p, cells);
    p.w.document.querySelector('.next-button').addEventListener('click', () => clicks.push('next'));
    p.pressPlay();
    const final = await settle(p, 120000);
    check(`${kind}: parts left blank are said, not rated and gone on from`, p.isError() && /Couldn't fill in Required 2 and Required 3/.test(final) && !/Required 1/.test(final), final);
    check('  and why: the question needs figures from a website', /website/.test(final), final);
    check('  and Next was not pressed', clicks.length === 0, clicks.join());
    check('  each blank part was asked a second time before being given up on', p.requests.filter(r => /every box here is still empty/.test(bodyText(r))).length === 2, `${p.requests.length} calls`);
    check('  the model was told to answer from what it knows', p.requests.every(r => /Never leave a box empty/.test(bodyText(r))), `${p.requests.length} calls`);
  }

  // A part with some boxes filled and some not is an answer (a statement leaves cells unused)
  {
    const p = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: b => /ALREADY done/.test(bodyText(b)) ? as(b, { action: 'none' })
        : as(b, { action: 'fill', fills: [{ index: 3, value: /Explain/.test(bodyText(b).split('Elements')[0]) ? 'More debt.' : '12.6' }] }) });
    wire(p);
    p.pressPlay();
    const final = await settle(p, 120000);
    check('a part with one box filled and one left is not called blank', !p.isError() && !/Couldn't fill in/.test(final), final);
  }

  // The model does answer every part: nothing is said
  const q = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
    reply: b => {
      const t = bodyText(b);
      const m = [...t.matchAll(/\[(\d+)\] input[^\n]*/g)].map(x => Number(x[1]));
      return /ALREADY done/.test(t) && !/NOT done/.test(t) ? as(b, { action: 'none' }) : as(b, { action: 'fill', fills: m.map(index => ({ index, value: '12.5' })) });
    } });
  wire(q);
  q.pressPlay();
  const ok = await settle(q, 90000);
  check('a model that answers every part is not stopped', !q.isError() && !/Couldn't fill in/.test(ok), ok);

  // Worksheet cells, every part answered — Required 3 is one lone cell for a written answer
  {
    const p = boot(page, { installLayout: flat, url: CONNECT, storage: { lastPresetIndex: 1, autoContinue: false },
      reply: b => {
        const t = bodyText(b), written = /Explain/.test(t.split('Elements')[0]);
        const m = [...t.matchAll(/\[(\d+)\] td/g)].map(x => Number(x[1]));
        return /ALREADY done/.test(t) ? as(b, { action: 'none' }) : as(b, { action: 'fill', fills: m.map(index => ({ index, value: written ? 'It uses less debt' : '12.6' })) });
      } });
    wire(p, true);
    p.pressPlay();
    const final = await settle(p, 120000);
    const d = p.w.document;
    const lone = [...d.querySelectorAll('#part td.responseCell')].map(c => c.textContent);
    check('worksheet cells: all three parts answered, the lone cell of Required 3 among them', !p.isError() && lone.join() === 'It uses less debt' && p.requests.length === 3, `${lone} / ${p.requests.length} calls / ${final}`);
    d.querySelectorAll('[role="tab"]')[1].click();
    check('  Required 2 holds its figures', [...d.querySelectorAll('#part td.responseCell')].map(c => c.textContent).join() === '12.6,12.6');
  }

  console.log(failed ? `\n${failed} failed` : '\nAll blank-part checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('CRASHED:', e.stack); process.exit(1); });
