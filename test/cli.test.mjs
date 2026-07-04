import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main as runMain } from "../src/cli.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BIN = join(ROOT, "bin", "yb.js");
const SMOKE_SCRIPT = join(ROOT, "scripts", "controlled-paid-smoke.mjs");
const PRODUCTION_SAFE_SMOKE_SCRIPT = join(ROOT, "scripts", "production-safe-smoke.mjs");

async function runCli(args, options = {}) {
  const env = {
    ...process.env,
    YOUTUBEBRIEF_CONFIG_DIR: options.configDir,
    ...options.env
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on("close", resolve))
  ]);
  return { stdout, stderr, exitCode };
}

async function runNodeScript(script, args, options = {}) {
  const env = {
    ...process.env,
    ...options.env
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on("close", resolve))
  ]);
  return { stdout, stderr, exitCode };
}

async function runInteractiveCli(input, options = {}) {
  const chunks = [];
  const openedUrls = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    }
  });
  const answers = input.split(/\n/);
  if (answers.at(-1) === "") answers.pop();
  const questioner = {
    async question(prompt) {
      chunks.push(prompt);
      if (!answers.length) throw new Error(`No scripted answer left for prompt: ${prompt}`);
      return answers.shift();
    }
  };
  const browserOpener = options.browserOpener || (async (url) => {
    openedUrls.push(url);
  });
  const originalEnv = {
    YOUTUBEBRIEF_CONFIG_DIR: process.env.YOUTUBEBRIEF_CONFIG_DIR,
    YB_BASE_URL: process.env.YB_BASE_URL,
    YOUTUBEBRIEF_BASE_URL: process.env.YOUTUBEBRIEF_BASE_URL,
    YB_API_KEY: process.env.YB_API_KEY,
    YOUTUBEBRIEF_API_KEY: process.env.YOUTUBEBRIEF_API_KEY,
    YB_NO_BROWSER: process.env.YB_NO_BROWSER,
    CI: process.env.CI
  };
  const env = {
    YOUTUBEBRIEF_CONFIG_DIR: options.configDir,
    YB_API_KEY: undefined,
    YOUTUBEBRIEF_API_KEY: undefined,
    YB_NO_BROWSER: undefined,
    CI: undefined,
    ...options.env
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await runMain(options.args || [], { stdout, interactive: true, questioner, browserOpener });
    return { stdout: chunks.join(""), openedUrls };
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(output));
  });
}

async function tempConfigDir() {
  return await mkdtemp(join(tmpdir(), "yb-config-"));
}

async function withMockApi(handler, callback) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      };
      requests.push(record);
      try {
        const result = await handler(record, requests);
        res.statusCode = result.status ?? 200;
        for (const [key, value] of Object.entries(result.headers ?? { "Content-Type": "application/json" })) {
          res.setHeader(key, value);
        }
        res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await callback({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function summaryPayload(id = "sum_test") {
  return {
    id,
    status: "completed",
    sourceUrl: "https://www.youtube.com/watch?v=LPZh9BOjkQs",
    videoTitle: "Large Language Models explained briefly",
    markdown: "# Large Language Models explained briefly\n\n## TL;DR\n- LLMs predict useful continuations.",
    shortSummary: ["LLMs predict useful continuations."],
    sections: [],
    timestampEvidence: [],
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("package metadata exposes beta-ready bins and pack smoke without publishing", async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@youtubebrief/cli");
  assert.deepEqual(packageJson.bin, {
    yb: "bin/yb.js",
    youtubebrief: "bin/youtubebrief.js",
    "youtubebrief-mcp": "bin/youtubebrief-mcp.js"
  });
  assert.match(packageJson.version, /^0\.1\.0-beta\.\d+$/);
  assert.deepEqual(packageJson.publishConfig, { access: "public", tag: "beta", provenance: true });
  assert.equal("directory" in packageJson.repository, false);
  assert.match(packageJson.repository.url, /github\.com\/youtubebrief\/youtubebrief-cli/);
  assert.equal(packageJson.scripts["release:gate"], "node scripts/release-gate.mjs");
  assert.equal(packageJson.scripts["pack:dry-run"], "npm pack --dry-run --json");
  assert.equal(packageJson.scripts["prepublishOnly"], "npm run verify && npm run release:gate && npm run smoke:pack");
  assert.equal(packageJson.scripts["smoke:pack"], "node scripts/pack-smoke.mjs");
  assert.equal(packageJson.scripts["smoke:global-install"], "node scripts/global-install-smoke.mjs");
  assert.equal(packageJson.scripts["smoke:production-safe"], "node scripts/production-safe-smoke.mjs");
  for (const entry of ["bin", "src", "scripts", "examples", "README.md", "llms.txt", "SECURITY.md", "LICENSE"]) {
    assert.ok(packageJson.files.includes(entry), `${entry} should be included in npm package files`);
  }
  for (const forbidden of ["test", "benchmark", ".env", ".omx", "frontend-design-repos"]) {
    assert.equal(packageJson.files.includes(forbidden), false, `${forbidden} should not be included in package files`);
  }
});

test("release:gate passes beta prepublish metadata and docs guards", async () => {
  const result = await runNodeScript(join(ROOT, "scripts", "release-gate.mjs"), []);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, { ok: true, package: "@youtubebrief/cli", version: "0.1.0-beta.4", tag: "beta", channel: "beta" });
});

test("help and version work without config or network", async () => {
  const configDir = await tempConfigDir();
  try {
    const noArgs = await runCli([], { configDir });
    assert.equal(noArgs.exitCode, 0);
    assert.match(noArgs.stdout, /https:\/\/youtubebrief\.com\/cli/);
    assert.match(noArgs.stdout, /Non-TTY shells print this deterministic help and never open a browser/);
    assert.match(noArgs.stdout, /Usage: yb/);

    const help = await runCli(["--help"], { configDir });
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Usage: yb/);
    assert.match(help.stdout, /yb brief <youtube-url>/);

    const version = await runCli(["--version"], { configDir });
    assert.equal(version.exitCode, 0);
    assert.match(version.stdout.trim(), /^0\.1\.0-beta\.\d+$/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("interactive setup signs up and opens a checkout URL", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/accounts") {
        assert.deepEqual(JSON.parse(request.body), { email: "interactive@example.com" });
        return { status: 201, body: { account: { email: "interactive@example.com" }, apiKey: "FAKE_YB_TEST_TOKEN_interactive_secret" } };
      }
      if (request.method === "GET" && request.url === "/api/v1/credits") {
        assert.equal(request.headers.authorization, "Bearer FAKE_YB_TEST_TOKEN_interactive_secret");
        return {
          body: {
            purchasedMinutes: 0,
            consumedMinutes: 0,
            remainingMinutes: 0,
            packages: [
              { id: "5m", minutes: 5, currency: "usd", unitAmountCents: 105, unitAmountUsd: 1.05 },
              { id: "10m", minutes: 10, currency: "usd", unitAmountCents: 210, unitAmountUsd: 2.1 }
            ]
          }
        };
      }
      if (request.method === "POST" && request.url === "/api/v1/billing/checkout") {
        assert.equal(request.headers.authorization, "Bearer FAKE_YB_TEST_TOKEN_interactive_secret");
        assert.deepEqual(JSON.parse(request.body), { minutes: 5 });
        return { status: 201, body: { checkoutUrl: "https://checkout.example/interactive" } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runInteractiveCli("1\ninteractive@example.com\ny\n1\n6\n", {
        configDir,
        env: { YB_BASE_URL: baseUrl }
      });
      assert.match(result.stdout, /Youtubebrief CLI/);
      assert.match(result.stdout, /Opened CLI setup in your browser/);
      assert.match(result.stdout, /Create account \/ sign in with email/);
      assert.match(result.stdout, /Created account interactive@example\.com/);
      assert.match(result.stdout, /5 minutes - \$1\.05/);
      assert.match(result.stdout, /Opened checkout in your browser/);
      assert.equal(result.openedUrls.length, 2);
      assert.match(result.openedUrls[0], new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/cli\\?`));
      assert.equal(result.openedUrls[0].includes("utm_campaign=onboarding"), true);
      assert.equal(result.openedUrls[1], "https://checkout.example/interactive");
      const config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      assert.equal(config.apiKey, "FAKE_YB_TEST_TOKEN_interactive_secret");
      assert.equal(config.baseUrl, baseUrl);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("interactive login opens account page without touching API key stdin flow", async () => {
  const configDir = await tempConfigDir();
  try {
    const result = await runInteractiveCli("3\n", {
      args: ["login", "--base-url", "https://example.test"]
    });
    assert.match(result.stdout, /Youtubebrief login/);
    assert.match(result.stdout, /Opened account \+ billing in your browser/);
    assert.match(result.stdout, /I created\/copied an API key in the browser/);
    assert.equal(result.openedUrls.length, 1);
    assert.match(result.openedUrls[0], /^https:\/\/example\.test\/account\?/);
    assert.equal(result.openedUrls[0].includes("utm_campaign=login"), true);

    const tokenLogin = await runCli(["login", "--token-stdin", "--base-url", "https://example.test"], {
      configDir,
      stdin: "script-token\n"
    });
    assert.equal(tokenLogin.exitCode, 0, tokenLogin.stderr);
    assert.match(tokenLogin.stdout, /Logged in to https:\/\/example\.test/);
    const config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    assert.equal(config.apiKey, "script-token");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("non-TTY login prints deterministic browser setup instructions", async () => {
  const configDir = await tempConfigDir();
  try {
    const result = await runCli(["login", "--base-url", "https://example.test"], { configDir });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Youtubebrief login/);
    assert.match(result.stdout, /Open account \+ billing:/);
    assert.match(result.stdout, /https:\/\/example\.test\/account\?/);
    assert.match(result.stdout, /utm_campaign=login/);
    assert.match(result.stdout, /yb login --token-stdin/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("credits formats minute ledger and package hints", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "GET" && request.url === "/api/v1/credits") {
        assert.equal(request.headers.authorization, "Bearer FAKE_YB_TEST_TOKEN_credits_secret");
        return {
          body: {
            purchasedMinutes: 0,
            consumedMinutes: 0,
            remainingMinutes: 0,
            packages: [
              { id: "5m", minutes: 5, currency: "usd", unitAmountCents: 105, unitAmountUsd: 1.05 },
              { id: "10m", minutes: 10, currency: "usd", unitAmountCents: 210, unitAmountUsd: 2.1 }
            ]
          }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runCli(["credits"], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "FAKE_YB_TEST_TOKEN_credits_secret"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Purchased: 0 minutes/);
      assert.match(result.stdout, /Remaining: 0 minutes/);
      assert.match(result.stdout, /yb buy 5\s+\$1\.05/);
      assert.match(result.stdout, /yb buy 10\s+\$2\.10/);
      assert.match(result.stdout, /--minutes 5/);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("doctor reports environment readiness without leaking API keys", async () => {
  const configDir = await tempConfigDir();
  const outDir = join(configDir, "out");
  try {
    await withMockApi(async (request) => {
      if (request.method === "GET" && request.url === "/healthz") {
        return { body: { ok: true, service: "mock-youtubebrief" } };
      }
      if (request.method === "GET" && request.url === "/api/v1/credits") {
        assert.equal(request.headers.authorization, "Bearer FAKE_YB_TEST_TOKEN_doctor_secret");
        return { body: { credits: 12 } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runCli(["doctor", "--out-dir", outDir], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "FAKE_YB_TEST_TOKEN_doctor_secret"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Youtubebrief doctor/);
      assert.match(result.stdout, /node: ok/);
      assert.match(result.stdout, /auth: ok - API key present via environment/);
      assert.match(result.stdout, /health: ok/);
      assert.match(result.stdout, /credits: ok - 12 credits/);
      assert.match(result.stdout, /out_dir: ok/);
      assert.match(result.stdout, /telemetry: ok - Privacy-safe activation telemetry is on/);
      assert.doesNotMatch(result.stdout, /FAKE_YB_TEST_TOKEN_doctor_secret/);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("signup stores returned API key and buy prints checkout URL", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/accounts") {
        assert.deepEqual(JSON.parse(request.body), { email: "cli@example.com" });
        return { status: 201, body: { account: { id: "acct_1", email: "cli@example.com" }, apiKey: "FAKE_YB_TEST_TOKEN_12345678_secret" } };
      }
      if (request.method === "POST" && request.url === "/api/v1/billing/checkout") {
        assert.equal(request.headers.authorization, "Bearer FAKE_YB_TEST_TOKEN_12345678_secret");
        assert.deepEqual(JSON.parse(request.body), { minutes: 30 });
        return { status: 201, body: { checkoutUrl: "https://checkout.example/session" } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const signup = await runCli(["signup", "--email", "cli@example.com", "--base-url", baseUrl], { configDir });
      assert.equal(signup.exitCode, 0, signup.stderr);
      assert.match(signup.stdout, /Created account cli@example.com/);

      const config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      assert.equal(config.apiKey, "FAKE_YB_TEST_TOKEN_12345678_secret");

      const buy = await runCli(["buy", "30"], { configDir });
      assert.equal(buy.exitCode, 0, buy.stderr);
      assert.equal(buy.stdout.trim(), "https://checkout.example/session");
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("login and signup honor YB_BASE_URL before the legacy base-url env alias", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/accounts") {
        assert.deepEqual(JSON.parse(request.body), { email: "yb-env@example.com" });
        return { status: 201, body: { account: { email: "yb-env@example.com" }, apiKey: "FAKE_YB_TEST_TOKEN_signup_env_secret" } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const legacyUrl = "http://127.0.0.1:1";
      const login = await runCli(["login", "--token-stdin"], {
        configDir,
        stdin: "FAKE_YB_TEST_TOKEN_login_env_secret\n",
        env: {
          YB_BASE_URL: baseUrl,
          YOUTUBEBRIEF_BASE_URL: legacyUrl
        }
      });
      assert.equal(login.exitCode, 0, login.stderr);
      assert.match(login.stdout, new RegExp(`Logged in to ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      let config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      assert.equal(config.baseUrl, baseUrl);
      assert.equal(config.apiKey, "FAKE_YB_TEST_TOKEN_login_env_secret");

      const signup = await runCli(["signup", "--email", "yb-env@example.com"], {
        configDir,
        env: {
          YB_BASE_URL: baseUrl,
          YOUTUBEBRIEF_BASE_URL: legacyUrl
        }
      });
      assert.equal(signup.exitCode, 0, signup.stderr);
      assert.match(signup.stdout, new RegExp(`logged in to ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      assert.equal(config.baseUrl, baseUrl);
      assert.equal(config.apiKey, "FAKE_YB_TEST_TOKEN_signup_env_secret");
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("config get/set updates local config without printing secrets", async () => {
  const configDir = await tempConfigDir();
  try {
    const setBase = await runCli(["config", "set", "base-url", "http://127.0.0.1:3999"], { configDir });
    assert.equal(setBase.exitCode, 0, setBase.stderr);
    assert.match(setBase.stdout, /Set base URL to http:\/\/127\.0\.0\.1:3999/);

    const getBase = await runCli(["config", "get", "base-url"], { configDir });
    assert.equal(getBase.exitCode, 0, getBase.stderr);
    assert.equal(getBase.stdout.trim(), "http://127.0.0.1:3999");

    const setKey = await runCli(["config", "set", "api-key", "--token-stdin"], {
      configDir,
      stdin: "FAKE_YB_TEST_TOKEN_config_secret\n"
    });
    assert.equal(setKey.exitCode, 0, setKey.stderr);
    assert.match(setKey.stdout, /Stored API key/);
    assert.doesNotMatch(setKey.stdout, /FAKE_YB_TEST_TOKEN_config_secret/);

    const getKey = await runCli(["config", "get", "api-key"], { configDir });
    assert.equal(getKey.exitCode, 0, getKey.stderr);
    assert.equal(getKey.stdout.trim(), "set");
    assert.doesNotMatch(getKey.stdout, /FAKE_YB_TEST_TOKEN_config_secret/);

    const getAll = await runCli(["config", "get"], { configDir });
    assert.equal(getAll.exitCode, 0, getAll.stderr);
    assert.match(getAll.stdout, /config_path:/);
    assert.match(getAll.stdout, /base_url: http:\/\/127\.0\.0\.1:3999/);
    assert.match(getAll.stdout, /api_key: set/);
    assert.doesNotMatch(getAll.stdout, /FAKE_YB_TEST_TOKEN_config_secret/);

    const configPath = join(configDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.baseUrl, "http://127.0.0.1:3999");
    assert.equal(config.apiKey, "FAKE_YB_TEST_TOKEN_config_secret");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    await chmod(configPath, 0o644);
    const resetKey = await runCli(["config", "set", "api-key", "--token-stdin"], {
      configDir,
      stdin: "FAKE_YB_TEST_TOKEN_config_secret_rotated\n"
    });
    assert.equal(resetKey.exitCode, 0, resetKey.stderr);
    assert.doesNotMatch(resetKey.stdout, /FAKE_YB_TEST_TOKEN_config_secret_rotated/);
    const rotatedConfig = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(rotatedConfig.apiKey, "FAKE_YB_TEST_TOKEN_config_secret_rotated");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, "config rewrite must repair loose existing permissions");

    const argvKey = await runCli(["config", "set", "api-key", "--value", "FAKE_YB_TEST_TOKEN_should_reject"], { configDir });
    assert.notEqual(argvKey.exitCode, 0);
    assert.match(argvKey.stderr, /Unknown config set api-key option: --value/);

    const envOverride = await runCli(["config", "get", "base-url"], {
      configDir,
      env: { YB_BASE_URL: "https://env.example" }
    });
    assert.equal(envOverride.exitCode, 0, envOverride.stderr);
    assert.equal(envOverride.stdout.trim(), "https://env.example");

    const envLogin = await runCli(["login", "--token-stdin"], {
      configDir,
      stdin: "FAKE_YB_TEST_TOKEN_env_login\n",
      env: {
        YB_BASE_URL: "https://login-env.example",
        YOUTUBEBRIEF_BASE_URL: "https://legacy-env.example"
      }
    });
    assert.equal(envLogin.exitCode, 0, envLogin.stderr);
    assert.match(envLogin.stdout, /https:\/\/login-env\.example/);
    const envLoginConfig = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(envLoginConfig.baseUrl, "https://login-env.example");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("login stores token from stdin and logout removes it", async () => {
  const configDir = await tempConfigDir();
  try {
    const login = await runCli(["login", "--token-stdin", "--base-url", "http://example.test"], {
      configDir,
      stdin: "secret-token\n"
    });
    assert.equal(login.exitCode, 0, login.stderr);
    assert.match(login.stdout, /Logged in/);

    const config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    assert.equal(config.apiKey, "secret-token");
    assert.equal(config.baseUrl, "http://example.test");
    const mode = (await stat(join(configDir, "config.json"))).mode & 0o777;
    assert.equal(mode & 0o077, 0, `config should not be group/world-readable; mode=${mode.toString(8)}`);

    const logout = await runCli(["logout"], { configDir });
    assert.equal(logout.exitCode, 0, logout.stderr);
    assert.match(logout.stdout, /Logged out/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("brief shortcut posts URL, follows resultUrl, and prints markdown", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        assert.equal(request.headers.authorization, "Bearer env-token");
        assert.deepEqual(JSON.parse(request.body), { youtubeUrl: "https://youtu.be/LPZh9BOjkQs", billingBlockMinutes: 10 });
        return { status: 201, body: { id: "sum_test", status: "completed", resultUrl: "/api/v1/summaries/sum_test" } };
      }
      if (request.method === "GET" && request.url === "/api/v1/summaries/sum_test") {
        return { body: summaryPayload() };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runCli(["https://youtu.be/LPZh9BOjkQs"], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "env-token"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /# Large Language Models explained briefly/);
      assert.match(result.stdout, /## TL;DR/);
      assert.equal(result.stderr, "");
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("brief shortcut retries with a 5-minute block when the default 10-minute block exceeds balance", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        assert.equal(request.headers.authorization, "Bearer env-token");
        const body = JSON.parse(request.body);
        if (body.billingBlockMinutes === 10) {
          return {
            status: 402,
            body: { error: { code: "insufficient_credits", message: "This brief needs a 10-minute block. Buy minutes or choose a smaller block." } }
          };
        }
        assert.deepEqual(body, { youtubeUrl: "https://youtu.be/LPZh9BOjkQs", billingBlockMinutes: 5 });
        return { status: 201, body: summaryPayload() };
      }
      if (request.method === "GET" && request.url === "/api/v1/credits") {
        assert.equal(request.headers.authorization, "Bearer env-token");
        return { body: { purchasedMinutes: 5, consumedMinutes: 0, remainingMinutes: 5 } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli(["https://youtu.be/LPZh9BOjkQs"], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "env-token"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stderr, /retrying this brief with --minutes 5/);
      assert.match(result.stdout, /# Large Language Models explained briefly/);
      assert.deepEqual(
        requests
          .filter((request) => request.method === "POST" && request.url === "/api/v1/summaries")
          .map((request) => JSON.parse(request.body).billingBlockMinutes),
        [10, 5]
      );
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("brief respects an explicitly requested billing block instead of auto-retrying", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        assert.deepEqual(JSON.parse(request.body), { youtubeUrl: "https://youtu.be/LPZh9BOjkQs", billingBlockMinutes: 10 });
        return {
          status: 402,
          body: { error: { code: "insufficient_credits", message: "This brief needs a 10-minute block. Buy minutes or choose a smaller block." } }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli(["brief", "https://youtu.be/LPZh9BOjkQs", "--minutes", "10"], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "env-token"
        }
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /10-minute block/);
      assert.equal(result.stdout, "");
      assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/v1/credits").length, 0);
      assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/api/v1/summaries").length, 1);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("brief supports json output, output file, and async polling", async () => {
  const configDir = await tempConfigDir();
  const outputFile = join(configDir, "brief.json");
  try {
    await withMockApi(async (request, requests) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        return { status: 202, body: { id: "sum_async", status: "processing", resultUrl: "/api/v1/summaries/sum_async" } };
      }
      const getCount = requests.filter((item) => item.method === "GET").length;
      if (request.method === "GET" && request.url === "/api/v1/summaries/sum_async" && getCount === 1) {
        return { body: { id: "sum_async", status: "processing" } };
      }
      if (request.method === "GET" && request.url === "/api/v1/summaries/sum_async") {
        return { body: summaryPayload("sum_async") };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runCli(["brief", "https://youtu.be/LPZh9BOjkQs", "--format", "json", "--output", outputFile, "--poll-interval-ms", "1"], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "env-token"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Wrote JSON brief/);
      const written = JSON.parse(await readFile(outputFile, "utf8"));
      assert.equal(written.id, "sum_async");
      assert.equal(written.markdown, summaryPayload("sum_async").markdown);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("batch command accepts URL args, --input, stdin, and writes a concise out-dir bundle", async () => {
  const configDir = await tempConfigDir();
  const outDir = join(configDir, "yb-out");
  const inputFile = join(configDir, "urls.txt");
  await writeFile(inputFile, "# comments are ignored\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n", "utf8");
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        assert.equal(request.headers.authorization, "Bearer env-token");
        const body = JSON.parse(request.body);
        assert.match(body.youtubeUrl, /^https:\/\/www\.youtube\.com\/watch\?v=/);
        assert.equal(body.billingBlockMinutes, 30);
        assert.match(body.idempotencyKey, /^batch_[a-f0-9]+:item_\d+_[a-f0-9]+$/);
        return {
          status: 201,
          body: {
            id: `sum_${body.youtubeUrl.slice(-4)}`,
            status: "completed",
            markdown: `# Brief for ${body.youtubeUrl}\n\nBatch body.`,
            billing: {
              billed: true,
              billingEventId: `bill_${body.youtubeUrl.slice(-4)}`,
              idempotencyKey: body.idempotencyKey
            }
          }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli([
        "batch",
        "--out-dir",
        outDir,
        "--input",
        inputFile,
        "--stdin",
        "--concurrency",
        "2",
        "--minutes",
        "30",
        "https://youtu.be/LPZh9BOjkQs"
      ], {
        configDir,
        stdin: "https://www.youtube.com/embed/JaRGJVrJBQ8\n",
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: "env-token"
        }
      });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /yb batch completed/);
      assert.match(result.stdout, /total: 3/);
      assert.match(result.stdout, /succeeded: 3/);
      assert.match(result.stdout, new RegExp(`manifest: ${outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/manifest\\.json`));
      assert.doesNotMatch(result.stdout, /# Brief for/);
      assert.equal(result.stderr, "");
      assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/api/v1/summaries").length, 3);

      const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
      assert.equal(manifest.status, "succeeded");
      assert.equal(manifest.billed_successes, 3);
      assert.deepEqual(manifest.items.map((item) => item.normalized_video_id), [
        "LPZh9BOjkQs",
        "dQw4w9WgXcQ",
        "JaRGJVrJBQ8"
      ]);
      const videos = await readdir(join(outDir, "videos"));
      assert.equal(videos.filter((name) => name.endsWith(".md")).length, 3);
      assert.equal(videos.filter((name) => name.endsWith(".json")).length, 3);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("batch dry-run and estimate do not require API key or call the API", async () => {
  const configDir = await tempConfigDir();
  const outDir = join(configDir, "dry-run");
  try {
    await withMockApi(async () => {
      throw new Error("API must not be called for non-spend modes");
    }, async ({ baseUrl, requests }) => {
      const dryRun = await runCli([
        "batch",
        "--out-dir",
        outDir,
        "--dry-run",
        "--minutes",
        "30",
        "https://youtu.be/LPZh9BOjkQs",
        "https://www.youtube.com/watch?v=LPZh9BOjkQs"
      ], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: undefined,
          YB_TELEMETRY: "0"
        }
      });
      assert.equal(dryRun.exitCode, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /mode: dry_run/);
      assert.match(dryRun.stdout, /estimated_billable_items: 1/);
      assert.equal(requests.length, 0);

      const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
      assert.equal(manifest.status, "planned");
      assert.equal(manifest.items[1].status, "skipped_duplicate");

      const estimate = await runCli([
        "batch",
        "--out-dir",
        join(configDir, "estimate"),
        "--estimate-credits",
        "https://youtu.be/LPZh9BOjkQs"
      ], {
        configDir,
        env: {
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: undefined,
          YB_TELEMETRY: "0"
        }
      });
      assert.equal(estimate.exitCode, 0, estimate.stderr);
      assert.match(estimate.stdout, /mode: estimate_credits/);
      assert.equal(requests.length, 0);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("batch export outputs and schema command support automation workflows", async () => {
  const configDir = await tempConfigDir();
  const outDir = join(configDir, "exports");
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        const body = JSON.parse(request.body);
        return {
          status: 201,
          body: {
            id: "sum_export",
            status: "completed",
            markdown: `# Export brief ${body.youtubeUrl}\n\nusable content`,
            billing: { billed: true, billingEventId: "bill_export", idempotencyKey: body.idempotencyKey }
          }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const env = {
        YOUTUBEBRIEF_BASE_URL: baseUrl,
        YOUTUBEBRIEF_API_KEY: "env-token"
      };
      const batch = await runCli([
        "batch",
        "--out-dir",
        outDir,
        "--combined-md",
        "--jsonl",
        "https://youtu.be/LPZh9BOjkQs"
      ], { configDir, env });
      assert.equal(batch.exitCode, 0, batch.stderr);
      assert.match(batch.stdout, /combined_md:/);
      assert.match(batch.stdout, /jsonl:/);

      const combined = await readFile(join(outDir, "combined.md"), "utf8");
      const jsonl = await readFile(join(outDir, "videos.jsonl"), "utf8");
      assert.match(combined, /# Youtubebrief Batch/);
      assert.match(jsonl, /LPZh9BOjkQs/);

      const exportStdout = await runCli(["export", "--from", outDir, "--format", "combined-md", "--output", "-"], { configDir, env });
      assert.equal(exportStdout.exitCode, 0, exportStdout.stderr);
      assert.equal(exportStdout.stdout, combined);

      const exportFile = await runCli(["export", "--from", outDir, "--format", "jsonl"], { configDir, env });
      assert.equal(exportFile.exitCode, 0, exportFile.stderr);
      assert.match(exportFile.stdout, /Wrote jsonl export/);
      assert.equal(await readFile(join(outDir, "videos.jsonl"), "utf8"), jsonl);

      const schema = await runCli(["schema", "manifest"], { configDir, env });
      assert.equal(schema.exitCode, 0, schema.stderr);
      const parsed = JSON.parse(schema.stdout);
      assert.equal(parsed.title, "Youtubebrief batch manifest");
      assert.equal(parsed.properties.schema_version.const, "1.1");
      assert.ok(parsed.properties.mode.enum.includes("single"));
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("controlled paid smoke harness exercises doctor, brief, batch, and redacted resume retry", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "yb-paid-smoke-test-"));
  const apiKey = "FAKE_YB_TEST_TOKEN_smoke_secret";
  const successUrl = "https://www.youtube.com/watch?v=LPZh9BOjkQs";
  const providerFailureUrl = "https://www.youtube.com/watch?v=JaRGJVrJBQ8";
  try {
    await withMockApi(async (request) => {
      if (request.method === "GET" && request.url === "/healthz") {
        return { body: { ok: true, service: "mock-youtubebrief" } };
      }
      if (request.method === "GET" && request.url === "/api/v1/credits") {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        return { body: { credits: 20 } };
      }
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        const body = JSON.parse(request.body);
        if (body.youtubeUrl === providerFailureUrl) {
          return {
            status: 503,
            body: {
              error: {
                message: `raw provider response: ${apiKey} stack trace internal-provider-secret`
              }
            }
          };
        }
        return {
          status: 201,
          body: {
            id: `sum_${body.youtubeUrl.slice(-4)}`,
            status: "completed",
            sourceUrl: body.youtubeUrl,
            markdown: `# Smoke brief\n\nSource: ${body.youtubeUrl}`,
            billing: body.idempotencyKey
              ? {
                  billed: true,
                  billingEventId: `bill_${body.idempotencyKey.slice(-8)}`,
                  idempotencyKey: body.idempotencyKey
                }
              : undefined
          }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl, requests }) => {
      const reportPath = join(workDir, "report.json");
      const result = await runNodeScript(SMOKE_SCRIPT, [
        "--work-dir",
        workDir,
        "--report",
        reportPath,
        "--url",
        successUrl,
        "--batch-url",
        successUrl,
        "--batch-url",
        providerFailureUrl
      ], {
        env: {
          YB_CONTROLLED_PAID_SMOKE: "1",
          YOUTUBEBRIEF_BASE_URL: baseUrl,
          YOUTUBEBRIEF_API_KEY: apiKey
        }
      });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Controlled paid smoke passed/);
      assert.doesNotMatch(result.stdout, new RegExp(apiKey));
      const reportText = await readFile(reportPath, "utf8");
      assert.doesNotMatch(reportText, new RegExp(apiKey));
      assert.doesNotMatch(reportText, /raw provider response|stack trace|internal-provider-secret/i);
      const report = JSON.parse(reportText);
      assert.equal(report.status, "passed");
      assert.equal(report.billing.succeeded, 1);
      assert.equal(report.billing.failed, 1);
      assert.equal(report.billing.billed_successes, 1);
      assert.equal(report.billing.success_only_billing, true);
      assert.equal(report.duplicate_idempotency_retry.unchanged, true);
      assert.equal(report.safety.api_key_in_argv, false);
      assert.deepEqual(report.commands.map((command) => command.name), [
        "doctor",
        "brief",
        "batch",
        "batch_resume_retry"
      ]);

      const paidPosts = requests
        .filter((request) => request.method === "POST" && request.url === "/api/v1/summaries")
        .map((request) => JSON.parse(request.body));
      const successBatchPosts = paidPosts.filter((body) => body.youtubeUrl === successUrl && body.idempotencyKey);
      assert.equal(successBatchPosts.length, 1, "already-succeeded batch item must not be dispatched again on resume");
      const failedBatchPosts = paidPosts.filter((body) => body.youtubeUrl === providerFailureUrl && body.idempotencyKey);
      assert.equal(failedBatchPosts.length, 2, "failed provider item should be retried once by resume smoke");
      assert.equal(failedBatchPosts[0].idempotencyKey, failedBatchPosts[1].idempotencyKey);
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("production-safe smoke help documents no-spend production checks", async () => {
  const help = await runNodeScript(PRODUCTION_SAFE_SMOKE_SCRIPT, ["--help"]);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /no-spend production smoke/i);
  assert.match(help.stdout, /yb doctor/);
  assert.match(help.stdout, /batch dry-run/);
  assert.match(help.stdout, /batch estimate/);
  assert.match(help.stdout, /MCP tools\/list/);
  assert.match(help.stdout, /MCP estimate_brief_cost/);
  assert.match(help.stdout, /never runs yb brief or paid batch execution/i);
  assert.doesNotMatch(help.stdout, /FAKE_YB_TEST_TOKEN_[A-Za-z0-9]+/);
});

test("batch command exit codes distinguish partial, allow-partial, and all-failed runs", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/summaries") {
        const body = JSON.parse(request.body);
        if (body.youtubeUrl.includes("dQw4w9WgXcQ")) {
          return { status: 503, body: { error: { code: "provider_error", message: "temporary provider failure" } } };
        }
        return {
          status: 201,
          body: {
            id: "sum_success",
            status: "completed",
            markdown: "# Success\n",
            billing: { billed: true, billingEventId: "bill_success" }
          }
        };
      }
      return { status: 404, body: { error: { code: "not_found", message: "missing" } } };
    }, async ({ baseUrl }) => {
      const env = {
        YOUTUBEBRIEF_BASE_URL: baseUrl,
        YOUTUBEBRIEF_API_KEY: "env-token"
      };
      const partialOut = join(configDir, "partial");
      const partial = await runCli([
        "batch",
        "--out-dir",
        partialOut,
        "--concurrency",
        "1",
        "https://youtu.be/LPZh9BOjkQs",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      ], { configDir, env });
      assert.equal(partial.exitCode, 2);
      assert.match(partial.stdout, /succeeded: 1/);
      assert.match(partial.stdout, /failed: 1/);

      const allowPartial = await runCli([
        "batch",
        "--out-dir",
        join(configDir, "partial-ok"),
        "--allow-partial",
        "--concurrency",
        "1",
        "https://youtu.be/LPZh9BOjkQs",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      ], { configDir, env });
      assert.equal(allowPartial.exitCode, 0, allowPartial.stderr);
      assert.match(allowPartial.stdout, /failed: 1/);

      const allFailed = await runCli([
        "batch",
        "--out-dir",
        join(configDir, "all-failed"),
        "--allow-partial",
        "https://example.com/not-youtube"
      ], { configDir, env });
      assert.equal(allFailed.exitCode, 1);
      assert.match(allFailed.stdout, /succeeded: 0/);
      assert.match(allFailed.stdout, /failed: 1/);

      const providerFailed = await runCli([
        "batch",
        "--out-dir",
        join(configDir, "provider-failed"),
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      ], { configDir, env });
      assert.equal(providerFailed.exitCode, 5);
      assert.match(providerFailed.stdout, /failed: 1/);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("whoami and credits gracefully handle unsupported future endpoints", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async () => ({ status: 404, body: { error: { code: "not_found", message: "missing" } } }), async ({ baseUrl }) => {
      const env = { YOUTUBEBRIEF_BASE_URL: baseUrl, YOUTUBEBRIEF_API_KEY: "env-token" };
      const whoami = await runCli(["whoami"], { configDir, env });
      assert.equal(whoami.exitCode, 0, whoami.stderr);
      assert.match(whoami.stdout, /not available yet/i);

      const credits = await runCli(["credits"], { configDir, env });
      assert.equal(credits.exitCode, 0, credits.stderr);
      assert.match(credits.stdout, /not available yet/i);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("signup honors YB_BASE_URL ahead of YOUTUBEBRIEF_BASE_URL", async () => {
  const configDir = await tempConfigDir();
  try {
    await withMockApi(async (request) => {
      if (request.method === "POST" && request.url === "/api/v1/accounts") {
        return { status: 201, body: { account: { email: "yb-env@example.com" }, apiKey: "FAKE_YB_TEST_TOKEN_env_signup" } };
      }
      return { status: 404, body: { error: { message: "missing" } } };
    }, async ({ baseUrl }) => {
      const result = await runCli(["signup", "--email", "yb-env@example.com"], {
        configDir,
        env: {
          YB_BASE_URL: baseUrl,
          YOUTUBEBRIEF_BASE_URL: "http://127.0.0.1:1"
        }
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Created account yb-env@example\.com/);
      const config = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      assert.equal(config.baseUrl, baseUrl);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("API errors map to actionable CLI messages", async () => {
  const configDir = await tempConfigDir();
  const cases = [
    [401, /not authorized|login/i],
    [402, /credits|billing/i],
    [429, /rate limited/i]
  ];
  try {
    for (const [status, pattern] of cases) {
      await withMockApi(async () => ({ status, body: { error: { code: "error", message: "server says no" } } }), async ({ baseUrl }) => {
        const result = await runCli(["brief", "https://youtu.be/LPZh9BOjkQs"], {
          configDir,
          env: { YOUTUBEBRIEF_BASE_URL: baseUrl, YOUTUBEBRIEF_API_KEY: "env-token" }
        });
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, pattern);
        assert.doesNotMatch(result.stderr, /env-token/);
      });
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("single brief API errors redact provider internals and secrets", async () => {
  const configDir = await tempConfigDir();
  const serverSecret = "FAKE_YB_TEST_TOKEN_server_secret";
  const envSecret = "FAKE_YB_TEST_TOKEN_env_token";
  const authHeader = ["Authorization:", "Bearer", envSecret].join(" ");
  try {
    await withMockApi(async () => ({
      status: 500,
      body: {
        error: {
          message: `raw provider response: ${serverSecret} stack trace ${authHeader}`
        }
      }
    }), async ({ baseUrl }) => {
      const result = await runCli(["brief", "https://youtu.be/LPZh9BOjkQs"], {
        configDir,
        env: {
          YB_BASE_URL: baseUrl,
          YB_API_KEY: envSecret
        }
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /service error/i);
      assert.doesNotMatch(result.stderr, new RegExp(`${serverSecret}|${envSecret}|raw provider response|stack trace|Bearer`, 'i'));
      assert.match(result.stderr, /\[redacted\]/);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
