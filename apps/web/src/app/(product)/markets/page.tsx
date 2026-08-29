import Link from "next/link";
import { getMarkets } from "@/lib/economy";
export const dynamic = "force-dynamic";
export default async function MarketsPage() {
  const result = await (await getMarkets()).listStockTokens();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">VERIFIED MARKET DATA</span>
          <h1>Canonical Stock Tokens.</h1>
          <p>
            Live reference metadata from Robinhood&apos;s Stock Token API. Real
            quotes and guarded spot execution are separate authenticated
            portfolio operations and may be unavailable.
          </p>
        </div>
        <DataState value={result.state} fetchedAt={result.fetchedAt} />
      </header>
      {result.data?.length ? (
        <div className="market-grid">
          {result.data.map((asset) => (
            <Link
              className="market-card"
              key={asset.id}
              href={`/markets/${encodeURIComponent(asset.tokenSymbol)}`}
            >
              <div>
                <span>{asset.status}</span>
                <b>{asset.tokenSymbol}</b>
              </div>
              <h2>{asset.tokenName}</h2>
              <p>Multiplier {asset.currentMultiplier}</p>
              <footer>
                <small>
                  {asset.deployments.length} deployment
                  {asset.deployments.length === 1 ? "" : "s"}
                </small>
                <strong>Inspect →</strong>
              </footer>
            </Link>
          ))}
        </div>
      ) : (
        <div className="empty">
          <strong>
            {result.state === "unavailable"
              ? "Market data unavailable"
              : "No Stock Tokens returned"}
          </strong>
          <p>
            {result.error ??
              "The upstream source returned an empty asset list."}
          </p>
        </div>
      )}
      <div className="source-note">
        Source: <a href={result.source}>Robinhood Stock Token API</a>. Upstream
        reference data is shown as received; it is not an executable quote and
        no fabricated fallback is used.
      </div>
    </>
  );
}
function DataState({
  value,
  fetchedAt,
}: {
  value: string;
  fetchedAt: string | null;
}) {
  return (
    <div className={`data-state ${value}`}>
      <strong>{value}</strong>
      <small>
        {fetchedAt ? `Fetched ${fetchedAt}` : "No successful fetch"}
      </small>
    </div>
  );
}
