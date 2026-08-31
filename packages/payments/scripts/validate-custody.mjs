import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const flags = [
  "NORMIC_FINANCIAL_EXECUTION_ENABLED",
  "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
  "NORMIC_TRADING_EXECUTION_ENABLED",
  "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
];
const failed = () => ({
  FINANCIAL_EXECUTION_DISABLED: "FAIL",
  CUSTODY_REFERENCE: "FAIL",
  PRIVY_CONNECTIVITY: "FAIL",
  PRIVY_CREDENTIALS: "FAIL",
  PRIVY_SESSION_CUSTODIAN: "FAIL",
  ALCHEMY_WALLET_API: "FAIL",
  ROBINHOOD_RPC: "FAIL",
});

// Only called by this local CLI and isolated tests. Never writes to the env file.
export async function validateCustody(env) {
  const status = failed();
  if (!flags.every((key) => env[key]?.trim() === "false")) return status;
  status.FINANCIAL_EXECUTION_DISABLED = "PASS";
  const originalFetch = globalThis.fetch;
  let rpc;
  try {
    rpc = new URL(env.ROBINHOOD_RPC_URL);
    if (rpc.protocol !== "https:" || rpc.username || rpc.password)
      rpc = undefined;
  } catch {
    // Invalid configuration remains FAIL; no URL is printed.
  }
  const readOnlyFetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const privyRead =
      request.method === "GET" &&
      url.origin === "https://api.privy.io" &&
      url.pathname === "/v1/wallets";
    let chainRead = false;
    if (rpc && request.method === "POST" && url.href === rpc.href) {
      const body = await request.clone().json();
      chainRead =
        body.method === "eth_chainId" &&
        (body.params === undefined ||
          (Array.isArray(body.params) && body.params.length === 0));
    }
    if (!privyRead && !chainRead) throw new Error("READ_ONLY_BOUNDARY");
    const response = await originalFetch(request, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (privyRead) status.PRIVY_CONNECTIVITY = "PASS";
    return response;
  };
  try {
    // Includes provider constructors: unexpected future network writes fail shut.
    globalThis.fetch = readOnlyFetch;
    const appId = env.PRIVY_APP_ID?.trim();
    const appSecret = env.PRIVY_APP_SECRET?.trim();
    if (
      env.NORMIC_CUSTODY_PROVIDER === "privy" &&
      appId &&
      env.NORMIC_CUSTODY_CREDENTIAL_REF?.trim() === `privy-app:${appId}`
    )
      status.CUSTODY_REFERENCE = "PASS";
    let chain;
    try {
      const {
        createPrivySessionCustodianFromEnvironment,
        AlchemyFinancialWallet,
        RobinhoodFinancialChain,
      } = await import("../dist/index.js");
      const custodian = createPrivySessionCustodianFromEnvironment(env);
      if (custodian) status.PRIVY_SESSION_CUSTODIAN = "PASS";
      if (rpc) {
        chain = new RobinhoodFinancialChain({ ...env, NODE_ENV: "production" });
        const wallet = new AlchemyFinancialWallet(
          chain,
          env.ALCHEMY_API_KEY?.trim(),
          custodian,
          rpc,
        );
        if (wallet.available && wallet.autonomousAvailable)
          status.ALCHEMY_WALLET_API = "PASS";
      }
    } catch {
      // SDK initialization failure must not prevent the independent HTTP check.
    }
    await Promise.all([
      (async () => {
        if (!appId || !appSecret) return;
        try {
          const response = await readOnlyFetch(
            "https://api.privy.io/v1/wallets",
            {
              method: "GET",
              headers: {
                Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`, "utf8").toString("base64")}`,
                "privy-app-id": appId,
                Accept: "application/json",
              },
            },
          );
          // HTTP 200 authenticates the app; wallet contents are not needed.
          if (response.status === 200) status.PRIVY_CREDENTIALS = "PASS";
          await response.body?.cancel();
        } catch {
          // HTTP rejection: connectivity PASS / credentials FAIL.
          // Timeout or network failure: both FAIL.
        }
      })(),
      (async () => {
        if (!chain) return;
        try {
          await chain.validateChain();
          status.ROBINHOOD_RPC = "PASS";
        } catch {
          // Wrong chain, RPC rejection, or timeout: FAIL, without raw errors.
        }
      })(),
    ]);
  } catch {
    // Missing build artifacts/dependencies also produce sanitized statuses only.
  } finally {
    globalThis.fetch = originalFetch;
  }
  return status;
}

export async function runValidation() {
  let status = failed();
  try {
    const env = parseEnv(
      await readFile(
        new URL("../../../apps/web/.env.production.local", import.meta.url),
        "utf8",
      ),
    );
    status = await validateCustody(env);
  } catch {
    // Never print file contents, URLs, secrets, provider bodies, or stack traces.
  }
  for (const [name, result] of Object.entries(status))
    console.log(`${name}: ${result}`);
  return Object.values(status).every((value) => value === "PASS") ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runValidation();
