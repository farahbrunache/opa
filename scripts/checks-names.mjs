const GLOBALS = new Set([
  'require', 'fetch', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'atob', 'btoa', 'encodeURIComponent',
  'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'String', 'Number',
  'Boolean', 'Array', 'Object', 'Error', 'TypeError', 'RangeError', 'Promise', 'Map', 'Set',
  'Date', 'RegExp', 'JSON', 'Math', 'URL', 'WeakMap', 'AbortController', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'MutationObserver',
  'Buffer', 'process', 'console', 'if', 'for', 'while', 'switch', 'catch', 'return',
  'typeof', 'await', 'function', 'super', 'this', 'async', 'constructor', 'else', 'do',
  'new', 'delete', 'void', 'in', 'of', 'yield', 'throw', 'case',
  'import',
]);

function scrub(source) {
  let out = '';
  let i = 0;
  const depth = [];
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += `${quote}${quote}`;
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          let open = 1;
          i += 2;
          const from = i;
          while (i < source.length && open > 0) {
            if (source[i] === '{') open += 1;
            else if (source[i] === '}') open -= 1;
            if (open > 0) i += 1;
          }
          out += ` ${scrub(source.slice(from, i))} `;
          i += 1;
          continue;
        }
        i += 1;
      }
      i += 1;
      out += '``';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function namesResolve({ ROOT, files, read, fail }) {
  const callSites = [
    ...files
      .filter((f) => /\/(api|lib)\//.test(f) && f.endsWith('.js'))
      .map((f) => ({ where: f.slice(ROOT.length + 1), text: read(f) })),
    ...files
      .filter((f) => /^[^/]+\.js$/.test(f.slice(ROOT.length + 1)) && !f.endsWith('server.js'))
      .map((f) => ({ where: f.slice(ROOT.length + 1), text: read(f) })),
    ...files
      .filter((f) => f.endsWith('.html'))
      .map((f) => {
        const page = read(f);
        const inline = (page.match(/<script type="module">([\s\S]*?)<\/script>/) || [])[1];
        return inline ? { where: `${f.slice(ROOT.length + 1)} (its inline script)`, text: inline, page } : null;
      })
      .filter(Boolean),
  ];

  for (const { where, text, page } of callSites) {

    const declared = new Set(GLOBALS);
    for (const m of text.matchAll(/import\s+(?:(\w+)\s*,\s*)?\{([^}]*)\}\s+from/g)) {
      if (m[1]) declared.add(m[1]);
      for (const part of m[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) declared.add(name);
      }
    }
    for (const m of text.matchAll(/import\s+(\w+)\s+from/g)) declared.add(m[1]);
    for (const m of text.matchAll(/(?:^|\s)(?:async\s+)?function\s+(\w+)/g)) declared.add(m[1]);
    for (const m of text.matchAll(/(?:^|\s)class\s+(\w+)/g)) declared.add(m[1]);
    for (const m of text.matchAll(/(?:let|var)\s+(\w+)\s*;/g)) declared.add(m[1]);
    for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) declared.add(m[1]);
    for (const m of text.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\w+)\s+(?:of|in)\s/g)) {
      declared.add(m[1]);
    }
    for (const m of text.matchAll(/(?:^|[^\w$.])\(?(\w+)\)?\s*=>/g)) declared.add(m[1]);
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().trim();
        if (name) declared.add(name);
      }
    }
    for (const m of text.matchAll(/\(([^)]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/[={].*$/, '').trim();
        if (/^\w+$/.test(name)) declared.add(name);
      }
    }
    for (const m of text.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/[={].*$/, '').trim();
        if (/^\w+$/.test(name)) declared.add(name);
      }
    }

    const withoutStrings = scrub(text);

    for (const m of withoutStrings.matchAll(/(^|[^.\w$])([a-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (!declared.has(name)) {
        fail('missing', `${where} calls ${name}() and nothing here declares it.`
          + (page && page.includes(`id="${name}"`)
            ? ` The page has an element with id="${name}", so the call resolves to that element`
              + ' and throws when the screen runs rather than when the page loads.'
            : ''));
      }
    }

    for (const m of withoutStrings.matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)) {
      if (!declared.has(m[1])) {
        fail('missing', `${where} constructs ${m[1]} and nothing here declares or imports it.`);
      }
    }

    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\/([\w.-]+\.js)'/g)) {
      const source = files.find((f) => f.slice(ROOT.length + 1) === m[2]);
      if (!source) continue;
      const exported = new Set([
        ...[...read(source).matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/g)]
          .map((e) => e[1]),
        ...[...read(source).matchAll(/export\s*\{([^}]*)\}/g)]
          .flatMap((e) => e[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop().trim())),
      ]);
      for (const part of m[1].split(',')) {
        const wanted = part.trim().split(/\s+as\s+/)[0].trim();
        if (!wanted || wanted === 'type' || exported.has(wanted)) continue;
        fail('missing', `${where} imports ${wanted} from ${m[2]} and that file does not export it. `
          + 'The browser rejects the entire module, so the page renders nothing.');
      }
    }

    const reachable = new Map();
    for (const m of text.matchAll(/from\s+'\/([\w.-]+\.js)'/g)) {
      const source = files.find((f) => f.slice(ROOT.length + 1) === m[1]);
      if (!source) continue;
      for (const e of read(source).matchAll(/export\s+(?:async\s+)?(?:const|let|var|function)\s+(\w+)/g)) {
        if (!declared.has(e[1])) reachable.set(e[1], m[1]);
      }
    }
    if (reachable.size) {
      const seenHere = new Set();
      const readable = withoutStrings;
      for (const m of readable.matchAll(/(^|[^.\w$'"])([a-z_$][\w$]*)(?![\w$(:])/g)) {
        const name = m[2];
        if (!reachable.has(name) || seenHere.has(name)) continue;
        seenHere.add(name);
        fail('missing', `${where} reads ${name} and does not import it, though `
          + `${reachable.get(name)} exports it. Add it to the import line.`);
      }
    }
  }
}

export function importsAreRead({ ROOT, files, read, fail }) {
  const looked = files.filter((f) => /\/(api|lib)\/[\w.-]+\.js$/.test(f)
    || /^[^/]+\.js$/.test(f.slice(ROOT.length + 1)));

  for (const file of looked) {
    const text = read(file);
    const name = file.slice(ROOT.length + 1);
    const body = scrub(text.replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, ''));

    const imported = [];
    for (const m of text.matchAll(/^import\s+(?:\{([\s\S]*?)\}|(\w+))\s+from/gm)) {
      if (m[1]) {
        for (const part of m[1].split(',')) {
          const local = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (local) imported.push(local);
        }
      } else if (m[2]) {
        imported.push(m[2]);
      }
    }

    for (const wanted of imported) {
      const safe = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reads = new RegExp(`(?<![\\w$.])${safe}(?![\\w$])`);
      const spread = new RegExp(`\\.\\.\\.${safe}(?![\\w$])`);
      if (reads.test(body) || spread.test(body)) continue;
      fail('unread import', `${name} imports ${wanted} and nothing in the file reads it. `
        + 'Remove it, or the file claims to do work it handed to somewhere else.');
    }
  }
}
