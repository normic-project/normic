import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  erc20Abi,
  isAddress,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { compile } from "./compile.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const required = [
  "ROBINHOOD_RPC_URL",
  "DEPLOYER_RPC_URL",
  "DEPLOYER_ADDRESS",
  "ADMIN_ADDRESS",
  "DISPUTE_RESOLVER_ADDRESS",
  "ADMIN_DELAY_SECONDS",
  "MAX_SERVICE_PAYMENT_USDG",
];
async function main() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(
      JSON.stringify(
        {
          status: "BLOCKED",
          missing,
          mainnetActions: [],
          contractAddress: null,
          transactionHash: null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  for (const key of [
    "DEPLOYER_ADDRESS",
    "ADMIN_ADDRESS",
    "DISPUTE_RESOLVER_ADDRESS",
  ])
    if (!isAddress(process.env[key]) || process.env[key] === zeroAddress)
      throw new Error("Invalid explicit deployment address.");
  for (const key of ["ROBINHOOD_RPC_URL", "DEPLOYER_RPC_URL"]) {
    const u = new URL(process.env[key]);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hostname === "rpc.mainnet.chain.robinhood.com"
    )
      throw new Error(
        "Dedicated secure production RPC endpoints are required.",
      );
  }
  const read = createPublicClient({
    transport: http(process.env.ROBINHOOD_RPC_URL, { retryCount: 0 }),
  });
  const signer = createWalletClient({
    transport: http(process.env.DEPLOYER_RPC_URL, { retryCount: 0 }),
    account: process.env.DEPLOYER_ADDRESS,
  });
  if (
    (await read.getChainId()) !== 4663 ||
    Number(await signer.request({ method: "eth_chainId" })) !== 4663
  )
    throw new Error("Wrong deployment chain.");
  if (!(await read.getCode({ address: USDG })))
    throw new Error("Canonical token code missing.");
  const decimals = await read.readContract({
    address: USDG,
    abi: erc20Abi,
    functionName: "decimals",
  });
  if (
    decimals > 36 ||
    (await read.readContract({
      address: USDG,
      abi: erc20Abi,
      functionName: "symbol",
    })) !== "USDG"
  )
    throw new Error("Canonical token validation failed.");
  await read.readContract({
    address: USDG,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
  const raw = process.env.MAX_SERVICE_PAYMENT_USDG;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw))
    throw new Error("Invalid USDG cap.");
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals)
    throw new Error("USDG cap exceeds token precision.");
  const maximum =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  const delay = process.env.ADMIN_DELAY_SECONDS;
  if (
    !/^[0-9]+$/.test(delay) ||
    BigInt(delay) <= 0n ||
    BigInt(delay) >= 2n ** 48n ||
    maximum <= 0n ||
    maximum >= 2n ** 256n
  )
    throw new Error("Explicit positive risk cap and admin delay are required.");
  const result = await compile(),
    contract = result.contracts["NormicServiceEscrow.sol"].NormicServiceEscrow;
  const args = [
    process.env.ADMIN_ADDRESS,
    process.env.DISPUTE_RESOLVER_ADDRESS,
    Number(delay),
    maximum,
  ];
  const data = encodeDeployData({
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    args,
  });
  await read.call({ account: process.env.DEPLOYER_ADDRESS, data });
  if (!process.argv.includes("--broadcast")) {
    console.log(
      "Validated and simulated deployment. No transaction sent. Explicit --broadcast is required.",
    );
    return;
  }
  if (
    (await read.getChainId()) !== 4663 ||
    Number(await signer.request({ method: "eth_chainId" })) !== 4663
  )
    throw new Error("Wrong chain before broadcast.");
  await mkdir(`${root}/deployments`, { recursive: true });
  const nonce = await read.getTransactionCount({
    address: process.env.DEPLOYER_ADDRESS,
    blockTag: "pending",
  });
  const attemptPath = `${root}/deployments/attempt-4663-${process.env.DEPLOYER_ADDRESS.toLowerCase()}-${nonce}.json`;
  await writeFile(
    attemptPath,
    JSON.stringify(
      {
        status: "BROADCASTING_OR_UNKNOWN",
        chainId: 4663,
        deployer: process.env.DEPLOYER_ADDRESS,
        nonce,
        creationCodeHash: keccak256(data),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const transactionHash = await signer.sendTransaction({
    chain: null,
    data,
    nonce,
  });
  // Persist the real hash immediately: never retry deployment after an uncertain receipt.
  const reportPath = `${root}/deployments/4663-${transactionHash}.json`;
  await writeFile(
    reportPath,
    JSON.stringify(
      { status: "SUBMITTED", transactionHash, chainId: 4663 },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const receipt = await read.waitForTransactionReceipt({
    hash: transactionHash,
    timeout: 120_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Deployment reverted.");
  const address = receipt.contractAddress,
    code = await read.getCode({ address });
  if (!code) throw new Error("Deployed bytecode missing.");
  for (const [name, expected, params] of [
    ["USDG", USDG, []],
    ["maxPayment", maximum, []],
    ["paused", false, []],
    ["hasRole", true, [zeroHash, process.env.ADMIN_ADDRESS]],
    [
      "hasRole",
      true,
      [keccak256(toHex("RESOLVER_ROLE")), process.env.DISPUTE_RESOLVER_ADDRESS],
    ],
  ]) {
    const actual = await read.readContract({
      address,
      abi: contract.abi,
      functionName: name,
      args: params,
    });
    if (String(actual).toLowerCase() !== String(expected).toLowerCase())
      throw new Error("Post-deployment verification failed.");
  }
  const report = {
    status: "DEPLOYED_AWAITING_SOURCE_VERIFICATION_AND_FINALITY",
    chainId: 4663,
    address,
    transactionHash,
    block: receipt.blockNumber.toString(),
    runtimeHash: keccak256(code),
    canonicalUSDG: USDG,
    decimals,
    maxPaymentUnits: maximum.toString(),
    admin: args[0],
    resolver: args[1],
    compiler: result.compilerVersion,
    abi: contract.abi,
    standardInput: result.input,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const form = new FormData();
  form.append(
    "compiler_version",
    `v${result.compilerVersion.split(".Emscripten")[0]}`,
  );
  form.append("contract_name", "NormicServiceEscrow.sol:NormicServiceEscrow");
  form.append(
    "files[0]",
    new Blob([JSON.stringify(result.input)], { type: "application/json" }),
    "standard-input.json",
  );
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  const verification = await fetch(
    `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (verification.ok) {
    report.status = "DEPLOYED_SOURCE_VERIFICATION_SUBMITTED_AWAITING_FINALITY";
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  console.log(
    JSON.stringify(
      {
        status: report.status,
        address,
        transactionHash,
        block: report.block,
        runtimeHash: report.runtimeHash,
      },
      null,
      2,
    ),
  );
}
await main().catch(() => {
  console.error(
    "Deployment stopped. Inspect saved deployment reports before retrying. Provider errors and signing credentials are not logged.",
  );
  process.exitCode = 1;
});
