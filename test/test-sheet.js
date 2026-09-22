// The worksheet as jQuery.sheet builds it: editable cells are <td tabindex>,
// not inputs. Read-only cells carry td-readOnly.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ro = t => `<td class="td-readOnly">${t}</td>`;
const cell = id => `<td class="response responseCell" tabindex="11" id="${id}"></td>`;

const HTML = `<body><table>
  <tr>${ro('')}${ro('Account')}${ro('')}</tr>
  <tr>${ro('1.')}${ro('')}${ro('')}</tr>
  <tr>${ro('')}${ro('Deferred Revenue')}${ro('Service Revenue')}</tr>
  <tr>${ro('Balance before adjustment')}${cell('c1r3')}${cell('c2r3')}</tr>
  <tr>${ro('December 31 Adjustment')}${cell('c1r4')}${cell('c2r4')}</tr>
  <tr>${ro('4.')}${ro('')}${ro('')}</tr>
  <tr>${ro('')}${ro('Interest Payable')}${ro('Interest Expense')}</tr>
  <tr>${ro('Balance before adjustment')}${ro('$ 0')}${ro('$ 0')}</tr>
  <tr>${ro('December 31 Adjustment')}${cell('c1r8')}${cell('c2r8')}</tr>
</table></body>`;

global.document = new JSDOM(HTML).window.document;
const src = fs.readFileSync(require('path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
eval(src.slice(src.indexOf('const CELL_SEL'), src.indexOf('function describeEl')));

const expected = {
  c1r3: 'Deferred Revenue — Balance before adjustment',
  c2r3: 'Service Revenue — Balance before adjustment',
  c1r4: 'Deferred Revenue — December 31 Adjustment',
  c2r4: 'Service Revenue — December 31 Adjustment',
  c1r8: 'Interest Payable — December 31 Adjustment',
  c2r8: 'Interest Expense — December 31 Adjustment'
};

let fail = 0;
for (const [id, want] of Object.entries(expected)) {
  const got = tableLabel(document.getElementById(id));
  if (got !== want) { fail++; console.log(`FAIL ${id}\n  want: ${want}\n  got:  ${got}`); }
}
console.log(`\n${Object.keys(expected).length - fail} passed, ${fail} failed`);
console.log('cells detected:', [...document.querySelectorAll('td')].filter(isSheetCell).length);
