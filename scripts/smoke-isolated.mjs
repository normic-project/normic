import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const directory = await mkdtemp(join(tmpdir(), "normic-phase3-test-"));
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: "",
  PGLITE_DATA_DIR: directory,
  NORMIC_TEST_RUN_ID: crypto.randomUUID(),
  NORMIC_SMOKE_URL: origin,
  NORMIC_MCP_SMOKE_URL: `${origin}/mcp`,
  MCP_HOST: "127.0.0.1",
  MCP_PORT: String(port),
  MCP_ALLOWED_HOSTS: "",
  MCP_ALLOWED_ORIGIN_HOSTS: "",
  NORMIC_PUBLIC_ORIGIN: origin,
  NORMIC_AUTH_ISSUER: `${origin}/dev-auth`,
  NORMIC_AUTH_AUDIENCE: `${origin}/mcp`,
  NORMIC_DEV_AUTH_ENABLED: "true",
  NORMIC_AUTH_JWKS_URL: "",
  NORMIC_OWNER_AUTH_JWKS_URL: "",
  NORMIC_NETWORK: "robinhood-mainnet",
  ROBINHOOD_MAINNET_ENABLED: "true",
  NORMIC_RATE_LIMIT_PER_MINUTE: "1000",
};
let server;
let log = "";
try {
  await run("packages/db/dist-scripts/migrate.js");
  server = spawn(process.execPath, ["apps/mcp/dist/index.js"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => {
    log += String(data);
  });
  server.stderr.on("data", (data) => {
    log += String(data);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server failed: ${log}`);
    try {
      ready = (await fetch(`${origin}/health`)).ok;
    } catch {
      /* The server is still starting. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Test server did not become ready.");
  for (const script of [
    "smoke-rest",
    "smoke-mcp",
    "smoke-lifecycle",
    "smoke-security",
    "smoke-sdk",
  ])
    await run(`scripts/${script}.mjs`);
  if (/nmc_(test|dev|live)_[a-f0-9]+_/.test(log) || log.includes("DO_NOT_LOG"))
    throw new Error("A secret or sensitive payload reached structured logs.");
  console.log(
    "Isolated runtime smoke suite passed. No fixtures were written to the local or production database.",
  );
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }
  // mkdtemp owns exactly this unique test directory; never remove a configured database.
  if (!directory.startsWith(join(tmpdir(), "normic-phase3-test-")))
    throw new Error("Unexpected test directory.");
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
  await rm(`${directory}.runtime-lock`, { force: true });
}
async function run(file) {
  await readFile(file); // Fail before spawning if a required build artifact is missing.
  const child = spawn(process.execPath, [file], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${file} failed with exit code ${code}.`);
}
