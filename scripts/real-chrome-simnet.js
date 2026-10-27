// Real Chromium, real extension, real key presses through the debugger: a formula
// typed into a SIMnet-like sheet whose editor is wiped by its popups — the list of
// function names after "=" and three letters, the argument hint after "(" — which
// is what a real SIMnet log showed ("typed =RIG ... typed HT(A2,2)", the cell
// holding "HT(A2,2)"). The page draws the editor as plain text in the formula bar
// and in an overlay on the cell, as SIMnet does, so this is also the check of
// reading it back from the page's own lines. The AI is a stand-in in the worker.
//
//   node scripts/real-chrome-simnet.js [extension-dir]
//
// Like real-chrome.js, not part of `npm test`: needs Chromium and playwright-core.
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (_) { console.error('playwright-core is missing: npm install --no-save playwright-core'); process.exit(2); }
const http = require('http'), fs = require('fs'), path = require('path');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'extension'));
const FORMULAS = ['=RIGHT(A2,2)', '=SUMIFS(JunePrices,JunePOs,D1,JuneCompanies,"Salon Supplies")', '=ROUNDDOWN(C2/C14,3)'];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;margin:0}td{width:70px;height:22px;border:1px solid #ccc}
 #fb{border:1px solid #888;height:24px;margin:6px;padding:2px 6px}#ov{position:absolute;left:300px;top:120px;background:#fff;border:2px solid green;padding:2px 6px;min-width:80px}</style></head><body>
<div role="main"><p style="padding:8px 14px">Enter a formula in cell D2 to find the section code by extracting the last two letters of the class/section code in cell A2.</p>
<button>Home</button><input id="namebox" value="D2" aria-label="Name Box"><div id="fb"></div><div id="ov" hidden></div>
<table style="border-collapse:collapse">${Array.from({ length: 10 }, (_, r) => `<tr>${Array.from({ length: 8 }, (_, c) =>
  `<td class="grdbdy-cell" id="cell-${'ABCDEFGH'[c]}${r + 1}" tabindex="0"></td>`).join('')}</tr>`).join('')}</table></div>
<script>
const st={open:false,text:'',shown:{}}; window.__committed=null; window.__esc=0; window.__bs=0; window.__keys='';
let sel=null; const fb=document.getElementById('fb'), ov=document.getElementById('ov');
document.querySelectorAll('td').forEach(td=>td.addEventListener('mousedown',()=>{sel=td;}));
const render=()=>{fb.textContent=st.open?st.text:'';ov.hidden=!st.open;ov.textContent=st.text;};
const popup=k=>setTimeout(()=>{if(!st.shown[k]){st.shown[k]=true;st.text='';render();}},100);
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'){if(st.open){window.__committed=st.text;document.getElementById('cell-D2').textContent=st.text;st.open=false;render();}return;}
  if(e.key==='Escape'){st.open=false;st.text='';window.__esc++;render();return;}
  if(e.key==='Backspace'){if(st.open){st.text=st.text.slice(0,-1);window.__bs++;render();}return;}
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&sel&&sel.id==='cell-D2'){
    if(!st.open){st.open=true;st.text='';}
    st.text+=e.key; window.__keys+=e.key;
    if(st.text.length===3&&st.text[0]==='=')popup('list');
    if(e.key==='(')popup('hint');
    render();
  }
});
</script></body></html>`;

let bad = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + d}`); if (!ok) bad++; };
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
(async () => {
  await new Promise(r => server.listen(0, r));
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/pa-sn-'), {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server']
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  // The worker's Chrome APIs aren't always there the instant it appears
  for (let i = 0; i < 50 && await sw.evaluate(() => typeof chrome?.storage?.local).catch(() => '') !== 'object'; i++) await new Promise(r => setTimeout(r, 100));
  for (const formula of FORMULAS) {
    await sw.evaluate(f => {
      chrome.storage.local.clear();
      chrome.storage.local.set({ apiKey: 'sk-ant-api03-demo', mode: 'one', lastPresetIndex: 1, autoContinue: false, autoUpgrade: true, keepLog: true });
      let n = 0;
      self.fetch = async () => {
        n++;
        const action = n === 1 ? { action: 'type', cell: 'D2', text: f } : n === 2 ? { action: 'key', key: 'Enter' } : { action: 'none' };
        return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(action) }], stop_reason: 'end_turn' }), { status: 200 });
      };
    }, formula);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForSelector('#__cap-host', { state: 'attached' });
    await page.waitForTimeout(800); await page.bringToFront();
    const t0 = Date.now();
    await page.locator('#__cap-host >> #go').click();
    await page.waitForFunction(() => window.__committed !== null, null, { timeout: 90000 }).catch(() => {});
    const took = Date.now() - t0;
    await page.waitForTimeout(500);
    const got = await page.evaluate(() => ({ committed: window.__committed, esc: window.__esc, bs: window.__bs }));
    const status = await page.locator('#__cap-host >> #statusText').textContent();
    const log = await sw.evaluate(async () => (await chrome.storage.local.get('answerLog')).answerLog?.[0]);
    check(`${formula.slice(0, 28)}…: lands in the cell whole, in a real browser`, got.committed === formula, JSON.stringify(got.committed));
    check('  noticed the wipe and put it back (cleared and retyped, no cancel)', got.bs > 0 && got.esc === 0, `${got.bs} backspaces, ${got.esc} escapes`);
    check('  no error in the bar, no page errors', !/rror|kept losing/.test(status) && errs.length === 0, `${status} ${errs}`);
    console.log(`        ${took} ms; trail ${JSON.stringify(log?.typing?.[0]?.trail)}`);
    await page.close();
  }
  await ctx.close(); server.close();
  console.log(bad ? `\n${bad} failed` : '\nAll real-browser SIMnet formula checks passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
