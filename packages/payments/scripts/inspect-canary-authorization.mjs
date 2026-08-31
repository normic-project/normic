import postgres from "../../db/node_modules/postgres/src/index.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ESCROW = "0xDa3ea8Cd849fF916Aa0ee6b1088F151c2Fa51C47";
const LIMIT = 10_000n;
const CONFIGURE_SELECTOR = "50b893ca";
const APPROVE_SELECTOR = "095ea7b3";
const BALANCE_OF_SELECTOR = "70a08231";
const ALLOWANCE_SELECTOR = "dd62ed3e";
const APPROVED_SESSION_SELECTORS = ["0x599e1b54", "0x8c417408"];
const REQUIRED_FLAGS = [
  "NORMIC_FINANCIAL_EXECUTION_ENABLED",
  "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
  "NORMIC_TRADING_EXECUTION_ENABLED",
  "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
];

const env = process.env;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address) =>
  address.slice(2).toLowerCase().padStart(64, "0");
const configureData = (expiry) =>
  `0x${CONFIGURE_SELECTOR}${word(1n)}${word(expiry)}${word(LIMIT)}${word(LIMIT)}`;
const approveData = () =>
  `0x${APPROVE_SELECTOR}${addressWord(ESCROW)}${word(LIMIT)}`;

async function rpc(method, params) {
  const url = new URL(env.ROBINHOOD_RPC_URL);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid RPC configuration.");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("RPC unavailable.");
  const body = await response.json();
  if (body.error || typeof body.result !== "string")
    throw new Error("RPC rejected read-only request.");
  return body.result;
}

const database = postgres(env.DATABASE_URL, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
});

const failed = () => ({
  buyerReady: false,
  buyerAddress: null,
  providerDistinct: false,
  usdgSufficient: false,
  gasSufficient: false,
  approvalRequired: null,
  configureReady: false,
  grantRequestReady: false,
  sessionExpiry: null,
  privyBinding: false,
  flagsDisabled: REQUIRED_FLAGS.every((name) => env[name] === "false"),
});

try {
  const buyers = await database.unsafe(`
    SELECT DISTINCT fw.company_id, fw.address, fw.owner_address, fw.chain_id
    FROM normic_oauth_agent_grants g
    JOIN agents a ON a.id=g.agent_id AND a.status='active'
    JOIN api_credentials ac ON ac.id=g.credential_id
      AND ac.agent_id=a.id
      AND ac.revoked_at IS NULL
      AND (ac.expires_at IS NULL OR ac.expires_at>now())
    JOIN companies c ON c.id=a.company_id
    JOIN users u ON u.id=c.owner_user_id AND u.id=a.user_id
    JOIN financial_wallets fw ON fw.company_id=c.id AND fw.agent_id=a.id
    WHERE g.revoked_at IS NULL
    ORDER BY fw.company_id
  `);
  const buyer = buyers.length === 1 ? buyers[0] : null;
  if (!buyer || Number(buyer.chain_id) !== 4663) {
    const [{ count: walletCount }] = await database.unsafe(
      "SELECT count(*)::integer count FROM financial_wallets",
    );
    console.log(
      JSON.stringify({
        ...failed(),
        buyerCandidateCount: buyers.length,
        financialWalletCount: walletCount,
      }),
    );
    process.exitCode = 1;
  } else {
    const [providers, active, pending] = await Promise.all([
      database.unsafe(
        `SELECT DISTINCT fw.address
         FROM financial_wallets fw
         JOIN agents a ON a.id=fw.agent_id AND a.status='active'
         JOIN services s ON s.company_id=fw.company_id
           AND s.agent_id=a.id AND s.status='active'
         WHERE fw.company_id<>$1 AND fw.address<>$2
         ORDER BY fw.address
         LIMIT 2`,
        [buyer.company_id, buyer.address],
      ),
      database.unsafe(
        `SELECT id FROM financial_sessions
         WHERE company_id=$1 AND revoked_at IS NULL AND expires_at>now()
         LIMIT 2`,
        [buyer.company_id],
      ),
      database.unsafe(
        `SELECT public_key, signer_ref FROM financial_session_authorizations
         WHERE company_id=$1 AND consumed_at IS NULL AND expires_at>now()
         ORDER BY created_at DESC LIMIT 2`,
        [buyer.company_id],
      ),
    ]);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const configure = configureData(expiry);
    const balanceCall = `0x${BALANCE_OF_SELECTOR}${addressWord(buyer.address)}`;
    const allowanceCall = `0x${ALLOWANCE_SELECTOR}${addressWord(buyer.address)}${addressWord(ESCROW)}`;
    const [chain, usdgHex, gasHex, allowanceHex, gasPriceHex, accountCode] =
      await Promise.all([
        rpc("eth_chainId", []),
        rpc("eth_call", [{ to: USDG, data: balanceCall }, "latest"]),
        rpc("eth_getBalance", [buyer.address, "latest"]),
        rpc("eth_call", [{ to: USDG, data: allowanceCall }, "latest"]),
        rpc("eth_gasPrice", []),
        rpc("eth_getCode", [buyer.address, "latest"]),
      ]);
    const chainValid = BigInt(chain) === 4663n;
    const usdgBalance = BigInt(usdgHex);
    const gasBalance = BigInt(gasHex);
    const allowance = BigInt(allowanceHex);
    const approvalRequired = allowance < LIMIT;
    const configureGasHex = await rpc("eth_estimateGas", [
      {
        from: buyer.address,
        to: ESCROW,
        data: configure,
        value: "0x0",
      },
    ]).catch(() => null);
    const approveGasHex = approvalRequired
      ? await rpc("eth_estimateGas", [
          {
            from: buyer.address,
            to: USDG,
            data: approveData(),
            value: "0x0",
          },
        ]).catch(() => null)
      : "0x0";
    const gasEstimateAvailable =
      configureGasHex !== null && approveGasHex !== null;
    const gasUnits = gasEstimateAvailable
      ? BigInt(configureGasHex) + BigInt(approveGasHex)
      : 0n;
    const bufferedGasCost = (gasUnits * BigInt(gasPriceHex) * 13n) / 10n;
    const privyBinding = pending.length === 1 && active.length === 0;
    const grantShape = {
      chainId: "0x1237",
      expirySec: Number(expiry),
      permissions: [
        {
          type: "erc20-token-transfer",
          data: { address: USDG.toLowerCase(), allowance: "0x2710" },
        },
        {
          type: "functions-on-contract",
          data: {
            address: ESCROW.toLowerCase(),
            functions: APPROVED_SESSION_SELECTORS,
          },
        },
      ],
    };
    const grantShapeValid =
      grantShape.chainId === "0x1237" &&
      grantShape.permissions.length === 2 &&
      grantShape.permissions[0].data.allowance === "0x2710" &&
      grantShape.permissions[1].data.functions.length === 2;

    const result = {
      buyerReady:
        chainValid &&
        accountCode !== "0x" &&
        buyer.address !== buyer.owner_address,
      buyerAddress: buyer.address,
      providerDistinct: providers.length > 0,
      usdgSufficient: usdgBalance >= LIMIT,
      gasSufficient:
        gasEstimateAvailable &&
        gasBalance >= bufferedGasCost &&
        gasBalance > 0n,
      approvalRequired,
      configureReady: chainValid && configure.length === 266,
      grantRequestReady: privyBinding && grantShapeValid,
      sessionExpiry: new Date(Number(expiry) * 1000).toISOString(),
      privyBinding,
      flagsDisabled: REQUIRED_FLAGS.every((name) => env[name] === "false"),
    };
    console.log(JSON.stringify(result));
    if (
      !result.buyerReady ||
      !result.providerDistinct ||
      !result.usdgSufficient ||
      !result.gasSufficient ||
      !result.configureReady ||
      !result.flagsDisabled
    )
      process.exitCode = 1;
  }
} catch {
  console.log(JSON.stringify({ ...failed(), databaseReachable: false }));
  process.exitCode = 1;
} finally {
  await database.end({ timeout: 5 });
}
