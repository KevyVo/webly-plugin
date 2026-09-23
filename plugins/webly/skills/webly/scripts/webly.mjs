#!/usr/bin/env node
/** Webly agent helper: anonymous deploys, local state for new sessions, and MCP setup. Zero dependencies. */
import { mkdir, readFile, writeFile, readdir, open, link, unlink, lstat, stat, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Skill release. scripts/sync-plugin.sh stamps this into the plugin manifests; bump it to ship. */
export const VERSION = '0.3.0';
// The published plugin manifest is what `npx skills`, install.sh and /plugin install all read from.
const LATEST_URL = process.env.WEBLY_VERSION_URL ?? 'https://raw.githubusercontent.com/KevyVo/webly-plugin/main/plugins/webly/.claude-plugin/plugin.json';
const CREDENTIAL_FILE =process.env.WEBLY_CREDENTIAL_FILE || join(homedir(), '.webly', 'anonymous-credential');
const PENDING_FILE = join(dirname(CREDENTIAL_FILE), 'pending');
const PLUGIN_MARKETPLACE = 'KevyVo/webly-plugin';
// The only server answers that mean the saved secret can never be used again.
const SPENT = new Set(['credential_consumed', 'credential_expired']);
// Mirrors the server's anonymous limits so a too-big folder fails before any request.
const MAX_FILES = 25, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const TOKEN = /^wa_[A-Za-z0-9_-]{43}$/;

const USAGE = `Usage: webly.mjs <command>
  doctor [--brief]            Saved site, MCP setup and pending step on this machine (never creates anything)
  deploy <dir|file|payload.json>   Publish anonymously: creates the site, or updates it if this machine has one
  replace <dir|file|payload.json>  Swap the site for a new one with a new URL (first 24 hours only)
  status                      The saved site's status, URLs, deadlines and next step
  claim-link [--open]         Open (or print) the page that claims the site into an account
  connect claude|codex        Register the Webly MCP server for this agent host, at user scope
  pending set <intent> | clear   Remember a step to finish after a restart (e.g. claim)
  forget                      Delete the saved token (after the site was claimed over MCP)
  init                        Create the token without deploying

Env: WEBLY_API_URL (default https://api.webly.ai), WEBLY_CREDENTIAL_FILE (default ~/.webly/anonymous-credential)`;

/** Delete the saved secret only if it still holds this token, so a newer one saved by a parallel run survives. */
export async function forgetCredential(token, file = CREDENTIAL_FILE) {
  try {
    if (JSON.parse(await readFile(file, 'utf8')).token !== token) return false;
    await unlink(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The saved token, or null when there is none. Throws if the file is unsafe or for another API. */
export async function savedCredential(api, file = CREDENTIAL_FILE) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Credential must be a regular file with mode 0600');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.api !== api) throw new Error('Saved credential belongs to another API origin');
  if (!TOKEN.test(saved.token)) throw new Error('Invalid saved credential');
  return saved.token;
}

export async function localCredential(api, file = CREDENTIAL_FILE) {
  const existing = await savedCredential(api, file);
  if (existing) return existing;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const response = await fetch(`${api}/public/v1/anonymous/credentials`, { method: 'POST', redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Credential issuance failed');
  if (!TOKEN.test(result.token)) throw new Error('Server returned an invalid credential');
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
  return savedCredential(api, file);
}

/** A folder, a single file, or a ready-made payload.json becomes an anonymous site body. */
export async function payloadFrom(target) {
  const info = await stat(target);
  if (info.isFile() && extname(target) === '.json') return JSON.parse(await readFile(target, 'utf8'));
  const found = [];
  if (info.isFile()) {
    found.push({ path: extname(target) === '.html' ? '/index.html' : `/${basename(target)}`, abs: target });
  } else {
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile()) found.push({ path: '/' + relative(target, abs).split(sep).join('/'), abs });
      }
    };
    await walk(target);
  }
  if (!found.length) throw new Error(`No files to publish in ${target}`);
  if (found.length > MAX_FILES) throw new Error(`${found.length} files found; anonymous sites take at most ${MAX_FILES}. Publish a built output folder, or sign in for larger sites.`);
  let total = 0;
  const files = [];
  for (const { path, abs } of found.sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(abs);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB, the anonymous per-file limit`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('The files add up to more than 5 MiB, the anonymous per-site limit');
    const text = !bytes.includes(0) && isUtf8(bytes);
    files.push(text ? { path, content: bytes.toString('utf8') } : { path, content: bytes.toString('base64'), encoding: 'base64' });
  }
  const name = info.isFile() ? basename(target, extname(target)) : basename(target === '.' ? process.cwd() : target);
  return { name: name.slice(0, 200) || 'Website', kind: 'static', files };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Where this machine's agent hosts have the Webly MCP server registered. Reads config files only. */
export async function mcpSetup(home = homedir()) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const claudeJson = await readJson(process.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(home, '.claude.json'));
  const settings = await readJson(join(claudeDir, 'settings.json'));
  const plugin = Object.entries(settings?.enabledPlugins ?? {}).some(([id, on]) => on && id.startsWith('webly@'));
  const userServer = Boolean(claudeJson?.mcpServers?.webly);
  const projectServer = Boolean(claudeJson?.projects?.[process.cwd()]?.mcpServers?.webly);
  const codexToml = await readFile(join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8').catch(() => '');
  return {
    claudeCode: { configured: plugin || userServer || projectServer, via: plugin ? 'plugin' : userServer ? 'user' : projectServer ? 'project' : null },
    codex: { configured: /^\s*\[mcp_servers\.webly\]/m.test(codexToml) },
  };
}

const newer = (a, b) => {
  const [x, y] = [a, b].map(v => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** A newer published skill, with the command that updates this install, or null. Never fails. */
export async function skillUpdate() {
  if (!LATEST_URL) return null;
  try {
    const latest = (await (await fetch(LATEST_URL, { signal: AbortSignal.timeout(3000) })).json()).version;
    if (!newer(latest, VERSION)) return null;
    const plugin = realpathSync(fileURLToPath(import.meta.url)).includes(`${sep}plugins${sep}`);
    return { installed: VERSION, latest, command: plugin
      ? 'claude plugin update webly@webly (then restart Claude Code or run /reload-plugins)'
      : 'npx skills update webly -g   (no npm: curl -fsSL https://webly.ai/install.sh | bash)' };
  } catch { return null; }
}

async function api(base, path, token, init = {}) {
  const response = await fetch(`${base}/public/v1/anonymous${path}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
}

/** Status calls are what publish a finished build, so poll until it is live or has failed. */
async function settle(base, token, result) {
  for (let i = 0; i < 90 && result.status === 'building'; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const next = await api(base, '/sites/current', token);
    if (!next.ok) return result;
    result = next.body;
  }
  return result;
}

function openInBrowser(url) {
  const [cmd, ...args] = process.env.WEBLY_OPEN_CMD ? [process.env.WEBLY_OPEN_CMD]
    : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
  const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing: result.error?.code === 'ENOENT' };
}

async function main() {
  const base = new URL(process.env.WEBLY_API_URL || 'https://api.webly.ai').origin;
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS (HTTP is allowed only for localhost)');
  const [command, argument, extra] = process.argv.slice(2);
  const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const readPending = async () => (await readFile(PENDING_FILE, 'utf8').catch(() => '')).trim() || null;

  if (command === 'pending') {
    if (argument === 'set' && extra) { await mkdir(dirname(PENDING_FILE), { recursive: true, mode: 0o700 }); await writeFile(PENDING_FILE, extra + '\n'); return print(`Pending: ${extra}`); }
    if (argument === 'clear') { await unlink(PENDING_FILE).catch(() => {}); return print('Pending cleared'); }
    throw new Error('Usage: webly.mjs pending set <intent> | clear');
  }

  if (command === 'doctor') {
    const report = { version: VERSION, update: await skillUpdate(), api: base, credentialFile: CREDENTIAL_FILE, credential: 'none', site: null, siteError: null, mcp: await mcpSetup(), pending: await readPending() };
    let token = null;
    try { token = await savedCredential(base); } catch (error) { report.credential = `unusable: ${error.message}`; }
    if (token) {
      report.credential = 'present';
      const current = await api(base, '/sites/current', token).catch(error => ({ ok: false, status: 0, body: { message: `Webly unreachable: ${error.message}` } }));
      if (current.ok) report.site = current.body;
      else {
        report.siteError = { status: current.status, reason: current.body.details?.reason ?? null, message: current.body.message ?? null };
        if (SPENT.has(report.siteError.reason) && await forgetCredential(token)) report.credential = 'none (spent token removed)';
      }
    }
    // A claim can't be pending without a token to claim with.
    if (report.pending === 'claim' && !report.credential.startsWith('present')) { await unlink(PENDING_FILE).catch(() => {}); report.pending = null; }
    if (argument !== '--brief') return print(report);
    const parts = [];
    if (report.site) {
      const s = report.site;
      parts.push(`anonymous site "${s.name}" is ${s.status}${s.urls.published ? ` at ${s.urls.published}` : ''}. ${s.next?.message ?? ''}`.trim());
    } else if (report.credential === 'present') parts.push(report.siteError?.status === 404 ? 'a token is saved but no site was deployed yet.' : 'an anonymous site is saved on this machine (status unavailable right now).');
    if (report.pending) parts.push(`Unfinished step from an earlier session: ${report.pending}.`);
    if (parts.length) print(`Webly: ${parts.join(' ')} Use the webly skill to continue.`);
    if (report.update) print(`Webly skill ${report.update.latest} is available (installed ${VERSION}). Update: ${report.update.command}`);
    return;
  }

  if (command === 'connect') {
    const mcpUrl = `${base}/v1/mcp`;
    const setup = await mcpSetup();
    const hasToken = Boolean(await savedCredential(base).catch(() => null));
    if (hasToken) { await mkdir(dirname(PENDING_FILE), { recursive: true, mode: 0o700 }); await writeFile(PENDING_FILE, 'claim\n'); }
    if (argument === 'claude') {
      if (!setup.claudeCode.configured || setup.claudeCode.via === 'project') {
        const official = base === 'https://api.webly.ai';
        // The plugin reloads mid-session; a plain server entry needs a new session.
        let via = null, log = [];
        if (official) {
          const market = run('claude', ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE]);
          if (market.missing) throw new Error('The claude CLI is not on PATH. Run: claude mcp add --scope user --transport http webly ' + mcpUrl);
          const install = run('claude', ['plugin', 'install', 'webly@webly', '--scope', 'user', '-y']);
          log.push(market.output, install.output);
          if (install.ok) {
            via = 'plugin';
            // The plugin ships this skill; a standalone copy (install.sh / npx skills) would load it twice.
            await rm(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'webly'), { recursive: true, force: true });
          }
        }
        if (!via) {
          const add = run('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'webly', mcpUrl]);
          log.push(add.output);
          if (!add.ok && !/already exists/i.test(add.output)) throw new Error(`Could not register the MCP server:\n${log.filter(Boolean).join('\n')}`);
          via = 'user';
        }
        return print({ connected: 'claude-code', via, mcpUrl, pending: hasToken ? 'claim' : null,
          next: via === 'plugin'
            ? 'Ask the person to type /reload-plugins. If Webly tools still do not appear, they exit and run `claude --continue` (keeps this conversation).'
            : 'Ask the person to exit and run `claude --continue` (keeps this conversation); new MCP servers load when a session starts.' });
      }
      return print({ connected: 'claude-code', via: setup.claudeCode.via, mcpUrl, pending: hasToken ? 'claim' : null, next: 'Already configured. If Webly tools are not loaded, ask the person to type /reload-plugins or run `claude --continue`.' });
    }
    if (argument === 'codex') {
      if (!setup.codex.configured) {
        const add = run('codex', ['mcp', 'add', 'webly', '--url', mcpUrl]);
        if (add.missing) throw new Error('The codex CLI is not on PATH. Add to ~/.codex/config.toml:\n[mcp_servers.webly]\nurl = "' + mcpUrl + '"');
        if (!add.ok) throw new Error(`codex mcp add failed:\n${add.output}`);
      }
      return print({ connected: 'codex', mcpUrl, pending: hasToken ? 'claim' : null,
        next: 'Run `codex mcp login webly` in the foreground and keep it running until the person clicks Allow. Tools load in a new session: the person runs `codex resume --last`.' });
    }
    throw new Error('Usage: webly.mjs connect claude|codex');
  }

  if (command === 'forget') {
    const token = await savedCredential(base).catch(() => null);
    if (token) await forgetCredential(token);
    await unlink(PENDING_FILE).catch(() => {});
    return print(token ? 'Saved token removed' : 'No saved token');
  }

  if (!['init', 'deploy', 'replace', 'update', 'status', 'claim-link'].includes(command)) throw new Error(USAGE);
  const token = await localCredential(base);
  if (command === 'init') return print(`Credential saved to ${CREDENTIAL_FILE}`);
  const failed = async (result, fallback) => {
    if (SPENT.has(result.details?.reason) && await forgetCredential(token)) {
      throw new Error(`${result.message || fallback} The saved credential is spent and was removed; the next deploy creates a new one.`);
    }
    const reason = result.details?.reason ? ` [${result.details.reason}]` : '';
    throw new Error(`${result.message || fallback}${reason}`);
  };

  if (command === 'claim-link') {
    const current = await api(base, '/sites/current', token);
    if (!current.ok) await failed(current.body, 'Could not find a claimable site');
    // The token rides in the fragment, which browsers never send to a server. Printing it is an explicit choice.
    const link = `${current.body.claimPage}#token=${encodeURIComponent(token)}`;
    if (argument === '--open') { openInBrowser(link); return print(`Opened the claim page in the browser for "${current.body.name}".`); }
    return print(link);
  }

  if (command === 'status') {
    const current = await api(base, '/sites/current', token);
    if (!current.ok) await failed(current.body, `Request failed (${current.status})`);
    return print(current.body);
  }

  if (!argument) throw new Error(`${command} needs a folder, a file or a payload.json`);
  const body = await payloadFrom(argument);
  let response;
  const current = command === 'replace' ? null : await api(base, '/sites/current', token);
  if (current?.ok || command === 'update') {
    // One live site per token: publishing again updates it in place and keeps its URL.
    if (!current?.ok) await failed(current.body, 'No site to update');
    const { kind, ...rest } = body;
    response = await api(base, `/sites/${encodeURIComponent(current.body.id)}`, token, { method: 'PUT', body: JSON.stringify({ ...rest, expectedHeadVersion: current.body.headVersion }) });
  } else {
    response = await api(base, '/sites', token, { method: 'POST', body: JSON.stringify(command === 'replace' ? { ...body, replace: true } : body) });
  }
  if (!response.ok) await failed(response.body, `Request failed (${response.status})`);
  print(await settle(base, token, response.body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // doctor --brief runs as a session-start hook: it must never break a session.
  const brief = process.argv[2] === 'doctor' && process.argv[3] === '--brief';
  main().catch(error => { if (!brief) { console.error(error.message); process.exitCode = 1; } });
}
