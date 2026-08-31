// Operator preparation only. Default is read-only; --prepare-signers permits
// only dedicated Privy policy/signer creation and its immutable audit binding.
// No owner authentication is fabricated and no signing/submission API is used.
import { createHash } from "node:crypto";
import { createRuntimeDatabase, PostgresFinancialRepository } from "@normic/db";
import {
  AlchemyFinancialWallet,
  RobinhoodFinancialChain,
  createPrivySessionCustodianFromEnvironment,
} from "../dist/index.js";
import { formatEther, formatUnits } from "viem";

const addresses = {
  buyer: "0x357e143fc3979c55bb2903112d759f95444c9edc",
  provider: "0x3ead4b6455ed8eb3d2babccb730a44e192b71a39",
};
const flags = [
  "NORMIC_FINANCIAL_EXECUTION_ENABLED",
  "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
  "NORMIC_TRADING_EXECUTION_ENABLED",
  "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
];
const prepareSigners = process.argv.slice(2).includes("--prepare-signers");
let db,
  stage = "CONFIGURATION";
try {
  if (
    process.argv.slice(2).some((a) => a !== "--prepare-signers") ||
    !process.env.DATABASE_URL ||
    !flags.every((f) => process.env[f] === "false")
  )
    throw new Error();
  db = await createRuntimeDatabase({ allowPglite: false });
  stage = "REAL_IDENTITIES";
  const participants = await db.transaction(async (sql) => {
    await sql.query("SET TRANSACTION READ ONLY");
    const result = {};
    for (const [role, address] of Object.entries(addresses)) {
      const rows = await sql.query(
        `SELECT fw.data wallet,r.data root,
        k.credential_id,k.public_key_x,k.public_key_y,k.rp_id,k.validation_entity_id,
        EXISTS (SELECT 1 FROM api_credentials ac JOIN normic_oauth_agent_grants g ON g.credential_id=ac.id AND g.agent_id=a.id
          JOIN normic_oauth_clients oc ON oc.client_id=g.oauth_client_id AND oc.enabled AND oc.allow_dynamic_clients
          WHERE ac.agent_id=a.id AND ac.revoked_at IS NULL AND (ac.expires_at IS NULL OR ac.expires_at>now())
          AND ac.last_used_at IS NOT NULL AND g.revoked_at IS NULL AND g.supabase_user_id::text=u.auth_subject
          AND oc.audience=ac.audience AND oc.audience='https://normic.tech/mcp') mcp_connected
        FROM financial_wallets fw JOIN companies c ON c.id=fw.company_id
        JOIN agents a ON a.id=c.primary_agent_id AND a.id=fw.agent_id AND a.status='active' AND a.user_id=c.owner_user_id
        JOIN users u ON u.id=c.owner_user_id JOIN auth.users au ON au.id::text=u.auth_subject AND au.email_confirmed_at IS NOT NULL
        JOIN financial_root_bindings r ON r.id=fw.root_binding_id AND r.owner_user_id=u.id AND r.company_id=c.id AND r.status='provisioned'
        JOIN financial_webauthn_credentials k ON k.root_binding_id=r.id AND k.purpose='primary' AND k.revoked_at IS NULL
        WHERE lower(fw.address)=$1`,
        [address],
      );
      if (rows.length !== 1 || !rows[0].mcp_connected) throw new Error();
      result[role] = rows[0];
    }
    if (
      result.buyer.wallet.companyId === result.provider.wallet.companyId ||
      result.buyer.root.ownerUserId === result.provider.root.ownerUserId
    )
      throw new Error();
    return result;
  });
  const chain = new RobinhoodFinancialChain(process.env);
  stage = "ESCROW";
  await chain.validateEscrow({ requireExecution: false });
  const custodian = createPrivySessionCustodianFromEnvironment(process.env, {
    allowSignerCreation: prepareSigners,
  });
  if (!custodian) throw new Error();
  const verified = {};
  // Verify BOTH roots before any Privy mutation.
  for (const [role, record] of Object.entries(participants)) {
    stage = `${role.toUpperCase()}_ROOT`;
    const { wallet, root } = record;
    const publicKey = `0x${Buffer.from(record.public_key_x, "base64url").toString("hex")}${Buffer.from(record.public_key_y, "base64url").toString("hex")}`;
    if (
      wallet.address.toLowerCase() !== addresses[role] ||
      wallet.chainId !== 4663 ||
      wallet.walletType !== "erc4337-mav2-webauthn" ||
      root.accountSalt !== "0" ||
      record.rp_id !== "normic.tech" ||
      record.validation_entity_id !== 0 ||
      root.rootIdentity !==
        `webauthn-p256:${createHash("sha256")
          .update(Buffer.from(publicKey.slice(2), "hex"))
          .digest("hex")}`
    )
      throw new Error();
    const adapter = new AlchemyFinancialWallet(
      chain,
      process.env.ALCHEMY_API_KEY,
      custodian,
      process.env.ROBINHOOD_RPC_URL,
    );
    const derived = await adapter.provisionWebAuthnAccount({
      credentialId: record.credential_id,
      publicKey,
      rpId: "normic.tech",
      validationEntityId: 0,
      salt: "0",
    });
    if (derived.address.toLowerCase() !== addresses[role] || derived.deployed)
      throw new Error();
    verified[role] = {
      adapter,
      credential: {
        rootBindingId: root.id,
        credentialId: record.credential_id,
        publicKeyX: record.public_key_x,
        publicKeyY: record.public_key_y,
        rpId: record.rp_id,
        validationEntityId: 0,
        purpose: "primary",
        revokedAt: null,
      },
    };
  }
  const summaries = {};
  for (const [role, record] of Object.entries(participants)) {
    stage = `${role.toUpperCase()}_SIGNER`;
    const input = {
      companyId: record.wallet.companyId,
      policyVersion: 1,
      idempotencyKey: `webauthn-canary:${record.root.id}`,
    };
    const repo = new PostgresFinancialRepository(db);
    let binding;
    if (prepareSigners) {
      binding = await repo.transaction(async (tx) => {
        await tx.lockCompany(input.companyId);
        const actor = "operator:phase4-canary-preparation",
          operation = "financial.canary_signer_prepared";
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify({
              role,
              wallet: record.wallet.address,
              root: record.root.id,
            }),
          )
          .digest("hex");
        stage = `${role.toUpperCase()}_SIGNER_JOURNAL`;
        const claim = await tx.claim(
          actor,
          operation,
          input.idempotencyKey,
          requestHash,
        );
        // Even a replay rechecks current remote policy and export/archival state.
        stage = `${role.toUpperCase()}_PRIVY_SIGNER`;
        const signer = await custodian.createSigner(input);
        if (
          claim.replay &&
          (claim.response.signerRef !== signer.signerRef ||
            claim.response.publicKey !== signer.publicKey)
        )
          throw new Error();
        if (!claim.replay) {
          stage = `${role.toUpperCase()}_SIGNER_AUDIT`;
          await tx.audit(operation, input.companyId, null, actor, {
            role,
            publicKey: signer.publicKey,
          });
          await tx.complete(actor, operation, input.idempotencyKey, signer);
        }
        return signer;
      });
    } else binding = await custodian.createSigner(input); // lookup-only transport, creation disabled
    if (
      binding.signerRef === process.env.PRIVY_DEPLOYER_WALLET_ID ||
      Object.values(addresses).includes(binding.publicKey) ||
      binding.publicKey.toLowerCase() ===
        process.env.DEPLOYER_ADDRESS?.toLowerCase()
    )
      throw new Error();
    stage = `${role.toUpperCase()}_UNSIGNED_PREPARATION`;
    const review = await verified[role].adapter.prepareWebAuthnCanary({
      wallet: record.wallet,
      credential: verified[role].credential,
      preparedAt: Math.floor(Date.now() / 1000),
      prepareSessionSigner: true,
      role,
    });
    if (review.sessionPublicKey !== binding.publicKey) throw new Error();
    const complete = review.gas.requiredWei;
    summaries[role] = {
      address: addresses[role],
      root: "VERIFIED_DIRECT_WEBAUTHN",
      deployed: review.deployed,
      signer: "BOUND_EXPORT_DENIED_PERSONAL_SIGN_ONLY",
      sessionInstalled: false,
      usdg: formatUnits(BigInt(review.usdgBalance), 6),
      eth: formatEther(BigInt(review.ethBalanceWei)),
      usdgRequired:
        role === "buyer"
          ? formatUnits(
              BigInt(review.usdgBalance) < 10000n
                ? 10000n - BigInt(review.usdgBalance)
                : 0n,
              6,
            )
          : "0",
      ownerSetupEthWith30PercentBuffer: complete
        ? formatEther(BigInt(complete))
        : null,
      completeLifecycleEth: null,
      gas: review.gas,
      lifecycleGas: review.lifecycleGas,
      approvalRequired: review.approvalRequired,
      ownerCalls: review.ownerCalls.length,
      sessionFunctions: review.sessionPolicy.functions,
      cumulativeAllowance: review.sessionPolicy.cumulativeAllowance,
      expiresAt: review.expiresAt,
      revocationPrepared: review.ownerRevocationCalls.length === 1,
      userOperationPrepared: review.unsignedUserOperation !== null,
    };
  }
  stage = "SERVICE";
  const services = await db.query(
    "SELECT id FROM services WHERE company_id=$1 AND agent_id=$2 AND status='active' AND pricing_model='fixed' AND quoted_currency='USDG' AND quoted_price='0.01'",
    [
      participants.provider.wallet.companyId,
      participants.provider.wallet.agentId,
    ],
  );
  const [counts] = await db.query(
    `SELECT
    (SELECT count(*)::int FROM financial_sessions WHERE company_id IN ($1,$2) AND revoked_at IS NULL) active_sessions,
    (SELECT count(*)::int FROM financial_idempotency WHERE operation='financial.canary_signer_prepared' AND actor='operator:phase4-canary-preparation' AND response IS NOT NULL) operator_signer_bindings,
    (SELECT count(*)::int FROM audit_events WHERE type='financial.canary_signer_prepared' AND company_id IN ($1,$2)) signer_audit_events`,
    [
      participants.buyer.wallet.companyId,
      participants.provider.wallet.companyId,
    ],
  );
  console.log(
    JSON.stringify({
      ...summaries,
      distinct: true,
      counts,
      serviceIds: services.map((s) => s.id),
      service: services.length
        ? "READY"
        : "PROVIDER_AUTHENTICATED_PUBLISH_REQUIRED",
      sponsorship: "NOT_CONFIGURED_IN_RUNTIME",
      financialFlags: "DISABLED",
      transactionsSent: 0,
      usdgMoved: "0",
      signaturesRequested: 0,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      state: "BLOCKED",
      stage,
      code: [
        "EACCES",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "ENETUNREACH",
        "FINANCIAL_UNAVAILABLE",
        "23514",
        "23505",
        "42501",
      ].includes(error?.code)
        ? error.code
        : "VALIDATION_UNAVAILABLE",
      transactionsSent: 0,
    }),
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
