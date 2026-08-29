import { getReadiness } from "@/lib/economy";

export const dynamic = "force-dynamic";

const labels = {
  CORE_API: "Core API",
  MCP: "MCP",
  SERVICE_NETWORK: "Service Network",
  ROBINHOOD_READS: "Market Reads",
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
        <p>
          Production market connectivity and financial execution are evaluated
          separately.
        </p>
      </div>
      <section className="metric-grid">
        <Status name="Database" value={readiness.components.DATABASE} />
        <Status name="OAuth" value={readiness.components.OAUTH} />
        <Status name="Market RPC" value={readiness.components.ROBINHOOD_RPC} />
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
              .map(
                (item) => `${item.code}: ${publicDependency(item.dependency)}`,
              )
              .join(" · ")
          : "Configured and available"}
      </small>
    </article>
  );
}

function publicDependency(value: string) {
  return value
    .replaceAll(/Supabase/gi, "identity provider")
    .replaceAll(/Robinhood Chain(?: Mainnet)?/gi, "market network")
    .replaceAll(/chain ID 4663/gi, "configured network")
    .replaceAll(/4663/g, "configured network");
}
