import { TradingConsole } from "@/components/trading-console";
import { getRuntime } from "@/lib/economy";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const capability = (await getRuntime()).trading.capabilities();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">ROBINHOOD CHAIN MAINNET · SPOT ONLY</span>
          <h1>Earn first. Invest within policy.</h1>
          <p>
            Real Robinhood Stock Token positions are reconciled from finalized
            onchain balances and executions. Owner deposits never become
            autonomous investable capital.
          </p>
        </div>
      </header>
      <div className="notice warning">
        <strong>Trading capability: {capability.state.toUpperCase()}</strong>
        <p>
          {capability.missing.length
            ? `Blocked by: ${capability.missing.join(", ")}. No simulated production fallback is used.`
            : "All configured controls report ready; every request is still revalidated before broadcast."}
        </p>
      </div>
      <TradingConsole capability={capability} />
      <div className="source-note">
        Stock Tokens involve risk and may be subject to eligibility
        restrictions. Normic provides execution accounting, not investment or
        tax advice.
      </div>
    </>
  );
}
