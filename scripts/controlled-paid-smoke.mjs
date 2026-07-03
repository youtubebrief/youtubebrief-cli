#!/usr/bin/env node
import { runControlledPaidSmoke, parseSmokeArgs, smokeHelpText } from '../src/smoke.mjs';
import { sanitizeMessage } from '../src/errors.mjs';

try {
  const options = parseSmokeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(smokeHelpText());
    process.exit(0);
  }
  const { reportPath } = await runControlledPaidSmoke(options);
  process.stdout.write(`Controlled paid smoke passed. Report: ${reportPath}\n`);
} catch (error) {
  process.stderr.write(`${sanitizeMessage(error.message)}\n`);
  process.exit(error.exitCode || 1);
}
