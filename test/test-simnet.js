// Reproduces the structure that hid the ribbon: the exam shell wraps the whole
// simulation in a Launch_* container, so an ancestor-based chrome filter
// excluded every control inside it.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const cells = Array.from({ length: 60 }, (_, i) =>
  `<td class="grdbdy-cell has-value" id="cell-A${i+1}" aria-label="val A${i+1}" tabindex="0"></td>`).join('');

const HTML = `<body><div role="main">
  <div class="Launch_exam-wrapper">
    <button class="Launch_submit-end-btn__ZSxEO">Submit</button>
    <div class="shell-ribbon">
      <button class="shell-btn" aria-label="AutoSum">AutoSum</button>
      <button class="shell-btn" aria-label="Trace Precedents"></button>
      <button class="shell-btn" aria-label="Insert Function">fx</button>
      <div role="tab" aria-label="Formulas">Formulas</div>
    </div>
    <table><tr>${cells}</tr></table>
  </div>
</div></body>`;

const dom = new JSDOM(HTML);
global.document = dom.window.document;
global.window = dom.window;
dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 60, height: 20, top: 5, bottom: 25, left: 5, right: 65 });

const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
// content.js is wrapped in a load guard; evaluate the body, not the wrapper
const body = src.slice(src.indexOf('window.__pageAgentLoaded = true;')
                       + 'window.__pageAgentLoaded = true;'.length);
eval(body.slice(0, body.indexOf('(function injectWidget')));

const d = scrape();
const names = d.elements.filter(e => !e.cell).map(e => e.text);
console.log('isSimnet:', d.isSimnet);
console.log('ribbon controls found:', names.length, '->', names);
console.log('chrome excluded:', !names.includes('Submit'));

const ok = d.isSimnet && names.includes('AutoSum') && names.includes('Trace Precedents')
        && names.includes('Formulas') && !names.includes('Submit');
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
