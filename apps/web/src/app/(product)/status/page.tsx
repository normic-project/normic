import { getReadiness } from "@/lib/economy";

export const dynamic = "force-dynamic";

const labels = {
  CORE_API: "Core API",
  MCP: "MCP",
  SERVICE_NETWORK: "Service Network",
  ROBINHOOD_READS: "Robinhood RPC",
  USDG_PAYMENTS: "USDG Payments",
  STOCK_TOKEN_TRADING: "Stock Token Trading",
  AUTONOMY: "Autonomous Financial Execution",
} as const;

export default async function StatusPage() {
  const readiness = await getReadiness();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">PRODUCTION READINESS</span>
          <h1>Capability status</h1>
          <p>
            Public-beta and financial capabilities are evaluated independently.
            No credentials or configured values are exposed.
          </p>
        </div>
      </header>
      <div className="notice warning">
        <strong>Public beta: {readiness.publicBeta}</strong>
        <p>Robinhood Chain Mainnet · chain ID {readiness.chainId}</p>
      </div>
      <section className="metric-grid">
        <Status name="Database" value={readiness.components.DATABASE} />
        <Status name="OAuth" value={readiness.components.OAUTH} />
        {Object.entries(readiness.capabilities).map(([name, value]) => (
          <Status
            key={name}
            name={labels[name as keyof typeof labels]}
            value={value}
          />
        ))}
      </section>
    </>
  );
}

function Status({
  name,
  value,
}: {
  name: string;
  value: {
    status: "READY" | "BLOCKED";
    blockers: { code: string; dependency: string }[];
  };
}) {
  return (
    <article className="metric-card">
      <span>{name}</span>
      <strong>{value.status}</strong>
      <small>
        {value.blockers.length
          ? value.blockers
              .map((item) => `${item.code}: ${item.dependency}`)
              .join(" · ")
          : "Configured and available"}
      </small>
    </article>
  );
}
