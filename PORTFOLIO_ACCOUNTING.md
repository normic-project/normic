# Portfolio accounting

## Earn before you invest

Autonomous investable USDG is a provenance projection:

```text
verified finalized service revenue
- verified finalized service expenses
- confirmed Stock Token purchase cost
+ confirmed Stock Token sale proceeds
= available earned capital (floored at zero)
```

Owner capital, external transfers, and unattributed transfers are recorded separately and contribute zero to autonomous investable capital. A wallet balance is never sufficient proof of earned capital. Sale proceeds retain earned-capital lineage.

## Ledger and positions

Every confirmed buy posts `debit stock_asset / credit cash` in exact USDG base-unit cost. Every confirmed sale debits cash, credits FIFO stock cost basis, and credits/debits `trading_pnl` for the realized gain/loss. Each posted journal references one immutable finalized `trade_settlement`. Quotes, simulations, submissions, failed/reverted transactions and unrealized changes do not post.

Normic uses FIFO execution accounting. Each confirmed buy creates a raw-token-unit lot with immutable original units/cost and mutable remaining units/cost. Partial sales consume oldest lots deterministically and allocate integer cost proportionally; final consumption takes the remaining cost to avoid drift. This method will not silently change. It is operational accounting, not tax advice.

Realized PnL exists only after a confirmed sale. Unrealized PnL is current verified onchain-oracle value less remaining FIFO cost basis and is never service revenue. The dashboard separates USDG cash, owner capital, unattributed transfers, investable earned capital, Stock Token value, service revenue/expenses, and realized/unrealized trading PnL.

Portfolio quantities reconcile FIFO raw units to finalized wallet ERC-20 balances. Display quantity applies the current onchain 18-decimal `uiMultiplier`. Valuation uses the configured official Chainlink Stock Token feed and freshness/sequencer checks. Pending corporate-action multiplier and oracle pause block new execution. Multiplier changes change presentation and reference valuation, not historical cost basis or service revenue.
