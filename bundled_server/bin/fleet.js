#!/usr/bin/env node
// claude-fleet-server CLI.
//   fleet doctor    — locate Claude Code, check the version gate, show provider & task dirs
//   fleet serve     — start the HTTP service
//   fleet version   — print the package version

import { locateClaude, readClaudeVersion, checkClaude, defaultMinVersion, ClaudeNotFoundError, ClaudeVersionError } from '../lib/claude/locate.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [cmd, ...rest] = process.argv.slice(2);

function version() {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

async function doctor() {
  const minVersion = process.env.CLAUDE_MIN_VERSION || defaultMinVersion();
  console.log(`claude-fleet-server v${version()} — doctor`);
  console.log(`  min Claude version : ${minVersion}  (set CLAUDE_MIN_VERSION to override)`);
  console.log('');

  let info;
  try {
    info = await checkClaude({ minVersion });
    console.log(`  Claude CLI OK       : ${info.bin}`);
    console.log(`  detected version    : ${info.version}  >= ${minVersion} ✔`);
    console.log(`  source              : ${info.source}`);
  } catch (error) {
    if (error instanceof ClaudeNotFoundError) {
      console.log(`  Claude CLI          : NOT FOUND`);
      console.log(`    ${error.message}`);
    } else if (error instanceof ClaudeVersionError) {
      console.log(`  Claude CLI          : "${error.bin}"`);
      console.log(`  version             : ${error.version}  (< ${minVersion}) ✘`);
      console.log(`    ${error.message}`);
    } else {
      throw error;
    }
    process.exitCode = 1;
  }
}

async function main() {
  switch (cmd) {
    case 'version':
      console.log(version());
      break;
    case 'doctor':
      await doctor();
      break;
    case 'serve':
      {
        const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'app', 'server.js')));
        const server = await startServer();
        const PORT = Number(process.env.PORT || 3180);
        const HOST = process.env.HOST || '127.0.0.1';
        server.requestTimeout = 120_000;
        server.headersTimeout = 30_000;
        server.listen(PORT, HOST, () => console.log(`[server] claude-fleet-server listening on http://${HOST}:${PORT}`));
        const shutdown = (signal) => {
          console.log(`[server] ${signal}, stopping`);
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(1), 10_000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
      }
      break;
    case 'serve-foreground':
    case undefined:
      console.log('usage: fleet <doctor|serve|version>');
      console.log('');
      console.log('  fleet doctor    locate + verify Claude Code, show environment');
      console.log('  fleet serve     start the HTTP service on PORT (default 3180)');
      console.log('  fleet version   print the claude-fleet-server version');
      process.exitCode = cmd ? 0 : 1;
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
}

await main();