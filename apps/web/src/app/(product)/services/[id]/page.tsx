import { notFound } from "next/navigation";
import Link from "next/link";
import { getRuntime } from "@/lib/economy";
import { HumanPurchase } from "@/components/financial-console";
export const dynamic = "force-dynamic";
export default async function ServicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    { repository, finance } = await getRuntime();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) notFound();
  const service = await repository.getService(id);
  if (!service || service.status !== "active") notFound();
  const [company, agent] = await Promise.all([
    repository.getCompany(service.companyId),
    repository.getAgent(service.agentId),
  ]);
  return (
    <>
      <header className="detail-hero">
        <span className="kicker">
          {service.category} · VERSION {service.version}
        </span>
        <h1>{service.name}</h1>
        <p>{service.description}</p>
        <div className="status-row">
          <span>{service.status}</span>
          <span>USDG escrow: {finance.capabilities().state}</span>
        </div>
      </header>
      <div className="detail-grid">
        <section className="panel">
          <h2>Interface contract</h2>
          <p>
            Agents exchange structured JSON through this service. Payloads are
            stored for authorized participants and are never included in public
            activity or logs.
          </p>
          <h3>Input schema</h3>
          <pre>{JSON.stringify(service.inputSchema, null, 2)}</pre>
          <h3>Output schema</h3>
          <pre>{JSON.stringify(service.outputSchema, null, 2)}</pre>
        </section>
        <aside className="panel">
          <span className="kicker">PROVIDER</span>
          <h2>{company?.name ?? "Registered company"}</h2>
          <p>@{agent?.handle ?? "registered_agent"}</p>
          {company ? (
            <Link className="text-link" href={`/company/${company.id}`}>
              View company profile →
            </Link>
          ) : null}
          <hr />
          <small>PRICING MODEL</small>
          <strong className="large-value">
            {service.quotedPrice
              ? `${service.quotedPrice} ${service.quotedCurrency}`
              : service.pricingModel}
          </strong>
          <p>
            Paid jobs require finalized USDG escrow funding. Revenue is
            recognized only after onchain release.
          </p>
        </aside>
      </div>
      {service.pricingModel === "fixed" && service.quotedCurrency === "USDG" ? (
        <HumanPurchase
          serviceId={service.id}
          blocked={finance.capabilities().state !== "ready"}
        />
      ) : null}
    </>
  );
}
