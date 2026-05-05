/**
 * Parse server startup arguments from an argv array.
 * Returns { port, host, isGlobal, projectPath }.
 * Pass defaults to seed port/host from env vars before argv overrides them.
 */
export function parseServerArgv(argv, defaults = {}) {
  let port = defaults.port ?? 3400;
  let host = defaults.host ?? '127.0.0.1';
  let isGlobal = true;
  let projectPath = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (argv[i] === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (argv[i] === '--global') {
      isGlobal = true;
    } else if (argv[i] === '--project') {
      isGlobal = false;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        projectPath = argv[++i];
      }
    }
  }

  return { port, host, isGlobal, projectPath };
}
