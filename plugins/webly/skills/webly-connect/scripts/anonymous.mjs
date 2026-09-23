#!/usr/bin/env node
/** Minimal local agent helper. The API never writes a credential to your machine. */
import { mkdir, readFile, open, link, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CREDENTIAL_FILE = join(homedir(), '.webly', 'anonymous-credential');
// The only server answers that mean the saved secret can never be used again.
const SPENT = new Set(['credential_consumed', 'credential_expired']);

/** Delete the saved secret only if it still holds this token, so a newer one saved by a parallel run survives. */
export async function forgetCredential(token, file = CREDENTIAL_FILE) {
  try {
    if (JSON.parse(await readFile(file, 'utf8')).token !== token) return false;
    await unlink(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function localCredential(api, file = CREDENTIAL_FILE) {
  async function read() {
    const info = await lstat(file);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Credential must be a regular file with mode 0600');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.api !== api) throw new Error('Saved credential belongs to another API origin');
    if (!/^wa_[A-Za-z0-9_-]{43}$/.test(saved.token)) throw new Error('Invalid saved credential');
    return saved.token;
  }
  try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const response = await fetch(`${api}/public/v1/anonymous/credentials`, { method: 'POST', redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Credential issuance failed');
  if (!/^wa_[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error('Server returned an invalid credential');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ api, token: result.token }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    // Atomic, no-replace publication. Racing processes all read the winning file.
    await link(temporary, file);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  return read();
}

async function main() {
  const api = new URL(process.env.WEBLY_API_URL || 'https://api.webly.ai').origin;
  const url = new URL(api);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS (HTTP is allowed only for localhost)');
  const [command, argument, payload] = process.argv.slice(2);
  if (!['init', 'deploy', 'replace', 'update', 'status', 'claim-link'].includes(command)) throw new Error('Usage: anonymous.mjs init | deploy payload.json | replace payload.json | update SITE_ID payload.json | status [SITE_ID] | claim-link');
  const token = await localCredential(api);
  if (command === 'init') { console.log('Credential saved to ~/.webly/anonymous-credential'); return; }
  const failed = async (result, fallback) => {
    if (SPENT.has(result.details?.reason) && await forgetCredential(token)) {
      throw new Error(`${result.message || fallback} The saved credential is spent and was removed; the next deploy creates a new one.`);
    }
    throw new Error(result.message || fallback);
  };
  if (command === 'claim-link') {
    // Explicit user action: this URL contains a secret. Never log it automatically.
    const response = await fetch(`${api}/public/v1/anonymous/sites/current`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    const result = await response.json();
    if (!response.ok) await failed(result, 'Could not find claimable site');
    console.log(`${result.claimPage}#token=${encodeURIComponent(token)}`);
    return;
  }
  // replace: swap this credential's live site for a new one (first 24 hours only).
  const creating = command === 'deploy' || command === 'replace';
  const file = creating ? argument : command === 'update' ? payload : null;
  if ((creating || command === 'update') && !file) throw new Error('A JSON payload file is required');
  let body = file ? await readFile(file, 'utf8') : undefined;
  if (command === 'replace') body = JSON.stringify({ ...JSON.parse(body), replace: true });
  const path = creating ? '/sites' : `/sites/${encodeURIComponent(argument || 'current')}`;
  const response = await fetch(`${api}/public/v1/anonymous${path}`, {
    method: creating ? 'POST' : command === 'update' ? 'PUT' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body,
  });
  const result = await response.json();
  if (!response.ok) await failed(result, `Request failed (${response.status})`);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
