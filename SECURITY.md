# Security status

The Phase 4 escrow and Phase 5 Stock Token trading architecture are **not externally audited**. Internal tests, compiler checks and threat reviews are not professional audits. Mainnet financial/trading activation is blocked pending deployment, real eligibility/custody/venue/oracle infrastructure, independent review and explicit owner authorization.

## Production launch requirements

- External OAuth/JWKS and verified owner identities; no development authentication.
- PostgreSQL with backups, restore drills, least-privileged server roles, no browser/anonymous grants on finance tables, and restricted migration credentials.
- Dedicated Robinhood Mainnet archive RPC, pinned deployment bytecode/parameters, verified Blockscout source, finalized receipt tracking and monitored reconciliation.
- Explicit multisig admin/resolver, admin transfer delay and maximum USDG payment. No implicit deployer admin or default monetary cap.
- Reviewed secure session custodian, full user-operation decoding/hash verification and owner grant verification. No root private key in Normic. No unrestricted sign-hash service.
- Owner-set session expiry, per-transaction/day limits and exact escrow selectors; zero native value. Token approvals remain owner-only and exact/minimal. Do not grant `fund`, `configureSpending`, root, arbitrary transfer, deployment, bridge or Stock Token permissions to agents.
- Professional contract audit, account-abstraction integration audit, abuse controls, production alerts and incident runbooks before funding a launch.
- Reviewed owner-bound eligibility provider; versioned canonical asset/oracle maps; independently verified 0x chain-4663 target, spender and source allowlists; separate trading custodian; and low-value Stock Token QA authorization.
- Earned-capital provenance and FIFO/journal reconciliation monitoring. Owner, external and unattributed transfers must never enter autonomous investable capital.

## Escrow controls

Canonical USDG only, chain-bound invocation IDs and immutable terms, strict terminal states, SafeERC20, ReentrancyGuard, Pausable, delayed admin transfer, explicit resolver role and immutable payment cap. No upgrades, sweep, protocol token or arbitrary external call function. Disputed funds require resolver action; pause blocks new funds and releases but leaves refund/dispute remedies available.

ERC-20 transfers are permissionless. Therefore the enforceable invariant is `token balance >= unsettled obligations`, with equality in the absence of unsolicited donations. Donated surplus is quarantined and cannot be swept. Claiming unconditional equality would be false. Canonical USDG issuer pause/blacklist/upgrade risks remain external dependencies.

## Incident handling

Disable new financial and trading execution, revoke local sessions, and independently revoke wallet/escrow permissions and ERC-20 allowances from the owner wallet. A local revoke cannot erase an already submitted transaction or revoke a leaked signature onchain. Investigate unknown submissions by existing call ID/receipt and wallet nonce; never clear the operation marker and rebroadcast blindly. A finalized block-hash, balance-delta, canonical-asset, oracle, or eligibility disagreement halts reconciliation for operator investigation; do not rewrite posted history.

Logs use allowlisted event names/IDs and sanitized public errors, never provider URLs with credentials, token values, raw job content or signatures. The signing service must enforce the same controls. Configure infrastructure log redaction and retention independently. Use private disclosure channels established by the deployment operator; no public security contact is invented in this repository.
