import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarkets } from "@/lib/economy";
export const dynamic = "force-dynamic";
export default async function MarketPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params,
    provider = await getMarkets();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/i.test(symbol)) notFound();
  const [asset, price] = await Promise.all([
    provider.getStockToken(symbol),
    provider.getStockPrice(symbol),
  ]);
  if (!asset.data)
    return (
      <>
        <header className="page-head">
          <div>
            <span className="kicker">STOCK TOKEN</span>
            <h1>{decodeURIComponent(symbol).toUpperCase()}</h1>
          </div>
        </header>
        <div className="empty">
          <strong>Token data unavailable</strong>
          <p>{asset.error}</p>
          <Link href="/markets">Back to markets</Link>
        </div>
      </>
    );
  return (
    <>
      <header className="detail-hero">
        <span className="kicker">ROBINHOOD STOCK TOKEN · {asset.state}</span>
        <h1>{asset.data.tokenName}</h1>
        <p>
          {asset.data.tokenSymbol} · {asset.data.status}
        </p>
        <div className="status-row">
          <span>Chain ID 4663</span>
          <span>
            {!price.data
              ? "Upstream halt status unavailable"
              : price.data.isTradingHalt
                ? "Trading halted upstream"
                : "Upstream halt: false"}
          </span>
          <span>Reference data</span>
        </div>
      </header>
      <div className="metric-grid">
        <article>
          <small>RAW BID</small>
          <strong>
            {price.data
              ? `${price.data.bid} ${price.data.currency}`
              : "Unavailable"}
          </strong>
        </article>
        <article>
          <small>RAW ASK</small>
          <strong>
            {price.data
              ? `${price.data.ask} ${price.data.currency}`
              : "Unavailable"}
          </strong>
        </article>
        <article>
          <small>EFFECTIVE BID</small>
          <strong>{price.data?.effectiveBid ?? "Unavailable"}</strong>
        </article>
        <article>
          <small>EFFECTIVE ASK</small>
          <strong>{price.data?.effectiveAsk ?? "Unavailable"}</strong>
        </article>
      </div>
      <div className="detail-grid">
        <section className="panel">
          <h2>Token metadata</h2>
          <dl className="facts">
            <div>
              <dt>Current multiplier</dt>
              <dd>{asset.data.currentMultiplier}</dd>
            </div>
            <div>
              <dt>Price generated at</dt>
              <dd>{price.data?.generatedAt ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Market data state</dt>
              <dd>{price.state}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                <a href={price.source}>Official Robinhood API</a>
              </dd>
            </div>
            <div>
              <dt>Fetched at</dt>
              <dd>{price.fetchedAt ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Pending multiplier</dt>
              <dd>{asset.data.pendingMultiplier ?? "None reported"}</dd>
            </div>
          </dl>
          <h3>Upstream trading capabilities</h3>
          <pre>{JSON.stringify(asset.data.tradingCapabilities, null, 2)}</pre>
        </section>
        <aside className="panel">
          <h2>Deployments</h2>
          {asset.data.deployments.length ? (
            asset.data.deployments.map((deployment) => (
              <code
                className="address"
                key={`${deployment.chainId}:${deployment.contractAddress}`}
              >
                {deployment.chainId} · {deployment.contractAddress}
              </code>
            ))
          ) : (
            <p>No deployment returned by the upstream API.</p>
          )}
          <hr />
          <p className="muted-copy">
            Raw bid and ask describe the underlying instrument. Effective values
            multiply them by the current token multiplier. Neither is an
            executable Normic quote.
          </p>
          <Link className="button button-dark" href="/portfolio">
            Open guarded portfolio
          </Link>
        </aside>
      </div>
      {price.error ? (
        <div className="notice">
          <strong>Upstream notice</strong>
          <p>{price.error}</p>
        </div>
      ) : null}
    </>
  );
}
