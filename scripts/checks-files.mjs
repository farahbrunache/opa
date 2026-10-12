import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function noSymlinks(root) {
  let staged;
  try {
    staged = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8' });
  } catch {
    return [];
  }
  return staged.split('\n')
    .filter((line) => line.startsWith('120000 '))
    .map((line) => `${line.split('\t')[1]} is committed as a symlink. Remove it from the index and ignore it.`);
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
