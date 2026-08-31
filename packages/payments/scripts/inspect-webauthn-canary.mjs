// Read-only production inspection. Never signs, creates wallets or submits transactions.
import postgres from "../../db/node_modules/postgres/src/index.js";
import { createHash } from "node:crypto";
import { erc20Abi, formatEther, formatUnits } from "viem";
import {
  AlchemyFinancialWallet,
  RobinhoodFinancialChain,
} from "../dist/index.js";
import { CANONICAL_USDG } from "@normic/core";

const env = process.env;
const BUYER = "0x357e143fc3979c55bb2903112d759f95444c9edc";
const ESCROW = "0xda3ea8cd849ff916aa0ee6b1088f151c2fa51c47";
const flags = [
  "NORMIC_FINANCIAL_EXECUTION_ENABLED",
  "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
  "NORMIC_TRADING_EXECUTION_ENABLED",
  "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
];
let database;
let stage = "CONFIGURATION";
try {
  if (!env.DATABASE_URL || !flags.every((name) => env[name] === "false"))
    throw new Error();
  database = postgres(env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
  });
  stage = "DATABASE";
  const state = await database.begin(async (sql) => {
    await sql.unsafe("SET TRANSACTION READ ONLY");
    const buyers = await sql.unsafe(
      `SELECT fw.data wallet,r.data root,
      k.credential_id,k.public_key_x,k.public_key_y,k.rp_id,k.validation_entity_id,
      EXISTS (SELECT 1 FROM api_credentials ac
        JOIN normic_oauth_agent_grants g ON g.credential_id=ac.id AND g.agent_id=a.id
        JOIN normic_oauth_clients oc ON oc.client_id=g.oauth_client_id AND oc.enabled AND oc.allow_dynamic_clients
        WHERE ac.agent_id=a.id AND ac.revoked_at IS NULL AND (ac.expires_at IS NULL OR ac.expires_at>now())
        AND ac.last_used_at IS NOT NULL AND g.revoked_at IS NULL
        AND g.supabase_user_id::text=u.auth_subject AND oc.audience=ac.audience
        AND oc.audience='https://normic.tech/mcp') mcp_connected
      FROM financial_wallets fw JOIN companies c ON c.id=fw.company_id
      JOIN agents a ON a.id=c.primary_agent_id AND a.id=fw.agent_id AND a.status='active' AND a.user_id=c.owner_user_id
      JOIN users u ON u.id=c.owner_user_id JOIN auth.users au ON au.id::text=u.auth_subject AND au.email_confirmed_at IS NOT NULL
      JOIN financial_root_bindings r ON r.id=fw.root_binding_id AND r.owner_user_id=u.id AND r.company_id=c.id AND r.status='provisioned'
      JOIN financial_webauthn_credentials k ON k.root_binding_id=r.id AND k.purpose='primary' AND k.revoked_at IS NULL
      WHERE lower(fw.address)=$1`,
      [BUYER],
    );
    if (buyers.length !== 1 || !buyers[0].mcp_connected) throw new Error();
    const buyer = buyers[0];
    const providers = await sql.unsafe(
      `SELECT fw.address,
      EXISTS (SELECT 1 FROM services s WHERE s.company_id=fw.company_id AND s.agent_id=fw.agent_id AND s.status='active'
        AND s.pricing_model='fixed' AND s.quoted_currency='USDG' AND s.quoted_price='0.01') has_canary_service
      FROM financial_wallets fw JOIN companies c ON c.id=fw.company_id
      JOIN agents a ON a.id=fw.agent_id AND a.status='active'
      WHERE fw.company_id<>$1 AND c.owner_user_id<>$2 AND lower(fw.address)<>$3`,
      [buyer.wallet.companyId, buyer.root.ownerUserId, BUYER],
    );
    const [counts] = await sql.unsafe(
      `SELECT
      (SELECT count(*)::int FROM financial_wallets) wallets,
      (SELECT count(*)::int FROM financial_session_authorizations WHERE company_id=$1) session_requests,
      (SELECT count(*)::int FROM financial_sessions WHERE company_id=$1 AND revoked_at IS NULL) sessions`,
      [buyer.wallet.companyId],
    );
    return { buyer, providers, counts };
  });
  stage = "MAINNET";
  const chain = new RobinhoodFinancialChain(env);
  const escrow = await chain.validateEscrow({ requireExecution: false });
  const token = await chain.validateToken();
  if (escrow.address.toLowerCase() !== ESCROW || token.decimals !== 6)
    throw new Error();
  const { buyer, providers, counts } = state;
  if (
    buyer.wallet.address.toLowerCase() !== BUYER ||
    buyer.wallet.chainId !== 4663 ||
    buyer.root.accountSalt !== "0" ||
    buyer.rp_id !== "normic.tech" ||
    buyer.validation_entity_id !== 0
  )
    throw new Error();
  const publicKey = `0x${Buffer.from(buyer.public_key_x, "base64url").toString("hex")}${Buffer.from(buyer.public_key_y, "base64url").toString("hex")}`;
  if (
    buyer.root.rootIdentity !==
    `webauthn-p256:${createHash("sha256")
      .update(Buffer.from(publicKey.slice(2), "hex"))
      .digest("hex")}`
  )
    throw new Error();
  // This adapter method only reads/derives; it never registers or persists a wallet.
  const derived = await new AlchemyFinancialWallet(
    chain,
    env.ALCHEMY_API_KEY,
    undefined,
    env.ROBINHOOD_RPC_URL,
  ).provisionWebAuthnAccount({
    credentialId: buyer.credential_id,
    publicKey,
    rpId: "normic.tech",
    validationEntityId: 0,
    salt: "0",
  });
  if (derived.address.toLowerCase() !== BUYER) throw new Error();
  const [usdg, eth, allowance, gasPrice, entryPoints] = await Promise.all([
    chain.client.readContract({
      address: CANONICAL_USDG,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [BUYER],
    }),
    chain.client.getBalance({ address: BUYER }),
    chain.client.readContract({
      address: CANONICAL_USDG,
      abi: erc20Abi,
      functionName: "allowance",
      args: [BUYER, ESCROW],
    }),
    chain.client.getGasPrice(),
    chain.client
      .request({ method: "eth_supportedEntryPoints", params: [] })
      .catch(() => null),
  ]);
  const review = await new AlchemyFinancialWallet(
    chain,
    env.ALCHEMY_API_KEY,
    undefined,
    env.ROBINHOOD_RPC_URL,
  ).prepareWebAuthnCanary({
    wallet: buyer.wallet,
    preparedAt: Math.floor(Date.now() / 1000),
    prepareSessionSigner: false,
    credential: {
      rootBindingId: buyer.root.id,
      credentialId: buyer.credential_id,
      publicKeyX: buyer.public_key_x,
      publicKeyY: buyer.public_key_y,
      rpId: buyer.rp_id,
      validationEntityId: buyer.validation_entity_id,
      purpose: "primary",
      revokedAt: null,
    },
  });
  console.log(
    JSON.stringify({
      buyer: BUYER,
      buyerRoot: "VERIFIED_COUNTERFACTUAL_DERIVATION",
      mcpConnected: true,
      deployed: derived.deployed,
      chainId: 4663,
      escrow: "PASS",
      usdg: formatUnits(usdg, 6),
      eth: formatEther(eth),
      allowanceUnits: allowance.toString(),
      approvalRequired: allowance < 10000n,
      usdgDeficit: formatUnits(usdg < 10000n ? 10000n - usdg : 0n, 6),
      gasPriceWei: gasPrice.toString(),
      bundlerAvailable:
        Array.isArray(entryPoints) &&
        entryPoints.some(
          (p) =>
            p.toLowerCase() === "0x0000000071727de22e5e9d8baf0edac6f37da032",
        ),
      sponsorship: "NOT_IMPLEMENTED_OR_CONFIGURED",
      gas: review.gas,
      expiresAt: review.expiresAt,
      ownerCallCount: review.ownerCalls.length,
      unsignedUserOperationPrepared: review.unsignedUserOperation !== null,
      providers,
      counts,
      flagsDisabled: true,
      transactionsSent: 0,
      signerCreated: false,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      state: "BLOCKED",
      stage,
      code: ["EACCES", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH"].includes(
        error?.code,
      )
        ? error.code
        : "VALIDATION_UNAVAILABLE",
      transactionsSent: 0,
    }),
  );
  process.exitCode = 1;
} finally {
  await database?.end({ timeout: 5 });
}
