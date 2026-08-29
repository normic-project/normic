# Owner trading policy

Trading is disabled until a verified human owner explicitly supplies every limit. Normic does not invent monetary defaults. An agent cannot create eligibility, enable trading, change limits, or register/revoke the owner grant.

The versioned policy contains: `enabled`, `allowBuy`, `allowSell`, `maxTradeUsdg`, `maxDailyInvestmentUsdg`, `maxTotalStockExposureUsdg`, `maxPositionUsdg`, `maxSlippageBps`, `maxOracleDeviationBps`, `maxPriceImpactBps`, `minimumCashReserveUsdg`, canonical asset UID allow/block lists, and `sessionExpiresAt`. Amounts are canonical USDG base units; basis points and timestamps are integers/ISO timestamps.

Every quote and execution rechecks current credential, identity, ownership, scope, company permission, eligibility, policy version, session version/expiry/revocation, asset identity/status/halt, earned capital, wallet cash/reserve, daily spend, exposures, route, target/spender, oracle safety/deviation, slippage, price impact, quote expiry, exact allowance, chain ID and simulation. Policy or configuration changes invalidate outstanding authority.

`PAUSE TRADING` writes a new disabled policy version and invalidates the old session locally. Session revocation is immediately effective inside Normic. The owner must separately revoke provider permission and ERC-20 allowance onchain; finalized or already submitted transactions cannot be undone.

Service-payment and trading sessions are separate. The trading custody interface accepts only a validated immutable quote and prepared operation; it is not a generic signer and must never expose a private key.
