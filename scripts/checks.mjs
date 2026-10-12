import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventsAreLabelled } from './checks-events.mjs';
import { noExplainers } from './checks-explainers.mjs';
import { clientWordsAreClients } from './checks-client-words.mjs';
import { requestsSayWhatFailed } from './checks-problems.mjs';
import { importsAreRead, namesResolve } from './checks-names.mjs';
import { wordsAreAllowed } from './checks-words.mjs';
import { noSymlinks, walk } from './checks-files.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function fail(check, message) {
  problems.push(`${check}: ${message}`);
}


for (const message of noSymlinks(ROOT)) fail('symlink', message);
const files = walk(ROOT);
const read = (path) => readFileSync(path, 'utf8');

const scripts = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fail('syntax', `${file.slice(ROOT.length + 1)}\n${error.stderr}`);
  }
}

const pages = files.filter((f) => f.endsWith('.html'));
for (const file of pages) {
  const body = read(file).match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!body) continue;
  const scratch = join(tmpdir(), `check-${basename(file)}.mjs`);
  writeFileSync(scratch, body[1]);
  try {
    execFileSync(process.execPath, ['--check', scratch], { stdio: 'pipe' });
  } catch (error) {
    fail('syntax', `${file.slice(ROOT.length + 1)} inline script\n${error.stderr}`);
  } finally {
    rmSync(scratch, { force: true });
  }
}

const SIZE_LIMITS = [
  { ext: '.html', lines: 900, what: 'a page' },
  { ext: '.js', lines: 700, what: 'an endpoint or a library' },
  { ext: '.mjs', lines: 700, what: 'an endpoint or a library' },
];

const allowed = JSON.parse(read(`${ROOT}/scripts/size-allowlist.json`)).files;
const usedAllowance = new Set();

for (const file of files) {
  const limit = SIZE_LIMITS.find((l) => file.endsWith(l.ext));
  if (!limit) continue;
  const name = file.slice(ROOT.length + 1);
  const lines = read(file).split('\n').length;
  const known = allowed[name];

  if (lines <= limit.lines) {
    if (known) {
      fail('size', `${name} ${lines} lines, under the limit, still in scripts/size-allowlist.json`);
    }
    continue;
  }

  if (!known) {
    fail(
      'size',
      `${name} ${lines} lines, limit ${limit.lines}`,
    );
    continue;
  }

  usedAllowance.add(name);
  if (lines > known.lines) {
    fail(
      'size',
      `${name} ${lines} lines, allowlist ${known.lines}`,
    );
  }
}

for (const name of Object.keys(allowed)) {
  if (!usedAllowance.has(name) && !files.some((f) => f.endsWith(`/${name}`))) {
    fail('size', `scripts/size-allowlist.json: no file ${name}`);
  }
}

const RUNTIME_ONLY = new Set(['NODE_ENV', 'PORT']);

const source = scripts
  .filter((f) => !f.includes('/test/') && !f.includes('/scripts/'))
  .map(read)
  .join('\n');

const readDirectly = new Set(
  [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
);
const mentioned = new Set([
  ...readDirectly,
  ...[...source.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((m) => m[1]),
]);

const deployKeys = new Set(
  [...read(join(ROOT, '.github/scripts/deploy.sh')).matchAll(/^\s{2}([A-Z][A-Z0-9_]*)$/gm)]
    .map((m) => m[1]),
);
const renderKeys = new Set(
  [...read(join(ROOT, 'render.yaml')).matchAll(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)/gm)]
    .map((m) => m[1]),
);

for (const name of readDirectly) {
  if (RUNTIME_ONLY.has(name)) continue;
  if (!deployKeys.has(name)) fail('settings', `${name} missing from KEYS in .github/scripts/deploy.sh`);
}
for (const name of deployKeys) {
  if (!renderKeys.has(name)) fail('settings', `${name} missing from render.yaml`);
  if (!mentioned.has(name)) fail('settings', `${name} unread`);
}
for (const name of renderKeys) {
  if (!deployKeys.has(name)) fail('settings', `${name} in render.yaml, missing from KEYS in .github/scripts/deploy.sh`);
}

const importsOf = (text) => [...text.matchAll(/from '\/([\w.-]+\.js)'/g)].map((m) => m[1]);

function bundle(page, seen = new Set()) {
  const path = page.startsWith(ROOT) ? page : join(ROOT, page);
  if (seen.has(path)) return '';
  seen.add(path);
  if (!files.includes(path)) return '';
  const text = read(path);
  return [text, ...importsOf(text).map((name) => bundle(name, seen))].join('\n');
}

const callers = files
  .filter((f) => f.endsWith('.html') || f.includes('/test/') || f.includes('/workflows/'))
  .map((f) => (f.endsWith('.html') ? bundle(f) : read(f)))
  .join('\n');

const answers = new Map();
for (const file of files.filter((f) => f.includes('/api/') && f.endsWith('.js'))) {
  const text = read(file);
  const names = new Set([...text.matchAll(/action === '([a-z][a-z-]*)'/g)].map((m) => m[1]));

  const table = text.match(/const ACTIONS = \{[\s\S]*?\n\};/);
  if (table) {
    for (const m of table[0].matchAll(/(?:[{,]\s*)'?([a-z][a-z-]*)'?\s*(?=[,:}])/g)) {
      names.add(m[1]);
    }
  }
  answers.set(file.replace(/^.*\/api\//, '').replace(/\.js$/, ''), names);

  for (const name of names) {
    const called = callers.includes(`'${name}'`)
      || callers.includes(`action=${name}`)
      || new RegExp(`(?<![.\\w$])(?:get|post)\\(['"\`]${name}[^a-z-]`).test(callers);
    if (!called) {
      fail('unreachable', `${file.slice(ROOT.length + 1)} action "${name}" uncalled`);
    }
  }
}

for (const file of files.filter((f) => f.endsWith('.html'))) {
  const text = bundle(file);
  const talksTo = [...text.matchAll(/\/api\/([a-z][a-z-]*)/g)].map((m) => m[1]);
  if (!talksTo.length) continue;

  const asked = new Set([
    ...[...text.matchAll(/action=([a-z][a-z-]*)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?<![.\w$])(?:get|post)\(['"`]([a-z][a-z-]*)/g)].map((m) => m[1]),
  ]);

  for (const name of asked) {
    if (talksTo.some((ep) => answers.get(ep)?.has(name))) continue;
    fail(
      'unanswered',
      `${file.slice(ROOT.length + 1)} action "${name}" (${[...new Set(talksTo)].join(', ')})`,
    );
  }
}

{
  const desk = [`${ROOT}/api/desk.js`, ...readdirSync(`${ROOT}/lib`)
    .filter((f) => f.endsWith('.js')).map((f) => `${ROOT}/lib/${f}`)]
    .map((f) => read(f)).join('\n');

  const sent = new Set();
  for (const name of ['queue', 'person']) {
    const start = desk.indexOf(`async function ${name}(`);
    if (start < 0) continue;
    const next = desk.indexOf('\nasync function', start + 10);
    const body = desk.slice(start, next < 0 ? undefined : next);
    for (const m of body.matchAll(/\b([a-zA-Z]\w*):/g)) sent.add(m[1]);
    for (const m of body.matchAll(/^\s*([a-zA-Z]\w*),\s*$/gm)) sent.add(m[1]);
  }

  if (sent.size < 10) {
    fail('payload', 'desk payloads unreadable');
  } else {
    const pages = ['desk.html', ...readdirSync(ROOT).filter((f) => /^desk[\w-]*\.js$/.test(f))];
    for (const file of pages) {
      const page = read(`${ROOT}/${file}`);
      const seen = new Set([...page.matchAll(/\bperson\.([a-zA-Z]\w*)/g)].map((m) => m[1]));
      for (const field of seen) {
        if (!sent.has(field)) {
          fail('payload', `${file} person.${field}`);
        }
      }
    }
  }
}

{
  const getActions = new Map();
  for (const file of files.filter((f) => f.includes('/api/') && f.endsWith('.js'))) {
    const text = read(file);
    const name = file.slice(file.lastIndexOf('/') + 1, -3);
    const allowed = new Set(
      [...text.matchAll(/req\.method === 'GET' && action === '([a-z][a-z-]*)'/g)].map((m) => m[1]),
    );
    const table = text.match(/GET:\s*\{([^}]*)\}/);
    if (table) {
      for (const m of table[1].matchAll(/'?([a-z][a-zA-Z-]*)'?/g)) allowed.add(m[1]);
    }
    getActions.set(name, allowed);
  }

  const navigation = /(?:location\.(?:href\s*=|assign\(|replace\()|href=)\s*['"`]\/api\/([a-z-]+)\?([^'"`]*)['"`]/g;
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    for (const m of read(file).matchAll(navigation)) {
      const endpoint = m[1];
      const action = (m[2].match(/action=([a-zA-Z-]+)/) || [])[1];
      if (!action) continue;
      const allowed = getActions.get(endpoint);
      if (!allowed) continue;
      if (!allowed.has(action)) {
        fail('navigation', `${file.slice(ROOT.length + 1)} GET /api/${endpoint}?action=${action}`);
      }
    }
  }
}

{
  const css = read(`${ROOT}/style.css`);
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1];
    if (!/\b(input|textarea|select)\b/.test(selector)) continue;
    const size = rule[2].match(/font-size:\s*([\d.]+)(px|rem)/);
    if (!size) continue;
    const px = size[2] === 'rem' ? Number(size[1]) * 16 : Number(size[1]);
    if (px < 16) {
      fail('zoom', `style.css "${selector.trim()}" ${px}px`);
    }
  }
}

{
  const css = read(`${ROOT}/style.css`).replace(/\/\*[\s\S]*?\*\//g, '');
  const sales = css.match(/(?:^|\})\s*::placeholder\s*\{([^{}]*)\}/);
  if (!sales || !/color:\s*var\(--ink-muted\)/.test(sales[1]) || !/font-style:\s*italic/.test(sales[1])) {
    fail('placeholder', 'style.css "::placeholder" rule');
  }
  if (!/\.inside\s+::placeholder\s*\{[^{}]*color:\s*var\(--in-muted\)/.test(css)) {
    fail('placeholder', 'style.css ".inside ::placeholder" rule');
  }
}

{
  const schema = read(`${ROOT}/lib/db.js`);
  const declared = new Set();
  for (const table of schema.matchAll(/create table if not exists \w+ \(([\s\S]*?)\n\s*\)/g)) {
    for (const line of table[1].split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (/^\w+$/.test(name)) declared.add(name);
    }
  }
  for (const m of schema.matchAll(/rename column (\w+) to (\w+)/g)) {
    if (declared.has(m[2])) {
      fail('collision', `lib/db.js ${m[1]} -> ${m[2]}`);
    }
  }
}

namesResolve({ ROOT, files, read, fail });

noExplainers({ ROOT, read, fail });

clientWordsAreClients({ ROOT, files, read, fail });

requestsSayWhatFailed({ ROOT, read, fail });

const MADE_BY_THE_DEMO = new Set(['media/link-your-session.jpg']);
for (const file of files) {
  if (MADE_BY_THE_DEMO.has(file.slice(ROOT.length + 1))) continue;
  if (/\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(file)) {
    fail('picture', `${file.slice(ROOT.length + 1)}`);
  }
}

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  if (!/\.(js|html)$/.test(rel) || rel.includes('/') || rel === 'desk-ui.js' || rel === 'server.js') continue;
  if (/post\(\s*['"`](draft|quote-worth)['"`]|action=(draft|quote-worth)\b/.test(read(file))) {
    fail('paid', `${rel} without askModel`);
  }
}

{
  const modelActions = new Set([...(read(join(ROOT, 'desk-ui.js'))
    .match(/MODEL_ACTIONS = \[([^\]]*)\]/)?.[1] || '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
  const reaching = new Set();
  const bodies = [];
  for (const file of files.filter((f) => /\/(lib|api)\/[\w-]+\.js$/.test(f))) {
    const text = read(file);
    const local = text.match(/import \{[^}]*\bdraft as (\w+)[^}]*\} from '\.\/draft\.js'/)?.[1];
    if (local) reaching.add(local);
    for (const m of text.matchAll(/(?:export )?async function (\w+)\([\s\S]*?\n\}\n/g)) {
      bodies.push([m[1], m[0]]);
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of bodies) {
      if (reaching.has(name)) continue;
      if ([...reaching].some((c) => new RegExp(`\\b${c}\\(`).test(body))) { reaching.add(name); grew = true; }
    }
  }
  for (const [, action, handler] of read(join(ROOT, 'api/desk.js')).matchAll(/'?([\w-]+)'?:\s*(\w+),/g)) {
    if (reaching.has(handler) && !modelActions.has(action)) {
      fail('paid', `'${action}' missing from MODEL_ACTIONS in desk-ui.js`);
    }
  }
}

for (const file of files.filter((f) => /\.(html|js)$/.test(f) && !f.includes('/scripts/')
  && !f.includes('/test/') && !f.includes('node_modules'))) {
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:const|let) (\w+)\s*=/);
    if (!m) return;
    const [, indent, name] = m;
    const use = new RegExp(`(^|[^\\w.'"\`])${name}\\.\\w`);
    const again = new RegExp(`^\\s*(?:const|let) ${name}\\b`);
    let found = [];
    for (let j = i - 1; j >= 0; j -= 1) {
      const l = lines[j];
      if (!l.trim() || /^\s*(\/\/|\*)/.test(l)) continue;
      const depth = l.match(/^\s*/)[0].length;
      if (depth < indent.length && /[{(]\s*$/.test(l)) break;
      if (depth > indent.length && again.test(l)) { found = []; continue; }
      if (depth > indent.length && use.test(l.replace(/(['"]).*?\1/g, ''))) found.push(j + 1);
    }
    for (const at of found) {
      fail('order', `${file.slice(ROOT.length + 1)}:${at} ${name} before line ${i + 1}`);
    }
  });
}

const served = new Set(
  [...read(join(ROOT, 'server.js')).matchAll(/'(\/[\w.-]*)':\s*\[/g)].map((m) => m[1]),
);

for (const file of files.filter((f) => f.endsWith('.html') || /^[^/]*\.js$/.test(f.slice(ROOT.length + 1)))) {
  const text = read(file);
  for (const m of text.matchAll(/from\s+'(\/[\w.-]+\.js)'/g)) {
    if (served.has(m[1])) continue;
    fail(
      'unserved',
      `${file.slice(ROOT.length + 1)} ${m[1]}`,
    );
  }
}

const DRAWN_AGAIN = /^desk-(record|work|contacts|recap|gaps)\.js$/;

for (const file of files.filter((f) => DRAWN_AGAIN.test(f.slice(ROOT.length + 1)))) {
  const name = file.slice(ROOT.length + 1);
  for (const [index, line] of read(file).split('\n').entries()) {
    if (!/\.addEventListener\(/.test(line)) continue;
    fail(
      'listener on every draw',
      `${name}:${index + 1} addEventListener`,
    );
  }
}

const chain = JSON.parse(read(join(ROOT, 'package.json'))).scripts.test || '';

if (!/test\/\*\.test\.mjs/.test(chain)) {
  for (const file of files.filter((f) => f.endsWith('.test.mjs'))) {
    const name = file.slice(ROOT.length + 1);
    if (chain.includes(name)) continue;
    fail(
      'unrun test',
      `${name}`,
    );
  }
}

eventsAreLabelled({ ROOT, files, read, fail, join });
importsAreRead({ ROOT, files, read, fail });

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}
console.log(`checked ${scripts.length + pages.length} files, ${deployKeys.size} settings, `
  + 'and every endpoint action.');
