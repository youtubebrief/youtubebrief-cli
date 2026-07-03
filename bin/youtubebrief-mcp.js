#!/usr/bin/env node
import('../src/mcp/server.mjs').then(({ runMcpServer }) => runMcpServer()).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
