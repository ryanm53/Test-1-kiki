// Real Chromium, real extension: Connect fill-in-the-blank questions where the blank is
// somewhere the page scan used to miss — in a shadow root (with the confidence rating
// and Next in there beside it), or a see-through box. A real log had eight of these
// fail, the page's text holding the question and nothing listed to type into.
// The page is served as learning.mheducation.com so the extension treats it as Connect;
// the AI is a stand-in inside the service worker.
//
//   node scripts/real-chrome-blank.js [extension-dir]
//
// Like real-chrome.js, not part of `npm test`: needs Chromium and playwright-core.
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (_) { console.error('playwright-core is missing: npm install --no-save playwright-core'); process.exit(2); }
const http = require('http'), fs = require('fs'), path = require('path');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'extension'));

const PAGES = {
  shadow: `<!doctype html><html><body><div role="main"><h2>Fill in the Blank Question</h2><p>Fill in the blank question.</p><avalon-blank id="host"></avalon-blank></div>
<script>
window.__events = []; window.__value = null;
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<p> investors are wealthy individuals willing to risk funds on a new venture.</p><input id="b" type="text" aria-label="Blank"><button aria-label="High Confidence">High Confidence</button><button class="next-button">Next Question</button>';
root.getElementById('b').addEventListener('input', e => { window.__value = e.target.value; });
root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => window.__events.push(b.textContent.trim())));
</script></body></html>`,
  seeThrough: `<!doctype html><html><body><div role="main"><h2>Fill in the Blank Question</h2><p>Fill in the blank question.</p>
<p><span style="position:relative;display:inline-block;width:120px;border-bottom:1px solid #000"><input id="b" type="text" style="opacity:0;position:absolute;inset:0;width:100%"></span> investors are wealthy individuals.</p>
<button aria-label="High Confidence">High Confidence</button><button class="next-button">Next Question</button></div>
<script>
window.__events = []; window.__value = null;
document.getElementById('b').addEventListener('input', e => { window.__value = e.target.value; });
document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => window.__events.push(b.textContent.trim())));
</script></body></html>`
};
let bad = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + d}`); if (!ok) bad++; };
let which = 'shadow';
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[which]); });
(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/pa-bl-'), {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server', '--host-resolver-rules=MAP *.mheducation.com 127.0.0.1']
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  for (let i = 0; i < 50 && await sw.evaluate(() => typeof chrome?.storage?.local).catch(() => '') !== 'object'; i++) await new Promise(r => setTimeout(r, 100));
  await sw.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-ant-api03-demo', mode: 'one', lastPresetIndex: 0, autoContinue: false, autoUpgrade: true, model: 'claude-haiku-5-5', keepLog: true }));
  await sw.evaluate(() => {
    globalThis.__reqs = [];
    self.fetch = async (url, init) => {
      const body = JSON.parse(init.body); globalThis.__reqs.push(body);
      const content = body.messages[0].content;
      const text = Array.isArray(content) ? content.find(b => b.type === 'text').text : content;
      const m = /\[(\d+)\][^\n]*(Blank|the blank)/i.exec(text);
      const action = m && !/ALREADY done/.test(text) ? { action: 'fill', fills: [{ index: Number(m[1]), value: 'angel' }] } : { action: 'none' };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(action) }], stop_reason: 'end_turn' }), { status: 200 });
    };
  });
  for (const name of ['shadow', 'seeThrough']) {
    which = name;
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(`http://learning.mheducation.com:${port}/`);
    await page.waitForSelector('#__cap-host', { state: 'attached' });
    await page.waitForTimeout(800); await page.bringToFront();
    await page.locator('#__cap-host >> #go').click();
    await page.waitForFunction(() => window.__events.includes('Next Question'), null, { timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(500);
    const value = await page.evaluate(() => window.__value), events = await page.evaluate(() => window.__events);
    const status = await page.locator('#__cap-host >> #statusText').textContent();
    const label = name === 'shadow' ? 'a blank in a shadow root' : 'a see-through blank';
    check(`${label}: typed into, in a real browser`, value === 'angel', `${JSON.stringify(value)} / ${status}`);
    check(`  the confidence rating and Next pressed after it`, events.join() === 'High Confidence,Next Question', `${events} / ${status}`);
    check('  no error in the bar, no page errors', !/rror|stuck|Could not|Couldn/.test(status) && errs.length === 0, `${status} ${errs}`);
    await page.close();
  }
  await ctx.close(); server.close();
  console.log(bad ? `\n${bad} failed` : '\nAll real-browser blank checks passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
