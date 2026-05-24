// Commander entry point for the brackish CLI. Each functional area lives in its own module
// under `./cli/`; this file wires them together and parses argv.
//
// Output convention (enforced uniformly by the per-command modules via cli/common.ts):
//   - default = compact text to stdout, human-and-LLM friendly, dense
//   - --json   = a single JSON object/array to stdout, suitable for piping
//   - stderr is for metadata + diagnostics; stdout is for the "thing"
//   - exit 0 = success (including timed-out wait); 1 = operation error; 2 = usage/auth/connection

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { register as registerBatch } from './cli/batch.js';
import { register as registerBootstrap } from './cli/bootstrap.js';
import { errExit } from './cli/common.js';
import { register as registerConvention } from './cli/convention.js';
import { register as registerDaemon } from './cli/daemon.js';
import { register as registerDemo } from './cli/demo.js';
import { register as registerDocuments } from './cli/documents.js';
import { register as registerEndpoint } from './cli/endpoint.js';
import { register as registerEvents } from './cli/events.js';
import { register as registerInstall } from './cli/install.js';
import { register as registerRetract } from './cli/retract.js';
import { register as registerSchema } from './cli/schema.js';
import { register as registerStatus } from './cli/status.js';
import { register as registerValidate } from './cli/validate.js';
import { register as registerVisualize } from './cli/visualize.js';

// Pulled from package.json at build time (esbuild inlines static JSON imports). Keeps the bin's
// `--version` in sync with the published package version automatically.
const CLI_VERSION = pkg.version;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('brackish')
    .description(
      'Claude-to-Claude contract negotiation: document-scoped messages + propose/accept artifacts',
    )
    .version(CLI_VERSION);

  registerDaemon(program);
  registerBootstrap(program);
  registerDocuments(program);
  registerEvents(program);
  registerEndpoint(program);
  registerSchema(program);
  registerConvention(program);
  registerBatch(program);
  registerValidate(program);
  registerRetract(program);
  registerStatus(program);
  registerVisualize(program);
  registerDemo(program);
  registerInstall(program);

  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const thisFile = fileURLToPath(import.meta.url);
  if (entry === thisFile) return true;
  // npm installs as a symlink in <prefix>/bin/<bin>; resolve to the real path.
  try {
    return realpathSync(entry) === thisFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      errExit(2, err instanceof Error ? err.message : String(err));
    });
}
