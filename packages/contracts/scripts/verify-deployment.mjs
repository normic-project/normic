import {
  createPublicClient,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
} from "viem";

const ESCROW = "0xDa3ea8Cd849fF916Aa0ee6b1088F151c2Fa51C47";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const DEPLOYMENT_BLOCK = 50271033n;
const REQUIRED_FLAGS = [
  "NORMIC_FINANCIAL_EXECUTION_ENABLED",
  "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
  "NORMIC_TRADING_EXECUTION_ENABLED",
  "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
];
const abi = parseAbi([
  "function USDG() view returns (address)",
  "function CHAIN_ID() view returns (uint256)",
  "function maxPayment() view returns (uint256)",
  "function tokenDecimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function totalObligations() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function defaultAdmin() view returns (address)",
  "function defaultAdminDelay() view returns (uint48)",
]);

const env = process.env;
const client = createPublicClient({
  transport: http(env.ROBINHOOD_RPC_URL, { retryCount: 0, timeout: 15_000 }),
});
const configuredBlock = BigInt(env.NORMIC_ESCROW_DEPLOYMENT_BLOCK);
const configuredEscrow = env.NORMIC_ESCROW_ADDRESS;

const [chainId, codeAtDeployment, codeBeforeDeployment, codeLatest] =
  await Promise.all([
    client.getChainId(),
    client.getCode({ address: configuredEscrow, blockNumber: configuredBlock }),
    client.getCode({
      address: configuredEscrow,
      blockNumber: configuredBlock - 1n,
    }),
    client.getCode({ address: configuredEscrow, blockTag: "latest" }),
  ]);

const [
  usdg,
  contractChainId,
  maxPayment,
  tokenDecimals,
  paused,
  totalObligations,
  adminRole,
  resolverRole,
  defaultAdmin,
  adminDelay,
  usdgCode,
  usdgDecimals,
  usdgSymbol,
] = await Promise.all([
  client.readContract({ address: configuredEscrow, abi, functionName: "USDG" }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "CHAIN_ID",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "maxPayment",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "tokenDecimals",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "paused",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "totalObligations",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "hasRole",
    args: [zeroHash, env.ADMIN_ADDRESS],
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "hasRole",
    args: [keccak256(toHex("RESOLVER_ROLE")), env.DISPUTE_RESOLVER_ADDRESS],
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "defaultAdmin",
  }),
  client.readContract({
    address: configuredEscrow,
    abi,
    functionName: "defaultAdminDelay",
  }),
  client.getCode({ address: USDG, blockTag: "latest" }),
  client.readContract({
    address: USDG,
    abi: erc20Abi,
    functionName: "decimals",
  }),
  client.readContract({ address: USDG, abi: erc20Abi, functionName: "symbol" }),
]);

const [whole, fraction = ""] = env.MAX_SERVICE_PAYMENT_USDG.split(".");
const configuredCap =
  BigInt(whole) * 10n ** BigInt(usdgDecimals) +
  BigInt(fraction.padEnd(usdgDecimals, "0") || "0");

const checks = {
  ESCROW_RUNTIME:
    configuredEscrow.toLowerCase() === ESCROW.toLowerCase() &&
    configuredBlock === DEPLOYMENT_BLOCK &&
    codeAtDeployment &&
    codeAtDeployment !== "0x" &&
    (!codeBeforeDeployment || codeBeforeDeployment === "0x") &&
    codeLatest &&
    codeLatest !== "0x" &&
    keccak256(codeAtDeployment) ===
      env.NORMIC_ESCROW_RUNTIME_HASH.toLowerCase() &&
    keccak256(codeLatest) === env.NORMIC_ESCROW_RUNTIME_HASH.toLowerCase(),
  ESCROW_CONFIG:
    chainId === 4663 &&
    contractChainId === 4663n &&
    maxPayment === configuredCap &&
    BigInt(adminDelay) === BigInt(env.ADMIN_DELAY_SECONDS) &&
    paused === false &&
    totalObligations === 0n,
  ADMIN_ROLE:
    adminRole === true &&
    defaultAdmin.toLowerCase() === env.ADMIN_ADDRESS.toLowerCase(),
  RESOLVER_ROLE: resolverRole === true,
  USDG_BINDING:
    usdg.toLowerCase() === USDG.toLowerCase() &&
    usdgCode &&
    usdgCode !== "0x" &&
    usdgDecimals === 6 &&
    tokenDecimals === 6 &&
    usdgSymbol === "USDG",
  FINANCIAL_FLAGS: REQUIRED_FLAGS.every((name) => env[name] === "false"),
};

const configChecks = {
  CHAIN_ID: chainId === 4663 && contractChainId === 4663n,
  MAX_PAYMENT: maxPayment === configuredCap,
  ADMIN_DELAY: BigInt(adminDelay) === BigInt(env.ADMIN_DELAY_SECONDS),
  UNPAUSED: paused === false,
  NO_OBLIGATIONS: totalObligations === 0n,
};

console.log(
  JSON.stringify(
    Object.fromEntries(
      [...Object.entries(checks), ...Object.entries(configChecks)].map(
        ([name, passed]) => [name, passed ? "PASS" : "FAIL"],
      ),
    ),
  ),
);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
