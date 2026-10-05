// The toolbar button's popup: one switch, to show or hide the control bar on
// every page. The bar on each open page follows the setting as it changes.
const sw = document.getElementById('showBar');
const hint = document.getElementById('shortcutHint');

function show(visible) {
  sw.setAttribute('aria-checked', String(visible));
}

chrome.storage.local.get('barHidden', ({ barHidden }) => show(barHidden !== true));

sw.addEventListener('click', () => {
  const visible = sw.getAttribute('aria-checked') !== 'true';
  show(visible);
  chrome.storage.local.set({ barHidden: !visible });
});

// The shortcut the user actually has. Chrome leaves the suggested one
// unassigned when another extension already uses it.
chrome.commands.getAll(commands => {
  const key = commands.find(c => c.name === 'toggle-bar')?.shortcut;
  hint.replaceChildren();
  const b = t => { const e = document.createElement('b'); e.textContent = t; return e; };
  if (key) {
    hint.append('Or press ', b(key), ' on any page to hide or show it. ');
  } else {
    hint.append('Hide it with the ', b('–'), ' on the bar. ');
  }
  const a = document.createElement('a');
  a.textContent = key ? 'Change shortcut' : 'Set a shortcut';
  a.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  hint.append(a);
});
