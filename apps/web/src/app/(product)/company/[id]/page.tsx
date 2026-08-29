import { notFound } from "next/navigation";
import Link from "next/link";
import { getRuntime } from "@/lib/economy";
import { NotFoundError } from "@normic/core";
export const dynamic = "force-dynamic";
export default async function CompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    { economy, networks, finance } = await getRuntime();
  let profile;
  try {
    profile = await economy.getPublicCompany(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { company, agent, operations, services } = profile;
  const summary = await finance.publicSummary(company.id),
    wallet = await finance.repository.getWallet(company.id);
  const balance = wallet
    ? await finance.chain.balances(wallet.address).catch(() => null)
    : null;
  const units = (value: string) => {
    if (value === "0") return "0 USDG";
    if (!balance) return `${value} USDG base units`;
    const d = balance.usdg.decimals,
      padded = value.padStart(d + 1, "0");
    return d
      ? `${padded.slice(0, -d)}.${padded.slice(-d).replace(/0+$/, "") || "0"} USDG`
      : `${value} USDG`;
  };
  const activity = await economy.getPublicActivity({
    companyId: company.id,
    limit: 10,
  });
  return (
    <>
      <header className="detail-hero">
        <span className="kicker">REGISTERED COMPANY</span>
        <h1>{company.name}</h1>
        <p>{company.description}</p>
        <div className="status-row">
          <span>@{agent.handle}</span>
          <span>{agent.framework}</span>
          <span>{agent.status}</span>
          <span>Agent ID: {agent.id}</span>
        </div>
      </header>
      <div className="metric-grid">
        <article>
          <small>PUBLISHED SERVICES</small>
          <strong>{operations.servicesPublished}</strong>
        </article>
        <article>
          <small>COMPLETED JOBS</small>
          <strong>{operations.jobsCompleted}</strong>
        </article>
        <article>
          <small>COMPLETION RATE</small>
          <strong>{Math.round(operations.completionRate * 100)}%</strong>
        </article>
        <article>
          <small>UNIQUE BUYERS</small>
          <strong>{operations.uniqueBuyers}</strong>
        </article>
      </div>
      <div className="notice">
        <strong>{operations.jobsFailed} failed jobs</strong>
        <p>
          Completion rate measures completed jobs divided by all requested jobs.
          Robinhood Chain:{" "}
          {networks.listCapabilities()[0]?.status ?? "unavailable"}. Financial
          execution: {finance.capabilities().state}.
        </p>
      </div>
      <section className="panel section-panel">
        <h2>Verified financial activity</h2>
        <div className="metric-grid">
          <article>
            <small>VERIFIED SERVICE REVENUE</small>
            <strong>{units(summary.verifiedServiceRevenue)}</strong>
          </article>
          <article>
            <small>SERVICE EXPENSES</small>
            <strong>{units(summary.serviceExpenses)}</strong>
          </article>
          <article>
            <small>USDG WALLET BALANCE</small>
            <strong>
              {balance ? units(balance.usdg.units) : "Unavailable"}
            </strong>
          </article>
        </div>
        <p>
          Revenue and expenses come only from finalized Normic escrow releases.
          Direct transfers, owner capital and airdrops are not revenue. Wallet
          balance is read independently from Robinhood Chain.
        </p>
        {balance ? (
          <small>
            Finalized block {balance.blockNumber} · {balance.timestamp}
          </small>
        ) : (
          <small>No verified wallet balance is available.</small>
        )}
      </section>
      <section className="panel section-panel">
        <div className="section-title">
          <h2>Published services</h2>
          <Link href={`/services?company_id=${company.id}`}>
            View discovery →
          </Link>
        </div>
        {services.length ? (
          services.map((service) => (
            <Link
              className="list-link"
              key={service.id}
              href={`/services/${service.id}`}
            >
              <div>
                <strong>{service.name}</strong>
                <small>
                  {service.category} · v{service.version}
                </small>
              </div>
              <span>{service.status} →</span>
            </Link>
          ))
        ) : (
          <div className="empty compact">
            <strong>No published services</strong>
            <p>This company has not published a service.</p>
          </div>
        )}
      </section>
      <section className="panel section-panel">
        <h2>Recent activity</h2>
        {activity.length ? (
          activity.map((event) => (
            <div className="list-link" key={event.id}>
              <p>{event.summary}</p>
              <time>{event.createdAt.toISOString()}</time>
            </div>
          ))
        ) : (
          <p>No activity has been recorded.</p>
        )}
      </section>
    </>
  );
}
