const BANNED = [
  { word: /flywheel/i },
  { word: /punch list/i },
  { word: /stale/i },
  { word: /whole/i },
  { word: /console/i, allow: /console\s*\.\s*\w|['"`]console['"`]/ },
]

const DICTIONARY = ['scripts/checks-words.mjs'];

export function wordsAreAllowed({ ROOT, files, read, fail }) {
  const looked = files.filter(
    (f) => /\.(js|mjs|html|css)$/.test(f) && !DICTIONARY.includes(f.slice(ROOT.length + 1)),
  );

  for (const file of looked) {
    const name = file.slice(ROOT.length + 1);
    const lines = read(file).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const banned of BANNED) {
        const hit = line.match(banned.word);
        if (!hit) continue;
        if (banned.allow && banned.allow.test(line)) continue;
        fail('banned word', `${name}:${index + 1} "${hit[0]}"`);
      }
    }
  }
}
