import { PrivyClient } from "@privy-io/node";
import { formatViemTransaction } from "@privy-io/node/viem";
import {
  getAddress,
  isAddress,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  zeroAddress,
} from "viem";
import { toAccount } from "viem/accounts";

// Privy 0.34.0's viem formatter omits numeric zero values. Keep its wire format,
// but preserve explicitly supplied nonce/quantities in this deployment-only path.
export function formatDeploymentTransaction(transaction) {
  const formatted = formatViemTransaction(transaction);
  if (transaction.nonce != null) formatted.nonce = transaction.nonce;
  for (const [input, output] of [
    ["value", "value"],
    ["gas", "gas_limit"],
    ["gasPrice", "gas_price"],
    ["maxFeePerGas", "max_fee_per_gas"],
    ["maxPriorityFeePerGas", "max_priority_fee_per_gas"],
  ])
    if (transaction[input] != null)
      formatted[output] = toHex(transaction[input]);
  return formatted;
}

export function signingRequestDiagnostic(transaction) {
  return {
    event: "PRIVY_DEPLOYMENT_SIGN_REQUEST",
    method: "eth_signTransaction",
    chain4663: transaction.chain_id === 4663,
    contractCreation: transaction.to == null,
    noncePresent: transaction.nonce != null,
    nonceZero: transaction.nonce === 0,
    gasLimitPresent: transaction.gas_limit != null,
    maxFeePerGasPresent: transaction.max_fee_per_gas != null,
    maxPriorityFeePerGasPresent: transaction.max_priority_fee_per_gas != null,
    maxPriorityFeePerGasZero: transaction.max_priority_fee_per_gas === "0x0",
    valueZero: (transaction.value ?? "0x0") === "0x0",
  };
}

export function signingErrorDiagnostic(error) {
  const allowedTypes = [
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
    "RateLimitError",
    "InternalServerError",
    "APIConnectionError",
    "APIConnectionTimeoutError",
  ];
  const type = error?.constructor?.name;
  return {
    event: "PRIVY_DEPLOYMENT_SIGN_FAILED",
    method: "eth_signTransaction",
    errorType: allowedTypes.includes(type) ? type : "UNCLASSIFIED",
    httpStatus:
      Number.isInteger(error?.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? error.status
        : null,
  };
}

export async function validateSignedDeploymentTransaction(
  signedTransaction,
  expected,
  deployerAddress,
) {
  const fail = (reason) => {
    const error = new Error(
      "Privy signed deployment envelope does not match preflight.",
    );
    error.reason = reason;
    throw error;
  };
  if (
    typeof signedTransaction !== "string" ||
    !/^0x[0-9a-f]+$/i.test(signedTransaction)
  )
    fail("INVALID_ENVELOPE");
  let parsed, recovered;
  try {
    parsed = parseTransaction(signedTransaction);
    recovered = await recoverTransactionAddress({
      serializedTransaction: signedTransaction,
    });
  } catch {
    fail("UNPARSABLE_OR_INVALID_SIGNATURE");
  }
  if (parsed.type !== "eip1559") fail("TYPE_MISMATCH");
  if (parsed.chainId !== 4663) fail("CHAIN_ID_MISMATCH");
  if (parsed.nonce !== expected.nonce) fail("NONCE_MISMATCH");
  if (parsed.data !== expected.data) fail("DATA_MISMATCH");
  if (parsed.to != null) fail("NOT_CONTRACT_CREATION");
  if ((parsed.value ?? 0n) !== (expected.value ?? 0n)) fail("VALUE_MISMATCH");
  if (parsed.gas !== expected.gas) fail("GAS_MISMATCH");
  if (parsed.maxFeePerGas !== expected.maxFeePerGas) fail("MAX_FEE_MISMATCH");
  // RLP encodes integer zero as an empty byte string, which Viem parses as an
  // omitted optional field. Treat omitted and 0n as the same canonical value.
  if (
    (parsed.maxPriorityFeePerGas ?? 0n) !==
    (expected.maxPriorityFeePerGas ?? 0n)
  )
    fail("MAX_PRIORITY_FEE_MISMATCH");
  if (getAddress(recovered) !== getAddress(deployerAddress))
    fail("SIGNER_MISMATCH");
  return {
    event: "PRIVY_DEPLOYMENT_SIGNED_TRANSACTION_VALIDATED",
    type: "eip1559",
    chain4663: true,
    contractCreation: true,
    nonceMatch: true,
    gasMatch: true,
    feesMatch: true,
    signerMatch: true,
  };
}

export function assertExecutionDisabled(env) {
  for (const key of [
    "NORMIC_FINANCIAL_EXECUTION_ENABLED",
    "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
    "NORMIC_TRADING_EXECUTION_ENABLED",
    "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
  ])
    if (env[key]?.trim() !== "false")
      throw new Error(
        "Deployment requires all financial execution flags false.",
      );
}

// Deployment-only adapter. Never reuse or broaden a financial SessionCustodian.
export async function getPrivyDeployer(env) {
  assertExecutionDisabled(env);
  const appId = env.PRIVY_APP_ID?.trim();
  const appSecret = env.PRIVY_APP_SECRET?.trim();
  const walletId = env.PRIVY_DEPLOYER_WALLET_ID?.trim();
  const address = env.DEPLOYER_ADDRESS;
  if (
    !appId ||
    !appSecret ||
    !walletId ||
    !isAddress(address ?? "") ||
    address === zeroAddress
  )
    throw new Error("Explicit Privy deployer configuration is required.");
  const client = new PrivyClient({
    appId,
    appSecret,
    apiUrl: "https://api.privy.io",
    logLevel: "off",
    maxRetries: 0,
    timeout: 15_000,
  });
  const verify = async () => {
    const wallet = await client.wallets().get(walletId);
    if (
      wallet.id !== walletId ||
      wallet.chain_type !== "ethereum" ||
      !isAddress(wallet.address ?? "") ||
      getAddress(wallet.address) !== getAddress(address) ||
      wallet.exported_at !== null ||
      wallet.imported_at !== null ||
      wallet.archived_at != null ||
      wallet.owner_id !== null ||
      wallet.external_id?.startsWith("normic_") ||
      wallet.display_name === "Normic USDG session signer"
    )
      throw new Error(
        "Privy deployer binding or wallet authorization is invalid.",
      );
  };
  await verify(); // Read-only; no wallet creation or signing during preflight.
  return {
    verify,
    accountForDeployment(data, read, broadcast) {
      if (broadcast !== true)
        throw new Error("Explicit --broadcast is required.");
      const denied = async () => {
        throw new Error("Deployment-only signer.");
      };
      return toAccount({
        address: getAddress(address),
        signMessage: denied,
        signTypedData: denied,
        async signTransaction(transaction) {
          assertExecutionDisabled(env);
          if (
            transaction.chainId !== 4663 ||
            transaction.data !== data ||
            transaction.to != null ||
            (transaction.value ?? 0n) !== 0n ||
            transaction.authorizationList !== undefined
          )
            throw new Error("Unexpected deployment transaction.");
          if ((await read.getChainId()) !== 4663)
            throw new Error("Wrong deployment chain.");
          await verify(); // Recheck binding immediately before Privy signs.
          const formatted = formatDeploymentTransaction(transaction);
          console.error(JSON.stringify(signingRequestDiagnostic(formatted)));
          let signedTransaction;
          try {
            // Same official RPC as createViemAccount; bypass only its lossy formatter.
            const { signed_transaction } = await client
              .wallets()
              .ethereum()
              .signTransaction(walletId, {
                params: { transaction: formatted },
              });
            signedTransaction = signed_transaction;
          } catch (error) {
            // Provider messages/causes/headers may contain credentials or signed bytes.
            console.error(JSON.stringify(signingErrorDiagnostic(error)));
            throw new Error(
              "Privy deployment signing failed; see sanitized diagnostic.",
            );
          }
          try {
            console.error(
              JSON.stringify(
                await validateSignedDeploymentTransaction(
                  signedTransaction,
                  transaction,
                  address,
                ),
              ),
            );
            console.error(
              JSON.stringify({ event: "PRIVY_DEPLOYMENT_SIGN_SUCCEEDED" }),
            );
            return signedTransaction;
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "PRIVY_DEPLOYMENT_SIGNED_TRANSACTION_REJECTED",
                reason: error?.reason ?? "UNCLASSIFIED",
              }),
            );
            throw new Error(
              "Privy signed deployment transaction failed validation.",
            );
          }
        },
      });
    },
  };
}
