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
import { register as registerSchema } from './cli/schema.js';
import { register as registerStatus } from './cli/status.js';
import { register as registerVisualize } from './cli/visualize.js';

const CLI_VERSION = '0.3.0';

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
