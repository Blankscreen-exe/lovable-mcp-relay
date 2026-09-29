/**
 * Finding and editing the Claude Code config that points at this relay.
 *
 * This is the only part of the tool that writes outside its own folder, so it
 * is deliberately narrow: an existing MCP config file, the `lovable` entry
 * inside it, and its `url` field. Nothing else is read, created or changed, and
 * the original value is recorded so it can be put back.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './config.mjs';
import { log } from './log.mjs';

/** Remembers the URL each file had before we changed it, so Revert is exact. */
const STATE = path.join(ROOT, '.connections.json');

const SERVER_KEY = 'lovable';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadState() {
  return readJson(STATE) ?? { originals: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}

/**
 * Where a Claude Code MCP config can live.
 *
 * Claude Code records every project folder it has opened in ~/.claude.json, so
 * that list tells us which `.mcp.json` files actually exist on this machine --
 * far better than guessing or making the user hunt for the path.
 */
function candidatePaths() {
  const found = new Set();

  const userLevel = path.join(os.homedir(), '.claude', 'mcp.json');
  if (fs.existsSync(userLevel)) found.add(userLevel);

  const claudeJson = readJson(path.join(os.homedir(), '.claude.json'));
  for (const project of Object.keys(claudeJson?.projects ?? {})) {
    const file = path.join(project, '.mcp.json');
    try {
      if (fs.existsSync(file)) found.add(path.normalize(file));
    } catch {
      // An unreadable or unmounted project path is not an error here.
    }
  }

  // Anything we have already edited stays listed even if Claude Code forgets
  // the project, so Revert never becomes unreachable.
  for (const file of Object.keys(loadState().originals)) {
    if (fs.existsSync(file)) found.add(path.normalize(file));
  }

  return [...found];
}

function describe(file) {
  const config = readJson(file);
  const entry = config?.mcpServers?.[SERVER_KEY];
  const state = loadState();
  return {
    path: file,
    readable: config !== null,
    hasLovable: Boolean(entry),
    url: entry?.url ?? null,
    originalUrl: state.originals[file] ?? null,
    writable: isWritable(file),
  };
}

function isWritable(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function discover() {
  return candidatePaths().map(describe);
}

/** Refuse anything that is not plainly an MCP config file that already exists. */
function assertEditable(file) {
  if (!file || typeof file !== 'string') throw new ConfigError('No file was given.');
  const resolved = path.normalize(file);
  const base = path.basename(resolved);
  if (base !== '.mcp.json' && base !== 'mcp.json') {
    throw new ConfigError('That is not an MCP config file (expected .mcp.json or mcp.json).');
  }
  if (!fs.existsSync(resolved)) {
    throw new ConfigError('That file does not exist. This tool will not create config files.');
  }
  const config = readJson(resolved);
  if (!config || typeof config !== 'object') {
    throw new ConfigError('That file is not readable JSON, so it is not safe to edit.');
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    throw new ConfigError('That file has no "mcpServers" section.');
  }
  return { resolved, config };
}

/** What would change, without changing it. */
export function preview(file, relayUrl) {
  const { resolved, config } = assertEditable(file);
  const entry = config.mcpServers[SERVER_KEY];
  return {
    path: resolved,
    before: entry?.url ?? null,
    after: relayUrl,
    willAddEntry: !entry,
    alreadyConnected: entry?.url === relayUrl,
  };
}

export function apply(file, relayUrl) {
  const { resolved, config } = assertEditable(file);
  const entry = config.mcpServers[SERVER_KEY];
  const before = entry?.url ?? null;

  if (entry) {
    entry.url = relayUrl;
    entry.type = entry.type ?? 'http';
  } else {
    config.mcpServers[SERVER_KEY] = { type: 'http', url: relayUrl };
  }

  // Only record the original the first time, so applying twice cannot
  // overwrite the real starting value with the relay's own URL.
  const state = loadState();
  if (!(resolved in state.originals)) {
    state.originals[resolved] = before;
  }

  fs.writeFileSync(resolved, JSON.stringify(config, null, 2) + '\n');
  saveState(state);
  log.info(`connected ${resolved} to ${relayUrl} (was ${before ?? 'not present'})`);

  return { path: resolved, before, after: relayUrl };
}

export function revert(file) {
  const { resolved, config } = assertEditable(file);
  const state = loadState();
  if (!(resolved in state.originals)) {
    throw new ConfigError('There is no recorded original for that file, so there is nothing to put back.');
  }
  const original = state.originals[resolved];

  if (original === null) {
    // It had no lovable entry before we added one: remove ours again.
    delete config.mcpServers[SERVER_KEY];
  } else {
    config.mcpServers[SERVER_KEY] = { ...(config.mcpServers[SERVER_KEY] ?? {}), type: 'http', url: original };
  }

  fs.writeFileSync(resolved, JSON.stringify(config, null, 2) + '\n');
  delete state.originals[resolved];
  saveState(state);
  log.info(`reverted ${resolved} to ${original ?? 'no lovable entry'}`);

  return { path: resolved, restored: original };
}
