#!/usr/bin/env node
import('../src/cli.mjs').then(({ main }) => main(process.argv.slice(2))).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
