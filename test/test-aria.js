// Same worksheet, built from ARIA divs instead of <table> — the shape Angular
// apps often produce.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const HTML = `<body><div role="grid">
  <div role="row"><div role="cell"></div><div role="columnheader">Salaries Payable</div><div role="columnheader">Salaries Expense</div></div>
  <div role="row"><div role="rowheader">Balance before adjustment</div><div role="cell">$ 0</div><div role="cell"><input id="x1"></div></div>
  <div role="row"><div role="rowheader">December 31 Adjustment</div><div role="cell"><input id="x2"></div><div role="cell"><input id="x3"></div></div>
</div></body>`;

const dom = new JSDOM(HTML);
global.document = dom.window.document;

const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
eval(src.slice(src.indexOf('const CELL_SEL'), src.indexOf('function describeEl')));

const expected = {
  x1: 'Salaries Expense — Balance before adjustment',
  x2: 'Salaries Payable — December 31 Adjustment',
  x3: 'Salaries Expense — December 31 Adjustment'
};

let fail = 0;
for (const [id, want] of Object.entries(expected)) {
  const got = tableLabel(document.getElementById(id));
  if (got !== want) { fail++; console.log(`FAIL ${id}\n  want: ${want}\n  got:  ${got}`); }
}
const fields = [...document.querySelectorAll('input')].filter(isTableField);
console.log(`ARIA grid: ${Object.keys(expected).length - fail}/${Object.keys(expected).length} labels correct, isTableField matched ${fields.length}`);
process.exit(fail ? 1 : 0);
