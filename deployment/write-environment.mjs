import { writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

// Use the runtime's own grammar so hashes, whitespace and multiline secrets survive relocation.
export async function writeEnvironment(file, values) {
 const lines = Object.entries(values).map(([key, value]) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') throw Error('Invalid environment entry');
  const candidates = ['"', "'", '`'].filter(mark => !value.includes(mark)).map(mark => `${mark}${value}${mark}`);
  candidates.push(value);
  const encoded = candidates.find(candidate => parseEnv(`${key}=${candidate}\n`)[key] === value);
  if (encoded === undefined) throw Error(`Cannot safely serialize ${key}; preserve the original configuration manually`);
  return `${key}=${encoded}`;
 });
 await writeFile(file, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 let input = ''; for await (const chunk of process.stdin) input += chunk;
 await writeEnvironment(process.argv[2], JSON.parse(input));
}
