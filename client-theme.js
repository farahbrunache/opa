const root = document.documentElement;
const browserDark = window.matchMedia('(prefers-color-scheme: dark)');

function shown() {
  return root.dataset.theme || (browserDark.matches ? 'dark' : 'light');
}

function mark() {
  const now = shown();
  for (const button of document.querySelectorAll('.ctheme [data-pick]')) {
    button.setAttribute('aria-pressed', String(button.dataset.pick === now));
  }
}

function save(theme) {
  const host = location.hostname;
  const shared = host === 'farahbrunache.com' || host.endsWith('.farahbrunache.com')
    ? '; Domain=farahbrunache.com'
    : '';
  try {
    document.cookie = `op_theme=${theme}; Max-Age=31536000; Path=/; SameSite=Lax${shared}`;
  } catch {
  }
}

for (const button of document.querySelectorAll('.ctheme [data-pick]')) {
  button.addEventListener('click', () => {
    root.dataset.theme = button.dataset.pick;
    save(button.dataset.pick);
    mark();
  });
}
browserDark.addEventListener('change', mark);
mark();
