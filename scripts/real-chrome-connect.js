// Real Chromium, real extension: a wrong answer on a working copy of a Connect
// SmartBook page — the concept resource, back to questions, Next — and the right
// answer remembered and given the next time, with no call to the model. The page
// is served as learning.mheducation.com (mapped to this machine) so the
// extension treats it as Connect. The AI is a stand-in inside the service worker.
//
//   node scripts/real-chrome-connect.js [extension-dir]
//
// Like real-chrome.js, not part of `npm test`: needs Chromium and playwright-core.
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (_) { console.error('playwright-core is missing: npm install --no-save playwright-core'); process.exit(2); }
const http = require('http'), fs = require('fs'), path = require('path');
const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'extension'));
const QS = [
  { q: 'Which of the following is a contra-asset account?', c: ['Accounts Receivable', 'Allowance for Doubtful Accounts', 'Sales Revenue', 'Bad Debt Expense'], right: [1] },
  { q: 'Which statement reports revenues and expenses for a period of time?', c: ['Balance sheet', 'Income statement', 'Statement of cash flows', 'Statement of retained earnings'], right: [1] }
];
const PAGE = (order) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#f4f5f7;margin:0}#app{max-width:760px;margin:20px auto;background:#fff;padding:20px 28px}
 button{padding:8px 14px;margin:4px}.box{border:1px solid #2a2;padding:8px;margin:10px 0}.pill{background:#fcc;padding:2px 8px;border-radius:9px}#back{position:fixed;top:10px;right:20px}</style></head><body><div id="app"></div>
<script>
const QS=${JSON.stringify(QS)}; const order0=${JSON.stringify(order)};
const st={n:0,picked:[],graded:false,read:false,view:'q'}; window.__events=[];
const app=document.getElementById('app');
const same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
function render(){const q=QS[st.n%QS.length];const order=(st.n===0&&order0)?order0:q.c.map((_,i)=>i);
 const wrong=st.graded&&!same(st.picked,q.right);const gated=wrong&&!st.read;
 if(st.view==='reading'){app.innerHTML='<div role="main"><button id="back">To Questions</button><h2>Concept</h2><p>Reading about the allowance method.</p></div>';return;}
 app.innerHTML='<div role="main"><h2>Multiple Choice Question</h2><div class="prompt">'+q.q+'</div>'+
 order.map(i=>'<div><label><input type="radio" name="mc" id="c'+i+'" aria-label="'+q.c[i]+'" '+(st.picked.includes(i)?'checked':'')+' '+(st.graded?'disabled':'')+'> <span>'+q.c[i]+'</span></label></div>').join('')+
 (st.graded?'':'<button aria-label="High Confidence">High Confidence</button>')+
 (st.graded?'<div class="result"><span>Your Answer</span> <span class="pill">'+(wrong?'incorrect':'correct')+'</span></div>':'')+
 (wrong?'<div class="box"><h4>Correct Answer</h4>'+q.right.map(i=>'<div>'+q.c[i]+'</div>').join('')+'</div>':'')+
 (gated?'<p>Select a concept resource to continue.</p><button>Clarify with AI Reader</button><button>Read About the Concept</button>':'')+
 '<button class="next-button" '+(gated?'disabled':'')+'>Next Question</button><button>Submit Assignment</button></div>';}
document.addEventListener('click',e=>{const t=e.target;if(t.matches('input')){st.picked=[Number(t.id.slice(1))];return;}
 const b=t.closest('button');if(!b)return;const label=(b.innerText||'').trim();
 if(label==='High Confidence'){st.graded=true;render();return;}
 if(label==='Read About the Concept'){__events.push('resource');st.read=true;st.view='reading';render();return;}
 if(b.id==='back'){__events.push('back');st.view='q';render();return;}
 if(label==='Submit Assignment'){__events.push('SUBMIT');return;}
 if(b.classList.contains('next-button')){__events.push('next');st.n++;st.picked=[];st.graded=false;st.read=false;render();}});
render();
</script></body></html>`;
let bad = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + d}`); if (!ok) bad++; };
let order = null;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(order)); });
(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/pa-cn-'), {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server', '--host-resolver-rules=MAP *.mheducation.com 127.0.0.1']
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-ant-api03-demo', mode: 'one', lastPresetIndex: 0, autoContinue: false, autoUpgrade: true, model: 'claude-haiku-5-5' }));
  await sw.evaluate(() => {
    globalThis.__reqs = [];
    self.fetch = async (url, init) => {
      const body = JSON.parse(init.body); globalThis.__reqs.push(body);
      const content = body.messages[0].content;
      const text = Array.isArray(content) ? content.find(b => b.type === 'text').text : content;
      const m = /\[(\d+)\][^\n]*"Accounts Receivable"/.exec(text);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ action: 'click', index: Number(m?.[1] ?? 0) }) }], stop_reason: 'end_turn' }), { status: 200 });
    };
  });
  const url = `http://learning.mheducation.com:${port}/`;
  const run = async (name, ord) => {
    order = ord;
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(url);
    await page.waitForSelector('#__cap-host', { state: 'attached' });
    await page.waitForTimeout(800); await page.bringToFront();
    await page.locator('#__cap-host >> #go').click();
    await page.waitForFunction(() => window.__events.includes('next'), null, { timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(600);
    const events = await page.evaluate(() => window.__events);
    const status = await page.locator('#__cap-host >> #statusText').textContent();
    return { page, events, status, errs };
  };
  // 1: a wrong answer
  const a = await run('wrong', null);
  check('wrong answer: resource, back, Next — in a real browser', a.events.join() === 'resource,back,next', `${a.events} / ${a.status}`);
  check('Submit never pressed; no error in the bar', !a.events.includes('SUBMIT') && !/rror|stuck|Could not/.test(a.status), a.status);
  const reqs1 = await sw.evaluate(() => globalThis.__reqs.length);
  const book = await sw.evaluate(async () => (await chrome.storage.local.get('answerBook')).answerBook);
  check('the right answer is remembered (read from the real page, "Correct Answer" box)', Object.values(book ?? {}).length === 1 && Object.values(book)[0].a.join() === 'allowance for doubtful accounts', JSON.stringify(book));
  await a.page.close();
  // 2: the same question, choices in another order: from memory
  const b = await run('again', [3, 1, 2, 0]);
  const reqs2 = await sw.evaluate(() => globalThis.__reqs.length);
  check('same question again, shuffled: no call to the model', reqs2 === reqs1, `${reqs1} -> ${reqs2}`);
  check('and it moves on, saying it was remembered', b.events.join() === 'next' && /remembered/.test(b.status), `${b.events} / ${b.status}`);
  check('no page errors', a.errs.length + b.errs.length === 0, [...a.errs, ...b.errs].join(' | '));
  await ctx.close(); server.close();
  console.log(bad ? `\n${bad} failed` : '\nAll real-browser Connect checks passed');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
