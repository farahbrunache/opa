import { PGlite } from '@electric-sql/pglite';

process.env.CARD_ENCRYPTION_KEY ||= 'test-key-that-is-long-enough-to-pass-0123456789';

let failures = 0;

export function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label);
  else {
    failures += 1;
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
  }
}

export function failureCount() {
  return failures;
}

export const pg = await PGlite.create();

export function tagged(strings, ...values) {
  let text = '';
  strings.forEach((part, i) => {
    text += part;
    if (i < values.length) text += `$${i + 1}`;
  });
  return pg.query(text, values).then((result) => result.rows);
}

export const db = await import('../lib/db.js');
db.useDatabase(tagged);

export async function seedPrompts() {
  const { PROMPTS } = await import('../lib/prompts.js');
  const { writeChoice } = await import('../lib/settings.js');
  const { encrypt } = await import('../lib/crypto.js');
  for (const name of PROMPTS) await writeChoice(`prompt:${name}`, encrypt(`Invented ${name} text.`));
}
