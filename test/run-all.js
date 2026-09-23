// Runs every suite and reports one verdict. `npm test` from the repo root.
//
// These are not unit tests of pretty functions: each check drives the real
// extension, and many pin a bug that actually shipped and cost a round of
// "it didn't work". Suites run side by side, so the whole thing takes about
// as long as the slowest one.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = [
  ['test-features.js',   'Every feature: question types, models, errors, stop, settings'],
  ['test-panel.js',      'Settings panel: mode, model, key, More, page type in the bar'],
  ['test-simnet-moves.js', 'SIMnet: double-click, right-click, type, Enter; honest when unfinished'],
  ['test-simnet-menus.js', 'SIMnet: menus that open are seen, even past a full ribbon'],
  ['test-simnet-verdict.js', "SIMnet: reads its right/wrong popup, retries with the hint, spares the last attempt"],
  ['test-simnet-real.js', 'SIMnet: every failure in a real exercise log, replayed'],
  ['test-log.js',        'Answer log: records runs and verdicts, thumbs-down, download, clear'],
  ['test-platforms.js',  'SIMnet, Connect and Canvas on the same default settings'],
  ['test-canvas.js',     'Canvas quizzes: whole page, one at a time, never submits'],
  ['test-resilience.js', 'Survives re-injection, extension reload, pages that wipe the bar'],
  ['test-drag.js',       'The control bar can be dragged and stays put'],
  ['test-load.js',       'The extension loads and the control bar appears'],
  ['test-labels.js',     'Accounting worksheet: column and row labels'],
  ['test-aria.js',       'The same, on an ARIA grid instead of a table'],
  ['test-sheet.js',      'Spreadsheet cells are recognised'],
  ['test-regression.js', 'Nothing from SIMnet leaks into ordinary questions'],
  ['test-simnet.js',     'SIMnet: the ribbon survives the exam-chrome filter']
];

if (!fs.existsSync(path.join(__dirname, '..', 'node_modules', 'jsdom'))) {
  console.error('jsdom is missing — run `npm install` first.');
  process.exit(1);
}

const started = Date.now();
const runs = SUITES.map(([file, what]) => new Promise(resolve => {
  execFile(process.execPath, [path.join(__dirname, file)], { timeout: 240000 }, (err, stdout, stderr) => {
    const lines = String(stdout).split('\n');
    resolve({
      file, what,
      ok: !err,
      checks: lines.filter(l => /^PASS /.test(l)).length,
      failures: lines.filter(l => /^FAIL /.test(l)),
      output: `${stdout}\n${stderr}`.trim()
    });
  });
}));

Promise.all(runs).then(results => {
  let total = 0;
  for (const r of results) {
    total += r.checks;
    const count = r.checks ? `  (${r.checks} checks)` : '';
    console.log(`${r.ok ? '✓' : '✗'} ${r.what}${count}`);
    if (!r.ok) {
      // Name the broken checks; fall back to the raw output for a crash
      const detail = r.failures.length ? r.failures : r.output.split('\n').slice(0, 12);
      for (const l of detail) console.log(`    ${l}`);
      console.log(`    (run it alone: node test/${r.file})`);
    }
  }

  const failed = results.filter(r => !r.ok).length;
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('');
  console.log(failed
    ? `✗ ${failed} of ${results.length} areas broken — see above.`
    : `✓ Everything works. ${results.length} areas, ${total}+ checks, ${secs}s.`);
  process.exit(failed ? 1 : 0);
});
