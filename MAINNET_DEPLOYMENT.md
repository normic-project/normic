# Robinhood Mainnet deployment

Current status: **BLOCKED — not deployed.** There is no Normic escrow address, deployment transaction hash or deployed-address registry entry to report. No mainnet write has been performed.

## Required configuration

Deployment requires `ROBINHOOD_RPC_URL`, `DEPLOYER_RPC_URL`, `DEPLOYER_ADDRESS`, `ADMIN_ADDRESS`, `DISPUTE_RESOLVER_ADDRESS`, `ADMIN_DELAY_SECONDS`, and `MAX_SERVICE_PAYMENT_USDG`. Endpoints must be dedicated HTTPS mainnet infrastructure. The deployment signer must expose an authorized JSON-RPC transaction account through a secure signer; no private key is stored in this repository. Choose a multisig admin/resolver, not an implicit deployer EOA. The decimal USDG cap is converted using verified onchain token decimals.

Activation additionally requires the real `NORMIC_ESCROW_ADDRESS`, `NORMIC_ESCROW_RUNTIME_HASH`, `NORMIC_ESCROW_DEPLOYMENT_BLOCK`, `ALCHEMY_API_KEY`, production PostgreSQL/OAuth configuration, an independently reviewed SessionCustodian implementation, and explicit owner policies/authorizations. `NORMIC_FINANCIAL_EXECUTION_ENABLED=false` is the default. Flipping it alone does not connect a signer or make payments live.

## Procedure

1. Run all app/database/security/contract tests. Obtain a professional audit and resolve launch risks in SECURITY.md.
2. Verify [Robinhood mainnet configuration](https://docs.robinhood.com/chain/connecting/) and [canonical USDG](https://docs.robinhood.com/chain/contracts/) again. Expected token: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, chain 4663. Read bytecode, decimals, symbol and ERC-20 interface. Never substitute a similarly named token.
3. Run `pnpm contracts:build`. It emits ABI, bytecode, compiler version, immutable references and complete Standard JSON sources under `packages/contracts/artifacts/NormicServiceEscrow.json`.
4. Run `pnpm contracts:deploy` for validation and simulation only. Missing settings produce BLOCKED with null address/hash. No funds are sent.
5. After explicit operator approval, run `pnpm --filter @normic/contracts deploy:mainnet --broadcast`. A durable nonce/creation-code attempt marker precedes submission. Actual transaction hashes and deployment reports are written under `packages/contracts/deployments/`. Do not clear markers or retry uncertain submissions without reconciling signer nonce/chain receipts.
6. Inspect post-deployment chain ID, runtime bytecode, USDG, cap, pause state, admin and resolver. The script submits complete source input to the [Blockscout Standard JSON verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api). A submitted verification is not a verified source: check explorer completion and wait for finalized deployment before activation.
7. Pin the real deployed address, runtime hash and deployment block. Store the reviewed report in the release registry. Start a supervised `pnpm finance:reconcile` worker and alerts. Validate receipts against an independent RPC.
8. Connect and test the reviewed session custodian/Alchemy owner authorization flow, including onchain revocation, exact approval and cap enforcement. No automatic owner approval or unrestricted permission is permitted.
9. Only with a deliberately funded, explicitly authorized low-value QA wallet, perform the real lifecycle. Do not transfer funds merely to make checks pass.

Source verification, deployment and funded QA are not claimed as completed. Existing artifacts contain no invented deployed address or transaction hash. Sites hosting is not an automatic deployment target for this Node/PostgreSQL/MCP runtime; production hosting must preserve those server/database requirements rather than replacing them with a simulated static site.
