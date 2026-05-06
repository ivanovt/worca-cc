#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readProjects,
  removeProject,
  slugify,
  validateProjectEntry,
  writeProject,
} from '../server/project-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
);

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.claude', 'settings.json'))) return dir;
    dir = dirname(dir);
  }
  return startDir;
}

const PREFS_DIR = join(homedir(), '.worca');
const SERVER_SCRIPT = join(__dirname, '..', 'server', 'index.js');

/** Exported for testing */
export function parseArgs(argv) {
  const args = {
    command: 'start',
    port: 3400,
    host: '127.0.0.1',
    open: false,
    global: true,
    // projects sub-command
    subAction: null, // 'list' | 'add' | 'remove'
    projectPath: null,
    projectName: null,
    // migrate sub-command
    scanDir: null,
    dryRun: false,
    migrateAdd: null,
    migrateStatus: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v') {
      args.command = 'version';
    } else if (arg === '--help' || arg === '-h') {
      args.command = 'help';
    } else if (
      ['start', 'stop', 'restart', 'status', 'projects', 'migrate'].includes(
        arg,
      )
    ) {
      args.command = arg;
      // Parse projects sub-actions
      if (arg === 'projects' && argv[i + 1]) {
        const sub = argv[i + 1];
        if (['list', 'add', 'remove'].includes(sub)) {
          args.subAction = sub;
          i++;
          if (
            (sub === 'add' || sub === 'remove') &&
            argv[i + 1] &&
            !argv[i + 1].startsWith('-')
          ) {
            args.projectPath = argv[++i];
          }
        }
      }
    } else if (arg === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (arg === '--host' && argv[i + 1]) {
      args.host = argv[++i];
    } else if (arg === '--open') {
      args.open = true;
    } else if (arg === '--global') {
      args.global = true;
    } else if (arg === '--project') {
      args.global = false;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        args.projectPath = argv[++i];
      }
    } else if (arg === '--scan' && argv[i + 1]) {
      args.scanDir = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--add' && argv[i + 1]) {
      args.migrateAdd = argv[++i];
    } else if (arg === '--status') {
      args.migrateStatus = true;
    } else if (arg === '--name' && argv[i + 1]) {
      args.projectName = argv[++i];
    }
  }
  return args;
}

/** Build the argv array for spawning server/index.js. Exported for testing. */
export function buildSpawnArgs({
  serverScript,
  port,
  host,
  isGlobal,
  projectPath,
}) {
  const args = [serverScript, '--port', String(port), '--host', host];
  if (isGlobal) {
    args.push('--global');
  } else if (projectPath) {
    args.push('--project', projectPath);
  }
  return args;
}

/** Resolve log file path based on mode (mirrors PID file location). */
function resolveLogPath(isGlobal) {
  if (isGlobal) {
    return join(PREFS_DIR, 'worca-ui-global.log');
  }
  const projectRoot = findProjectRoot(process.cwd());
  return join(projectRoot, '.worca', 'worca-ui.log');
}

/** Try to open a TCP connection. Resolves true if a peer accepts within timeoutMs. */
function canConnect(port, host, timeoutMs = 250) {
  return new Promise((resolveProm) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolveProm(ok);
    };
    const sock = connect({ port, host });
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Wait for the spawned server to either start listening or die.
 * Returns 'ready' (port open), 'died' (process exited), or 'timeout'.
 */
async function waitForServerStart({ pid, port, host, timeoutMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return 'died';
    if (await canConnect(port, host, 250)) return 'ready';
    await new Promise((r) => setTimeout(r, 150));
  }
  return isRunning(pid) ? 'timeout' : 'died';
}

/** Read the last N lines of a log file. Returns '' if unreadable. */
function tailLogFile(logPath, maxLines = 60) {
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n').trimEnd();
  } catch {
    return '';
  }
}

/** Resolve PID file path and dir based on mode. */
function resolvePidPaths(isGlobal) {
  if (isGlobal) {
    return {
      pidDir: PREFS_DIR,
      pidFile: join(PREFS_DIR, 'worca-ui-global.pid'),
    };
  }
  const projectRoot = findProjectRoot(process.cwd());
  return {
    pidDir: join(projectRoot, '.worca'),
    pidFile: join(projectRoot, '.worca', 'worca-ui.pid'),
  };
}

function readPidFile(pidFile) {
  try {
    return JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function writePidFile(pidFile, pidDir, info) {
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(pidFile, `${JSON.stringify(info, null, 2)}\n`);
}

function removePidFile(pidFile) {
  try {
    unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, host, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const p = startPort + i;
    if (await isPortAvailable(p, host)) return p;
  }
  return null;
}

/** Try to read an existing PID file for port-conflict diagnostics. */
function describePortOccupant(port) {
  // Check global PID file
  const globalPid = join(PREFS_DIR, 'worca-ui-global.pid');
  const globalInfo = readPidFile(globalPid);
  if (globalInfo && globalInfo.port === port && isRunning(globalInfo.pid)) {
    return `Global worca-ui is running on port ${port} (PID ${globalInfo.pid}, started ${globalInfo.started_at})`;
  }
  return null;
}

async function start({ port, host, open, global: isGlobal, projectPath }) {
  const { pidDir, pidFile } = resolvePidPaths(isGlobal);

  const existing = readPidFile(pidFile);
  if (existing && isRunning(existing.pid)) {
    console.log(
      `worca-ui already running (PID ${existing.pid}) at http://${existing.host}:${existing.port}`,
    );
    return;
  }

  let availablePort;
  if (isGlobal) {
    // Global mode: claim port exclusively, no auto-increment
    if (await isPortAvailable(port, host)) {
      availablePort = port;
    } else {
      const occupant = describePortOccupant(port);
      if (occupant) {
        console.error(`Port ${port} is occupied: ${occupant}`);
      } else {
        console.error(
          `Port ${port} is already in use. Cannot start global server.`,
        );
      }
      process.exit(1);
    }
  } else {
    // Per-project mode: auto-find available port
    availablePort = await findAvailablePort(port, host);
    if (availablePort === null) {
      console.error(`No available port found (tried ${port}-${port + 9})`);
      process.exit(1);
    }
    if (availablePort !== port) {
      console.log(`Port ${port} in use, using ${availablePort}`);
    }
  }

  const spawnArgs = buildSpawnArgs({
    serverScript: SERVER_SCRIPT,
    port: availablePort,
    host,
    isGlobal,
    projectPath,
  });

  // Capture child stdout+stderr to a log file so startup crashes are visible.
  // Without this, errors thrown during module load (missing files, bad imports,
  // config errors, port binding races) silently disappear and the CLI cheerfully
  // reports "started (PID …)" — see CLAUDE.md "missing-module crash" note.
  const logPath = resolveLogPath(isGlobal);
  let logFd = null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, 'w'); // truncate previous run's output
  } catch (e) {
    console.warn(
      `Warning: could not open log file ${logPath}: ${e.message}\nStartup errors will not be captured.`,
    );
  }

  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
    cwd: process.cwd(),
  });
  if (logFd != null) closeSync(logFd); // child holds its own dup
  child.unref();

  const url = `http://${host}:${availablePort}`;
  const state = await waitForServerStart({
    pid: child.pid,
    port: availablePort,
    host,
    timeoutMs: 5000,
  });

  if (state === 'died') {
    const tail = tailLogFile(logPath);
    console.error(
      `\n  worca-ui failed to start. The server process exited during startup.\n`,
    );
    if (tail) {
      console.error('  Last log output:\n');
      const indented = tail
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      console.error(indented);
      console.error('');
    }
    console.error(`  Full log: ${logPath}`);
    process.exit(1);
  }

  const info = {
    pid: child.pid,
    port: availablePort,
    host,
    started_at: new Date().toISOString(),
    mode: isGlobal ? 'global' : 'per-project',
    projectPath: isGlobal ? null : findProjectRoot(process.cwd()),
    logPath,
  };
  writePidFile(pidFile, pidDir, info);
  console.log(
    `worca-ui ${isGlobal ? '(global) ' : ''}started (PID ${child.pid}) at ${url}`,
  );
  if (state === 'timeout') {
    console.warn(
      `  Note: server did not accept connections within 5s but is still running.\n  Tail the log if it does not come up: ${logPath}`,
    );
  }

  // Hint: if global mode, empty projects.d/, and cwd has .worca/
  if (isGlobal) {
    const projects = readProjects(PREFS_DIR);
    if (projects.length === 0 && existsSync(join(process.cwd(), '.worca'))) {
      console.log(
        '\nTip: No projects registered. Run:\n' +
          `  worca-ui migrate --add ${process.cwd()}\n`,
      );
    }
  }

  if (open) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function stop({ global: isGlobal }) {
  const { pidFile } = resolvePidPaths(isGlobal);
  const info = readPidFile(pidFile);
  if (!info) {
    console.log('worca-ui is not running');
    return;
  }
  if (isRunning(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
      console.log(`worca-ui stopped (PID ${info.pid})`);
    } catch (e) {
      console.error(`Failed to stop PID ${info.pid}: ${e.message}`);
    }
  } else {
    console.log('worca-ui was not running (stale PID file)');
  }
  removePidFile(pidFile);
}

async function restart(opts) {
  stop(opts);
  await new Promise((r) => setTimeout(r, 500));
  await start(opts);
}

function status({ global: isGlobal }) {
  const { pidFile } = resolvePidPaths(isGlobal);
  const info = readPidFile(pidFile);
  if (!info) {
    console.log('worca-ui is not running');
    return;
  }
  if (isRunning(info.pid)) {
    const modeLabel = info.mode === 'global' ? ' (global)' : '';
    console.log(
      `worca-ui${modeLabel} is running (PID ${info.pid}) at http://${info.host}:${info.port}`,
    );
    console.log(`Started: ${info.started_at}`);
    if (info.projectPath) {
      console.log(`Project: ${info.projectPath}`);
    }
  } else {
    console.log('worca-ui is not running (stale PID file)');
    removePidFile(pidFile);
  }
}

// --- projects subcommand ---

function projectsList() {
  const projects = readProjects(PREFS_DIR);
  if (projects.length === 0) {
    console.log(
      'No projects registered. Use: worca-ui projects add /path/to/project',
    );
    return;
  }
  console.log(`${'NAME'.padEnd(30)} ${'PATH'.padEnd(50)} .worca`);
  console.log(`${'─'.repeat(30)} ${'─'.repeat(50)} ${'─'.repeat(6)}`);
  for (const p of projects) {
    const hasWorca = existsSync(join(p.path, '.worca')) ? 'yes' : 'no';
    console.log(`${p.name.padEnd(30)} ${p.path.padEnd(50)} ${hasWorca}`);
  }
}

function projectsAdd(pathArg, nameArg) {
  if (!pathArg) {
    console.error(
      'Usage: worca-ui projects add /path/to/project [--name slug]',
    );
    process.exit(1);
  }
  const absPath = isAbsolute(pathArg) ? pathArg : resolve(pathArg);
  if (!existsSync(absPath)) {
    console.error(`Path does not exist: ${absPath}`);
    process.exit(1);
  }
  const name = nameArg || slugify(basename(absPath));
  const entry = {
    name,
    path: absPath,
    worcaDir: join(absPath, '.worca'),
    settingsPath: join(absPath, '.claude', 'settings.json'),
  };
  const validation = validateProjectEntry(entry);
  if (!validation.valid) {
    console.error(`Invalid project entry: ${validation.error}`);
    process.exit(1);
  }
  try {
    writeProject(PREFS_DIR, entry);
    console.log(`Added project "${name}" at ${absPath}`);
  } catch (e) {
    console.error(`Failed to add project: ${e.message}`);
    process.exit(1);
  }
}

function projectsRemove(nameArg) {
  if (!nameArg) {
    console.error('Usage: worca-ui projects remove <project-name>');
    process.exit(1);
  }
  removeProject(PREFS_DIR, nameArg);
  console.log(`Removed project "${nameArg}"`);
}

// --- migrate subcommand ---

function migrateScan(scanDir, dryRun) {
  if (!scanDir) {
    console.error('Usage: worca-ui migrate --scan <dir> [--dry-run]');
    process.exit(1);
  }
  const absDir = isAbsolute(scanDir) ? scanDir : resolve(scanDir);
  if (!existsSync(absDir)) {
    console.error(`Directory does not exist: ${absDir}`);
    process.exit(1);
  }

  const found = [];
  // Walk depth 2 to find directories containing .worca/
  try {
    for (const d1 of readdirSync(absDir, { withFileTypes: true })) {
      if (!d1.isDirectory() || d1.name.startsWith('.')) continue;
      const p1 = join(absDir, d1.name);
      if (existsSync(join(p1, '.worca'))) {
        found.push(p1);
        continue;
      }
      try {
        for (const d2 of readdirSync(p1, { withFileTypes: true })) {
          if (!d2.isDirectory() || d2.name.startsWith('.')) continue;
          const p2 = join(p1, d2.name);
          if (existsSync(join(p2, '.worca'))) {
            found.push(p2);
          }
        }
      } catch {
        /* skip unreadable */
      }
    }
  } catch (e) {
    console.error(`Failed to scan: ${e.message}`);
    process.exit(1);
  }

  if (found.length === 0) {
    console.log('No projects with .worca/ found.');
    return;
  }

  const existing = readProjects(PREFS_DIR);
  const existingPaths = new Set(existing.map((p) => p.path));

  console.log(`Found ${found.length} project(s):\n`);
  console.log(`${'NAME'.padEnd(30)} ${'PATH'.padEnd(50)} STATUS`);
  console.log(`${'─'.repeat(30)} ${'─'.repeat(50)} ${'─'.repeat(15)}`);

  let registered = 0;
  for (const p of found) {
    const name = slugify(basename(p));
    const isExisting = existingPaths.has(p);
    const status = isExisting
      ? 'already registered'
      : dryRun
        ? 'would register'
        : 'registered';
    console.log(`${name.padEnd(30)} ${p.padEnd(50)} ${status}`);
    if (!isExisting && !dryRun) {
      try {
        writeProject(PREFS_DIR, {
          name,
          path: p,
          worcaDir: join(p, '.worca'),
          settingsPath: join(p, '.claude', 'settings.json'),
        });
        registered++;
      } catch (e) {
        console.error(`  Failed: ${e.message}`);
      }
    }
  }
  if (!dryRun && registered > 0) {
    console.log(`\nRegistered ${registered} new project(s).`);
  }
}

function migrateAdd(pathArg) {
  if (!pathArg) {
    console.error('Usage: worca-ui migrate --add /path/to/project');
    process.exit(1);
  }
  const absPath = isAbsolute(pathArg) ? pathArg : resolve(pathArg);
  if (absPath === '.') {
    return projectsAdd(process.cwd());
  }
  projectsAdd(absPath);
}

function migrateStatus() {
  const projects = readProjects(PREFS_DIR);
  if (projects.length === 0) {
    console.log('No projects registered.');
    return;
  }

  console.log(
    `${'NAME'.padEnd(30)} ${'PATH EXISTS'.padEnd(12)} ${'.worca'.padEnd(8)} ${'settings.json'.padEnd(15)}`,
  );
  console.log(
    `${'─'.repeat(30)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(15)}`,
  );
  for (const p of projects) {
    const pathExists = existsSync(p.path) ? 'yes' : 'NO';
    const hasWorca = existsSync(join(p.path, '.worca')) ? 'yes' : 'NO';
    const hasSettings = existsSync(join(p.path, '.claude', 'settings.json'))
      ? 'yes'
      : 'NO';
    console.log(
      `${p.name.padEnd(30)} ${pathExists.padEnd(12)} ${hasWorca.padEnd(8)} ${hasSettings.padEnd(15)}`,
    );
  }
}

function printHelp() {
  console.log(`worca-ui v${pkg.version} — Pipeline monitoring UI for worca-cc

Usage: worca-ui <command> [options]

Commands:
  start                        Start the server (default)
  stop                         Stop the running server
  restart                      Restart the server
  status                       Show server status
  projects list                List registered projects
  projects add <path> [--name] Register a project
  projects remove <name>       Unregister a project
  migrate --scan <dir>         Scan directory for projects to register
  migrate --add <path>         Register a single project
  migrate --status             Show registration health

Options:
  --port <N>         Server port (default: 3400, env: PORT)
  --host <addr>      Bind address (default: 127.0.0.1, env: HOST)
  --global           Multi-project mode (default)
  --project [path]   Single-project mode, optionally scoped to path
  --open             Open browser after start
  --dry-run          Preview migrate --scan without registering
  -v, --version      Show version
  -h, --help         Show this help`);
}

function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case 'start':
      start(args);
      break;
    case 'stop':
      stop(args);
      break;
    case 'restart':
      restart(args);
      break;
    case 'status':
      status(args);
      break;
    case 'projects':
      switch (args.subAction) {
        case 'list':
          projectsList();
          break;
        case 'add':
          projectsAdd(args.projectPath, args.projectName);
          break;
        case 'remove':
          projectsRemove(args.projectPath);
          break;
        default:
          console.log('Usage: worca-ui projects [list|add|remove]');
      }
      break;
    case 'migrate':
      if (args.scanDir) {
        migrateScan(args.scanDir, args.dryRun);
      } else if (args.migrateAdd) {
        migrateAdd(args.migrateAdd);
      } else if (args.migrateStatus) {
        migrateStatus();
      } else {
        console.log(
          'Usage:\n' +
            '  worca-ui migrate --scan <dir> [--dry-run]\n' +
            '  worca-ui migrate --add /path/to/project\n' +
            '  worca-ui migrate --status',
        );
      }
      break;
    case 'version':
      console.log(pkg.version);
      break;
    case 'help':
      printHelp();
      break;
    default:
      printHelp();
  }
}

// Only run the CLI when this file is the entry point — not when imported
// by tests (which load the module to access exported helpers like parseArgs).
const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  main();
}
