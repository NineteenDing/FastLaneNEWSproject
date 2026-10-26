import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

test('server environment file preserves existing credentials when restored', async () => {
 const directory = await mkdtemp(path.join(tmpdir(), 'fastlane-env-'));
 try {
  const target = path.join(directory, '.env');
  const values = { ADMIN_USERNAME: ' editor ', ADMIN_PASSWORD: ' before#after "quote" ', SESSION_SECRET: "line one\nline two'with apostrophe", IMG_PROXY_SIGN_SECRET: 'C:\\private\\value' };
  execFileSync(process.execPath, ['deployment/write-environment.mjs', target], { input: JSON.stringify(values), stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual({ ...parseEnv(await readFile(target, 'utf8')) }, values);
  assert.throws(() => execFileSync(process.execPath, ['deployment/write-environment.mjs', target], { input: JSON.stringify(values), stdio: ['pipe', 'pipe', 'pipe'] }));
 } finally { await rm(directory, { recursive: true, force: true }); }
});
