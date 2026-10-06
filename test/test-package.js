// The file uploaded to the Chrome Web Store: built from the extension folder,
// manifest.json at its top, every file the manifest names inside it, nothing
// else — and a listing the store will accept.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('../scripts/package');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pkg-'));
const { out, manifest } = build(tmp);
const listed = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');

check('the zip is built and named by version', fs.existsSync(out) && out.endsWith(`page-agent-${manifest.version}.zip`), out);
check('manifest.json is at the top of the zip', listed.includes('manifest.json'), listed.join(', '));

// Everything the manifest points at has to be in the zip, or the store's
// upload — or Chrome, on install — refuses it
const named = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap(c => c.js ?? [])
].filter(Boolean);
const missing = named.filter(f => !listed.includes(f));
check('every file the manifest names is inside', missing.length === 0, missing.join(', '));
const popup = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8');
const scripts = [...popup.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
check('and every script the popup loads', scripts.every(s => listed.includes(s)), scripts.join(', '));
check('popup.html has no inline script (Chrome blocks those)', !/<script(?![^>]*\bsrc=)[^>]*>/.test(popup));
check('no tests, notes or dependencies are shipped',
  !listed.some(f => /(^|\/)(test|node_modules|README\.md)|\.map$/.test(f)), listed.join(', '));

check('version is one the store accepts (1-4 dot-separated numbers)', /^\d+(\.\d+){0,3}$/.test(manifest.version), manifest.version);
check('the name stays clear of Anthropic\'s brand', !/claude|anthropic/i.test(manifest.name), manifest.name);
check('the name fits (75 characters at most)', manifest.name.length <= 75);
// Unlisted, nobody searches for these names, and a site's owner reporting
// its trademark is the likeliest way a listing gets taken down
check('the summary names no coursework site', !/mcgraw|connect|simnet|canvas/i.test(manifest.description), manifest.description);
check('the description fits (132 characters at most)', manifest.description.length <= 132, String(manifest.description.length));
check('the 128px store icon is a PNG', listed.includes(manifest.icons?.['128'])
  && fs.readFileSync(path.join(__dirname, '..', 'extension', manifest.icons['128'])).slice(1, 4).toString() === 'PNG');

// The copy kept in store/ for downloading must be the extension as it is now:
// an upload of a stale one would ship old code
const kept = path.join(__dirname, '..', 'store', `page-agent-${manifest.version}.zip`);
check('store/ has the zip to upload, named for this version', fs.existsSync(kept), kept);
if (fs.existsSync(kept)) {
  const keptFiles = execFileSync('unzip', ['-Z1', kept], { encoding: 'utf8' }).trim().split('\n');
  const stale = keptFiles.filter(f => {
    const now = path.join(__dirname, '..', 'extension', f);
    return !fs.existsSync(now) || !execFileSync('unzip', ['-p', kept, f]).equals(fs.readFileSync(now));
  });
  check('and it matches the extension exactly (run npm run package if not)',
    stale.length === 0 && keptFiles.length === listed.length, stale.join(', ') || `${keptFiles.length} vs ${listed.length} files`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nAll package checks passed');
process.exit(failed ? 1 : 0);
