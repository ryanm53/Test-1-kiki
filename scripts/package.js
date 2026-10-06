// Builds the file uploaded to the Chrome Web Store: dist/page-agent-<version>.zip,
// with manifest.json at the top of the zip, as the store requires.
//
//   npm run package
//
// Every upload needs a higher version than the last one in manifest.json —
// the store refuses the same version twice.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
// Only what the extension runs on. Its README is for people reading the code.
const LEAVE_OUT = new Set(['README.md']);

function build(outDir = path.join(ROOT, 'dist')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.') || LEAVE_OUT.has(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(EXT, full));
    }
  })(EXT);

  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `page-agent-${manifest.version}.zip`);
  fs.rmSync(out, { force: true });
  // -X: no extra file attributes, so the same code always gives the same zip
  execFileSync('zip', ['-q', '-X', out, ...files], { cwd: EXT });
  return { out, files, manifest };
}

module.exports = { build };

if (require.main === module) {
  const { out, files } = build();
  // A copy in store/, so the file to upload has a download link on GitHub
  const kept = path.join(ROOT, 'store', path.basename(out));
  for (const old of fs.readdirSync(path.join(ROOT, 'store')).filter(f => /^page-agent-.*\.zip$/.test(f))) {
    fs.rmSync(path.join(ROOT, 'store', old));
  }
  fs.copyFileSync(out, kept);
  console.log(`Built ${path.relative(ROOT, out)} (${files.length} files, ${Math.round(fs.statSync(out).size / 1024)} KB), copied to ${path.relative(ROOT, kept)}`);
}
