// Does the SIMnet work leak into a Connect page?
const { JSDOM } = require('jsdom');
const fs = require('fs');

// A Connect-ish page: no grdbdy-cell, but classes that contain "active"/"selected"
const HTML = `<body><div role="main">
  <button class="nav-tab active">Chapter 3</button>
  <div class="choice-item-wrapper is-selected" role="button" id="choices:choice-1">An answer</div>
  <input type="radio" id="r1" aria-label="Liabilities">
  <button class="btn btn-secondary btn-confidence" aria-label="High Confidence">High</button>
  <button class="btn btn-primary next-button">Next Question</button>
  <table>
    <tr><td class="td-readOnly"></td><td class="td-readOnly">Deferred Revenue</td></tr>
    <tr><td class="td-readOnly">December 31 Adjustment</td><td class="responseCell" tabindex="11" id="0_table0_cell_c1_r3"></td></tr>
  </table>
</div></body>`;

const dom = new JSDOM(HTML);
global.document = dom.window.document;
global.window = dom.window;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 };
};

const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
// content.js is wrapped in a load guard; evaluate the body, not the wrapper
const body = src.slice(src.indexOf('window.__pageAgentLoaded = true;')
                       + 'window.__pageAgentLoaded = true;'.length);
eval(body.slice(0, body.indexOf('(function injectWidget')));

const data = scrape();
console.log('isSimnet :', data.isSimnet ?? false, '  <- must be false');
console.log('isWorksheet:', data.isWorksheet);
console.log('elements  :', data.elements.length);

const withCell = data.elements.filter(e => e.cell);
const withSel  = data.elements.filter(e => e.selected);
console.log('\nspurious cell= fields:', withCell.length, withCell.map(e => e.cell));
console.log('spurious (selected) flags:', withSel.length);
withSel.forEach(e => console.log('   ->', JSON.stringify(e.text.slice(0,40))));

const bad = (data.isSimnet ? 1 : 0) + withCell.length + withSel.length;
console.log(bad === 0 ? '\nPASS — no SIMnet behaviour leaked' : '\nFAIL — leakage above');
process.exit(bad === 0 ? 0 : 1);
