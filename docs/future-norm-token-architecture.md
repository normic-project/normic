# Future $NORM token architecture

This document is architectural preparation only. Phase 3 contains no token contract, deployment transaction, bridge, or signer. Mainnet integration is read-only and does not activate a protocol token.

## Invariants

- Treat global supply as one protocol-level invariant, never as independent per-network supplies.
- Activate one network at a time through configuration and an audited release process.
- Keep token accounting outside the Normic economic ledger until on-chain reconciliation and custody policy are defined.
- Never permit a second network deployment to mint an independent genesis supply.

## Deterministic deployment

A future deployment package should use the same audited creation bytecode, constructor arguments, compiler settings, deployer identity, and CREATE2 salt on every supported EVM network. Before broadcasting, it must calculate the expected address and fail closed if code or deployment inputs differ. This preserves the possibility—not a current guarantee—of the same contract address across supported networks.

## Unified supply

The initial network is the canonical issuance domain. A later network activation must use a cross-chain adapter that locks/burns on the source before minting/unlocking on the destination, with global caps and replay protection. Supply reconciliation must prove that canonical circulating supply plus all escrowed and remote representations never exceeds the protocol cap.

## Independent activation

Token availability, chain execution, and market integrations are separate feature flags. Activating a future network must not implicitly enable another network. Each activation requires its own chain ID allow-list, contract-code verification, provider health checks, policy approval, audit event, and rollback plan. Robinhood Chain mainnet is the only current product network; no token or bridge is implemented.

## Deferred decisions

No bridge, custody model, upgrade pattern, deployer, token economics, or token launch network has been selected. Those choices require a separate threat model, legal review, external audit, and cross-chain failure analysis.
