export const SHEET_LINKS = [
  ['Directory', 'https://app.chargingthefuture.com/apps/directory'],
  ['Skills Hunt', 'https://app.chargingthefuture.com/apps/skills-hunt'],
  ['Workforce', 'https://app.chargingthefuture.com/apps/workforce'],
  ['Knowledge Library', 'https://app.chargingthefuture.com/knowledge'],
  ['SkillUp', 'https://app.chargingthefuture.com/apps/skill-up'],
  ['Foundation', 'https://app.chargingthefuture.com/apps/foundation'],
];

export function unfilledSlots(text) {
  return (String(text || '').match(/\[[^\]]*\]/g) || []).length;
}

const ADDRESS = /https?:\/\/[^\s<>"']+/g;

export function linkParts(text) {
  const body = String(text || '');
  const parts = [];
  let at = 0;
  for (const match of body.matchAll(ADDRESS)) {
    let href = match[0];
    const trimmed = href.replace(/[.,;:!?)\]]+$/, '');
    const dropped = href.slice(trimmed.length);
    href = trimmed;
    if (match.index > at) parts.push({ text: body.slice(at, match.index) });
    parts.push({ text: href, href });
    if (dropped) parts.push({ text: dropped });
    at = match.index + match[0].length;
  }
  if (at < body.length) parts.push({ text: body.slice(at) });
  return parts;
}

const STEP_START = /^\s{0,3}\d{1,2}[.)]\s+(.*)$/;

export function sheetSteps(text) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim();
  const intro = [];
  const steps = [];
  let held = [];
  let blank = false;
  for (const line of body.split('\n')) {
    const start = line.match(STEP_START);
    if (start) {
      if (steps.length && held.length) steps[steps.length - 1].push('', ...held);
      held = [];
      blank = false;
      steps.push([start[1]]);
      continue;
    }
    if (!steps.length) { intro.push(line); continue; }
    if (!line.trim()) { blank = true; continue; }
    const under = /^\s/.test(line) || /^[-*•]\s/.test(line);
    if (held.length || (blank && !under)) { held.push(line); continue; }
    steps[steps.length - 1].push(...(blank ? ['', line] : [line]));
    blank = false;
  }
  if (!steps.length) return { intro: '', steps: body ? [body] : [], outro: '' };
  return {
    intro: intro.join('\n').trim(),
    steps: steps.map((lines) => lines.join('\n').trim()),
    outro: held.join('\n').trim(),
  };
}

export function firstSentence(text) {
  const body = String(text || '');
  const found = body.match(/^[\s\S]*?[.!?]["'”’)\]]*(?=\s|$)/);
  if (!found) return [body, ''];
  return [found[0], body.slice(found[0].length)];
}
