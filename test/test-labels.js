// Verifies tableLabel() against the real Shocker Enterprises worksheet layout.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const HTML = `<body><div role="main"><table>
  <tr><td></td><td colspan="2">Account</td></tr>
  <tr><td>1.</td><td></td><td></td></tr>
  <tr><td></td><td>Deferred Revenue</td><td>Service Revenue</td></tr>
  <tr><td>Balance before adjustment</td><td><input id="a1"></td><td><input id="a2"></td></tr>
  <tr><td>December 31 Adjustment</td><td><input id="a3"></td><td><input id="a4"></td></tr>
  <tr><td>December 31 Ending balance</td><td><input id="a5"></td><td><input id="a6"></td></tr>
  <tr><td>2.</td><td></td><td></td></tr>
  <tr><td></td><td>Prepaid Advertising</td><td>Advertising Expense</td></tr>
  <tr><td>Balance before adjustment</td><td><input id="b1"></td><td>$ 0</td></tr>
  <tr><td>December 31 Adjustment</td><td><input id="b2"></td><td><input id="b3"></td></tr>
  <tr><td>December 31 Ending balance</td><td><input id="b4"></td><td><input id="b5"></td></tr>
  <tr><td>3.</td><td></td><td></td></tr>
  <tr><td></td><td>Salaries Payable</td><td>Salaries Expense</td></tr>
  <tr><td>Balance before adjustment</td><td>$ 0</td><td><input id="c1"></td></tr>
  <tr><td>December 31 Adjustment</td><td><input id="c2"></td><td><input id="c3"></td></tr>
  <tr><td>4.</td><td></td><td></td></tr>
  <tr><td></td><td>Interest Payable</td><td>Interest Expense</td></tr>
  <tr><td>December 31 Adjustment</td><td><input id="d1"></td><td><input id="d2"></td></tr>
</table></div></body>`;

const dom = new JSDOM(HTML);
const { document } = dom.window;
global.document = document;

// Pull the real implementation out of content.js so we test shipping code
const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const slice = src.slice(src.indexOf('const CELL_SEL'), src.indexOf('function describeEl'));
eval(slice);

const expected = {
  a1: 'Deferred Revenue — Balance before adjustment',
  a2: 'Service Revenue — Balance before adjustment',
  a3: 'Deferred Revenue — December 31 Adjustment',
  a4: 'Service Revenue — December 31 Adjustment',
  a5: 'Deferred Revenue — December 31 Ending balance',
  a6: 'Service Revenue — December 31 Ending balance',
  b1: 'Prepaid Advertising — Balance before adjustment',
  b2: 'Prepaid Advertising — December 31 Adjustment',
  b3: 'Advertising Expense — December 31 Adjustment',
  b4: 'Prepaid Advertising — December 31 Ending balance',
  b5: 'Advertising Expense — December 31 Ending balance',
  c1: 'Salaries Expense — Balance before adjustment',
  c2: 'Salaries Payable — December 31 Adjustment',
  c3: 'Salaries Expense — December 31 Adjustment',
  d1: 'Interest Payable — December 31 Adjustment',
  d2: 'Interest Expense — December 31 Adjustment'
};

let pass = 0, fail = 0;
for (const [id, want] of Object.entries(expected)) {
  const got = tableLabel(document.getElementById(id));
  if (got === want) { pass++; }
  else { fail++; console.log(`FAIL ${id}\n  want: ${want}\n  got:  ${got}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);

// Worksheet detection should fire on this table
const fields = [...document.querySelectorAll('input')].filter(isTableField);
console.log(`isTableField matched ${fields.length} inputs -> worksheet: ${fields.length >= 4}`);
process.exit(fail ? 1 : 0);
