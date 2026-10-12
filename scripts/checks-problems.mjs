const CLIENT_PAGES = ['buy.html', 'claim.html', 'index.html', 'client-area.js', 'client-talk.js',
  'client-ui.js', 'client-before.js', 'client-sessions.js', 'claim-call.js'];

export function requestsSayWhatFailed({ ROOT, read, fail }) {
  for (const page of CLIENT_PAGES) {
    const lines = read(`${ROOT}/${page}`).split('\n');
    lines.forEach((line, i) => {
      if (/\bfetch\(/.test(line) && !/\/\/ quiet: \S/.test(line)) {
        fail('problem', `${page}:${i + 1} calls fetch directly. Use call() from /problem.js, or mark it "// quiet: <why>" if staying silent is the point.`);
      }
      if (/\.json\(\)\.catch\(/.test(line)) {
        fail('problem', `${page}:${i + 1} drops a response it can't read. call() in /problem.js says what came back instead.`);
      }
    });
  }
}
