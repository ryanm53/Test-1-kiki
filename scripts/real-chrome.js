// The REAL extension in real Chromium, end to end — what the jsdom suites can't
// show: that the package loads, the service worker runs, the bar draws and drags,
// a page's kind is recognised, the popup and the shortcut work, a real screenshot
// is taken, the numbered tags are really IN it and always come down, and a whole
// run goes through real clicks. The AI is a stand-in inside the service worker.
//
//   node scripts/real-chrome.js [extension-dir]
//
// Not part of `npm test`, which has to run anywhere: this needs Chromium and the
// playwright-core package (`npm install --no-save playwright-core`). Set
// CHROMIUM=/path/to/chrome if it isn't at the usual place.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (_) { console.error('playwright-core is missing: npm install --no-save playwright-core'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const EXT = path.resolve(process.argv[2] || path.join(ROOT, 'extension'));
const CHROME = process.env.CHROMIUM
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find(p => fs.existsSync(p));
const { ALL_ON_ONE_PAGE } = require(path.join(ROOT, 'test', 'fixtures-canvas.js'));

const FONT = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
const CHART = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160"><rect width="420" height="160" fill="#eef"/>' +
  '<rect x="30" y="50" width="60" height="90" fill="#58f"/><rect x="130" y="20" width="60" height="120" fill="#58f"/>' +
  '<rect x="230" y="80" width="60" height="60" fill="#58f"/></svg>');

const PAGES = {
  '/connect': `<!doctype html><html><head><meta charset="utf-8"><style>body{${FONT};background:#f4f5f7;margin:0}.wrap{max-width:720px;margin:24px auto;background:#fff;padding:24px 30px}
    label{display:flex;gap:10px;padding:9px;border:1px solid #dde;margin:7px 0}button{padding:8px 14px;margin-right:6px}</style></head><body><div role="main" class="wrap">
    <p>Capetown sold 580 units. Ending inventory assuming FIFO would be:</p>
    <table border="1" cellpadding="6"><tr><th>Date</th><th>Transaction</th><th>Units</th></tr><tr><td>April 1</td><td>Beginning Inventory</td><td>450</td></tr></table>
    ${['$784.', '$1,215.', '$864.', '$1,102.'].map(c => `<label><input type="radio" name="q" aria-label="${c}"> ${c}</label>`).join('')}
    <button aria-label="High Confidence">High</button><button class="next-button">Next Question</button></div></body></html>`,
  '/picture': `<!doctype html><html><head><meta charset="utf-8"><style>body{${FONT};background:#f4f5f7;margin:0}.wrap{max-width:720px;margin:24px auto;background:#fff;padding:24px 30px}
    label{display:flex;gap:10px;padding:9px;border:1px solid #dde;margin:7px 0}button{padding:8px 14px;margin-right:6px}</style></head><body><div role="main" class="wrap">
    <p>Using the chart below, in which quarter were sales highest?</p><img src="${CHART}" alt="" width="420" height="160">
    ${['Quarter 1', 'Quarter 2', 'Quarter 3'].map((c, i) => `<label><input type="radio" name="q" id="q${i}" aria-label="${c}"> ${c}</label>`).join('')}
    <button aria-label="High Confidence">High</button><button class="next-button">Next Question</button></div></body></html>`,
  '/simnet': `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;${FONT}}.shell-btn{margin:2px;padding:5px 9px}</style></head><body><div role="main">
    <p style="padding:8px 14px">Rename Sheet1: Dec 16. <span>1 of 3 Attempts</span></p>
    <div>${['Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View'].map(t => `<button class="shell-btn">${t}</button>`).join('')}
    ${['Paste', 'Cut', 'Copy', 'Bold', 'Italic', 'Underline'].map(t => `<button class="shell-btn" title="${t}">${t[0]}</button>`).join('')}</div>
    <table style="border-collapse:collapse;margin:10px">${Array.from({ length: 8 }, (_, r) => `<tr>${Array.from({ length: 10 }, (_, c) =>
      `<td class="grdbdy-cell has-value" id="cell-${'ABCDEFGHIJ'[c]}${r + 1}" tabindex="0" style="width:70px;height:22px;border:1px solid #ccc">${r * 10 + c}</td>`).join('')}</tr>`).join('')}</table>
    <div style="display:flex;gap:8px;padding:8px"><div>Sheet1</div><div>Sheet2</div><div aria-label="New sheet">+</div></div></div></body></html>`,
  '/framed': `<!doctype html><html><body style="${FONT}"><h3 style="padding:8px 20px">Outer page</h3><iframe src="/inner" style="width:760px;height:420px;margin-left:20px"></iframe></body></html>`,
  '/inner': `<!doctype html><html><body style="${FONT};padding:14px"><p>Which of the following is an asset? Choose the right answer please.</p>
    ${['Accounts receivable', 'Unearned revenue'].map(c => `<label style="display:block;margin:8px"><input type="radio" name="q" aria-label="${c}"> ${c}</label>`).join('')}<button class="next-button">Next Question</button></body></html>`,
  '/dialog': `<!doctype html><html><head><meta charset="utf-8"></head><body style="${FONT}"><p style="padding:14px">Format Cells.</p><button>Format</button>
    <dialog id="dlg" style="width:420px;padding:20px"><p>Number format</p><select aria-label="Category"><option>General</option><option>Currency</option></select>
    <div style="margin-top:14px"><button>OK</button> <button>Cancel</button></div></dialog><script>document.getElementById('dlg').showModal();</script></body></html>`
};
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(p.includes('quizzes') ? `<!doctype html><html>${ALL_ON_ONE_PAGE}</html>` : (PAGES[p] ?? PAGES['/connect']));
});

let bad = 0, total = 0;
const check = (name, ok, detail = '') => { total++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`); if (!ok) bad++; };

// Yellow pixels (the tags' colour) in a jpeg, counted inside a page
const countYellow = (page, b64) => page.evaluate(async data => {
  const im = new Image(); im.src = 'data:image/jpeg;base64,' + data; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 190 && d[i + 1] < 235 && d[i + 2] < 90) n++;
  return n;
}, b64);

(async () => {
  if (!CHROME) { console.error('No Chromium found: set CHROMIUM=/path/to/chrome'); process.exit(2); }
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rc-')), {
    executablePath: CHROME, headless: true, viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server']
  });
  const errors = [];
  try {
    // ── The package loads and its worker runs ───────────────────────────────
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    check('the extension loads and its background worker starts', /background\.js$/.test(sw.url()), sw.url());
    check('the background code ran without errors', await sw.evaluate(() => typeof MODELS === 'object' && typeof runGoal === 'function' && typeof captureTab === 'function'));
    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    check('the manifest is the one in the folder', manifest.name === 'Page Agent' && /^\d+\.\d+\.\d+$/.test(manifest.version), `${manifest.name} ${manifest.version}`);

    const open = async url => {
      const p = await ctx.newPage();
      p.on('pageerror', e => errors.push(`${url}: ${e.message}`));
      await p.goto(base + url);
      await p.waitForSelector('#__cap-host', { state: 'attached', timeout: 10000 });
      await p.waitForTimeout(700);
      return p;
    };
    const sh = (page, sel) => page.locator(`#__cap-host >> ${sel}`);

    // ── The bar, the key, the panel ─────────────────────────────────────────
    const page = await open('/connect');
    check('the control bar appears', true);
    check('no key yet: says so', /Add your API key/.test(await sh(page, '#statusText').textContent()));
    await sh(page, '#gear').click();
    await sh(page, '#key').fill('sk-ant-api03-demo');
    await sh(page, '#saveKey').click();
    check('saving a key folds the editor away', await sh(page, '#keySaved').isVisible() && !(await sh(page, '#keyEdit').isVisible()));
    await sh(page, '#moreBtn').click();
    const models = await sh(page, '#model').evaluate(s => [...s.options].map(o => o.textContent).join());
    check('the model menu is Auto, Haiku 5.5, Sonnet 5.5', models === 'Auto,Haiku 5.5,Sonnet 5.5', models);
    await sh(page, '#close').click();

    // ── Dragging, and staying put after a reload ────────────────────────────
    const b = await sh(page, '#status').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.mouse.move(700, 200, { steps: 8 }); await page.mouse.up();
    const moved = await page.evaluate(() => document.getElementById('__cap-host').getBoundingClientRect().top);
    await page.reload();
    await page.waitForSelector('#__cap-host', { state: 'attached' });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.getElementById('__cap-host').getBoundingClientRect().top);
    check('the bar can be dragged, and stays put after a reload', moved < 400 && Math.abs(after - moved) < 2, `${moved} / ${after}`);

    // ── Page kinds ──────────────────────────────────────────────────────────
    const kind = async url => {
      const p = await open(url);
      await p.waitForFunction(() => /·/.test(document.getElementById('__cap-host').shadowRoot.getElementById('statusText').textContent), null, { timeout: 15000 }).catch(() => {});
      return sh(p, '#statusText').textContent();
    };
    check('a Canvas quiz is recognised', await kind('/courses/1/quizzes/2/take') === 'Ready · Canvas quiz');
    check('SIMnet is recognised', await kind('/simnet') === 'Ready · SIMnet');

    // ── Hiding the bar: the –, the shortcut, the popup ──────────────────────
    const cmds = await sw.evaluate(() => chrome.commands.getAll());
    check('the show/hide shortcut is registered', cmds.some(c => c.name === 'toggle-bar' && /H$/.test(c.shortcut)), JSON.stringify(cmds));
    await page.bringToFront();
    await sh(page, '#hide').click();
    const hidden = () => page.evaluate(() => document.getElementById('__cap-host').shadowRoot.getElementById('root').hidden);
    check('the – hides the bar', await hidden());
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage();
    popup.on('pageerror', e => errors.push(`popup: ${e.message}`));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(400);
    check('the popup switch shows it is hidden', (await popup.locator('#showBar').getAttribute('aria-checked')) === 'false');
    await popup.locator('#showBar').click();
    await page.waitForFunction(() => !document.getElementById('__cap-host').shadowRoot.getElementById('root').hidden, null, { timeout: 5000 }).catch(() => {});
    check('switching it on brings the bar back on the open page', !(await hidden()));
    await sw.evaluate(() => toggleBar());
    await page.waitForFunction(() => document.getElementById('__cap-host').shadowRoot.getElementById('root').hidden, null, { timeout: 5000 }).catch(() => {});
    check('the shortcut\'s toggle hides it again', await hidden());
    await sw.evaluate(() => toggleBar());
    await page.waitForTimeout(300);

    // ── Screenshots with numbered tags, on real pages ───────────────────────
    for (const [name, url, extra] of [['a question page', '/connect'], ['a SIMnet-like grid', '/simnet'], ['a question inside an iframe', '/framed'], ['a modal dialog (top layer)', '/dialog']]) {
      const p = await open(url);
      await p.bringToFront();
      const before = await p.evaluate(() => document.documentElement.outerHTML.replace(/<div id="__cap-host".*$/s, ''));
      const out = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' });
        const frameId = await findQuestionFrame(tab.id);
        const data = await sendToTab(tab.id, { type: 'SCRAPE' }, frameId);
        const shot = await captureTab(tab.id, frameId);
        return { frameId, listed: data.elements.length, shot };
      });
      const yellow = out.shot ? await countYellow(p, out.shot.data) : 0;
      check(`${name}: a screenshot is taken, as a jpeg`, !!out.shot && out.shot.type === 'image/jpeg' && out.shot.data.startsWith('/9j/'));
      check(`${name}: every listed item (${out.listed}) is tagged`, out.shot?.marked === out.listed, `${out.shot?.marked} of ${out.listed}`);
      check(`${name}: the tags are really IN the picture (${yellow} yellow pixels)`, yellow >= (out.shot?.marked ?? 1) * 25, String(yellow));
      const frames = await Promise.all(p.frames().map(f => f.evaluate(() => document.querySelectorAll('#__cap-marks').length).catch(() => 0)));
      check(`${name}: no tags left, anywhere`, frames.every(n => n === 0), frames.join());
      const afterHtml = await p.evaluate(() => document.documentElement.outerHTML.replace(/<div id="__cap-host".*$/s, ''));
      check(`${name}: the page's markup is exactly as it was`, afterHtml === before);
      if (url === '/framed') check('the question inside the iframe was found', out.frameId !== 0, `frame ${out.frameId}`);
    }

    // ── A whole run: press play on a page with a picture ────────────────────
    await sw.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-ant-api03-demo', mode: 'one', lastPresetIndex: 0, autoContinue: false, autoUpgrade: true, model: 'claude-haiku-5-5', keepLog: true }));
    await sw.evaluate(() => {
      globalThis.__reqs = [];
      self.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        globalThis.__reqs.push(body);
        const c = body.messages[0].content;
        const text = Array.isArray(c) ? c.find(x => x.type === 'text').text : c;
        const m = /\[(\d+)\] input type="radio" "Quarter 2"/.exec(text);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ action: 'click', index: Number(m?.[1] ?? 0) }) }], stop_reason: 'end_turn' }), { status: 200 });
      };
    });
    const run = await open('/picture');
    await run.bringToFront();
    await sh(run, '#go').click();
    await run.waitForFunction(() => document.getElementById('q1').checked, null, { timeout: 30000 }).catch(() => {});
    const req = (await sw.evaluate(() => globalThis.__reqs))[0];
    const content = req?.messages?.[0]?.content;
    const img = Array.isArray(content) ? content.find(x => x.type === 'image') : null;
    const text = Array.isArray(content) ? content.find(x => x.type === 'text').text : '';
    check('a run: the AI is sent the image and the words together', !!img && !!text);
    check('a run: the prompt says the tags are the list\'s numbers', /small yellow number/.test(text));
    check('a run: the tags are in that very picture', img ? await countYellow(run, img.source.data) >= 5 * 25 : false);
    check('a run: the click the AI chose really happened', await run.evaluate(() => document.getElementById('q1').checked));
    let log = null;
    for (let i = 0; i < 40 && !log?.length; i++) { await run.waitForTimeout(250); log = await sw.evaluate(async () => (await chrome.storage.local.get('answerLog')).answerLog); }
    check('a run: the log notes the picture and keeps none of it', /screenshot of the page was attached/.test(log?.[0]?.steps?.[0]?.prompt ?? '') && !JSON.stringify(log).includes('/9j/'));
    check('a run: no tags left on the page', (await run.evaluate(() => document.querySelectorAll('#__cap-marks').length)) === 0);

    check('no page errors anywhere', errors.length === 0, errors.join(' | '));
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(bad ? `\n${bad} of ${total} real-Chrome checks failed` : `\nAll ${total} real-Chrome checks passed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
