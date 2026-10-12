export function eventsAreLabelled({ ROOT, files, read, fail, join }) {
  const deskVocabulary = read(join(ROOT, 'lib/desk.js'));
  const labelled = new Set(
    [...deskVocabulary
      .slice(deskVocabulary.indexOf('EVENT_KINDS = {'))
      .split('};')[0]
      .matchAll(/^\s*'?([\w.-]+)'?\s*:/gm)].map((m) => m[1]),
  );

  for (const file of files.filter((f) => /\/(api|lib)\/[\w.-]+\.js$/.test(f))) {
    const text = read(file);
    const name = file.slice(ROOT.length + 1);
    const written = new Set(
      [...text.matchAll(/\brecord\s*\([^,)]*,\s*'([\w.-]+)'/g)].map((m) => m[1]),
    );
    for (const m of text.matchAll(/insert into case_events[\s\S]{0,400}?`/g)) {
      for (const k of m[0].matchAll(/'([a-z][\w-]*\.[\w.-]+)'/g)) written.add(k[1]);
    }
    for (const kind of written) {
      if (labelled.has(kind)) continue;
      fail(
        'unlabelled event',
        `${name} writes the event kind '${kind}' and EVENT_KINDS has no label for it, so the trail `
          + 'shows the raw key. Add it.',
      );
    }
  }

  const grouped = new Set(
    [...deskVocabulary
      .slice(deskVocabulary.indexOf('EVENT_GROUPS = {'))
      .split('};')[0]
      .matchAll(/^\s*'?([\w.-]+)'?\s*:/gm)].map((m) => m[1]),
  );
  for (const kind of labelled) {
    if (grouped.has(kind)) continue;
    fail('ungrouped event', `lib/desk.js labels the event kind '${kind}' and EVENT_GROUPS has no line `
      + 'for it, so the activity log can\'t say which filter it sits under or who did it. Add it.');
  }
}
