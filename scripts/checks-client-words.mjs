const WORDS = /\bno-?go\b|\bgo or no\b|\ba go\b|\bgo decision\b/i;

const CLIENT_PAGES = ['index.html', 'buy.html', 'claim.html'];

function templateLines(text) {
  const out = [];
  let inside = false;
  for (const [i, line] of text.split('\n').entries()) {
    if (/^const QUICK = /.test(line)) inside = true;
    if (inside) out.push([i + 1, line]);
    if (inside && /^};/.test(line)) inside = false;
  }
  return out;
}

function quoted(line) {
  return [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

export function clientWordsAreClients({ ROOT, files, read, fail }) {
  const check = (name, number, text) => {
    const hit = text.match(WORDS);
    if (hit) {
      fail('client words', `${name}:${number} "${hit[0]}"`);
    }
  };
  for (const page of CLIENT_PAGES) {
    for (const [i, line] of read(`${ROOT}/${page}`).split('\n').entries()) {
      const shown = line.replace(/<!--.*?-->/g, '').replace(/<[^>]*>/g, ' ');
      if (!/^\s*\/\//.test(shown)) for (const text of quoted(shown).concat([shown.trim()])) check(page, i + 1, text);
    }
  }
  for (const file of files) {
    const name = file.slice(ROOT.length + 1);
    const text = read(file);
    const lines = text.split('\n');
    if (/^client-[\w-]+\.js$/.test(name) || name === 'lib/sheet.js') {
      lines.forEach((line, i) => {
        if (!/^\s*\/\//.test(line)) quoted(line).forEach((q) => check(name, i + 1, q));
      });
    }
    if (name === 'desk-thread.js') templateLines(text).forEach(([n, line]) => quoted(line).forEach((q) => check(name, n, q)));
    if (name === 'lib/orders.js') {
      lines.forEach((line, i) => { if (/OPENING_LINE|^\s+'/.test(line) && i < lines.findIndex((l) => /^export const OPENING_LINE/.test(l)) + 3) quoted(line).forEach((q) => check(name, i + 1, q)); });
    }
    if (/^lib\/demo[\w-]*\.js$/.test(name)) {
      lines.forEach((line, i) => {
        const before = lines[i - 1] || '';
        const goesOn = /\bsay\(/.test(before) && !/\);\s*$/.test(before);
        if (/\bsay\(/.test(line) || goesOn) quoted(line).forEach((q) => check(name, i + 1, q));
      });
    }
  }
}
