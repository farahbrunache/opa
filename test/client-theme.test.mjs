import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
const { route } = await import('../server.js');

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label);
  else { failures += 1; console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); }
}

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

for (const page of ['buy.html', 'claim.html', 'index.html']) {
  const html = read(page);
  const head = html.slice(0, html.indexOf('</head>'));
  check(`${page} declares both themes`, head.includes('<meta name="color-scheme" content="light dark">'));
  check(`${page} reads op_theme in its head, before the stylesheets`,
    /<script>[^<]*op_theme=\(light\|dark\)[^<]*dataset\.theme[^<]*<\/script>/.test(head)
      && head.indexOf('op_theme') < head.indexOf('/client.css'));
  const bar = html.match(/<div class="topbar">([\s\S]*?)\n {2}<\/div>/);
  check(`${page} has the back link and the switch in one row`,
    Boolean(bar) && /class="back"/.test(bar[1]) && /class="ctheme"/.test(bar[1]));
  check(`${page} switch has a Light and a Dark button`,
    /data-pick="light"[^>]*aria-pressed[\s\S]*?Light<\/button>/.test(html)
      && /data-pick="dark"[^>]*aria-pressed[\s\S]*?Dark<\/button>/.test(html));
  check(`${page} loads the switch module`, html.includes('<script type="module" src="/client-theme.js"></script>'));
}

for (const page of ['desk.html', 'money.html', 'funnel.html', 'questions.html']) {
  const html = read(page);
  check(`${page} stays dark only`, !/color-scheme" content="light dark|ctheme|op_theme|client-theme/.test(html));
}

const css = read('client.css');
check('client.css has no light-only opt-out', !/only light/.test(css));
check('client.css sets the dark tokens for a saved choice and for the browser setting',
  /html\[data-theme="dark"\] > body\.client \{\s*color-scheme: dark;/.test(css)
    && /@media \(prefers-color-scheme: dark\) \{\s*html:has\(> body\.client\):not\(\[data-theme="light"\]\)/.test(css));

const module = read('client-theme.js');
check('the switch makes no requests', !/\bfetch\(|XMLHttpRequest|sendBeacon/.test(module));
check('the cookie is a year, the root path and SameSite=Lax',
  module.includes('op_theme=${theme}; Max-Age=31536000; Path=/; SameSite=Lax'));

const res = {
  statusCode: 200, headers: {}, body: '',
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  end(text) { this.body = text === undefined ? '' : String(text); },
};
await route(Object.assign(
  (await import('node:stream')).Readable.from([]),
  { method: 'GET', url: '/client-theme.js', headers: {} },
), res);
check('server.js serves /client-theme.js as a script',
  res.statusCode === 200 && /javascript/.test(res.headers['content-type'] || '') && res.body.includes('op_theme'),
  res.statusCode);

console.log('');
if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('all passed');
