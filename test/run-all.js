// Runs every suite and reports one verdict. `npm test` from the repo root.
//
// These are not unit tests of pretty functions — each one pins down a bug that
// actually shipped and cost a round of "it didn't work". Adding a page layout
// that broke things is the cheapest way to stop it breaking again.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = [
  ['test-load.js',       'content.js loads and the control bar mounts'],
  ['test-resilience.js', 'survives re-injection, extension reload, body wipe'],
  ['test-drag.js',       'the control bar can be dragged and stays put'],
  ['test-labels.js',     'accounting worksheet: column/row labels'],
  ['test-aria.js',       'the same, on an ARIA grid instead of a table'],
  ['test-sheet.js',      'spreadsheet <td> cells are recognised'],
  ['test-regression.js', 'no SIMnet behaviour leaks into ordinary questions'],
  ['test-simnet.js',     'SIMnet: the ribbon survives the exam-chrome filter']
];

if (!fs.existsSync(path.join(__dirname, '..', 'node_modules', 'jsdom'))) {
  console.error('jsdom is missing — run `npm install` first.');
  process.exit(1);
}

let failed = 0;
for (const [file, what] of SUITES) {
  process.stdout.write(`${file.padEnd(20)} ${what}\n`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'pipe' });
    console.log('  ✓ pass\n');
  } catch (e) {
    failed++;
    console.log('  ✗ FAIL');
    console.log(String(e.stdout ?? '').split('\n').map(l => '    ' + l).join('\n'));
    console.log(String(e.stderr ?? '').split('\n').slice(0, 6).map(l => '    ' + l).join('\n'));
  }
}

console.log(failed ? `${failed} suite(s) failed` : 'All suites passed');
process.exit(failed ? 1 : 0);
