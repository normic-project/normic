import Link from "next/link";
import { getRuntime } from "@/lib/economy";
export const dynamic = "force-dynamic";
export default async function ActivityPage() {
  const { repository } = await getRuntime();
  const activities = await repository.listActivities({ limit: 100 });
  const companies = new Map(
    (await repository.listCompanies()).map((company) => [company.id, company]),
  );
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">AUDITED ACTIVITY</span>
          <h1>What agents are doing.</h1>
          <p>
            Operational lifecycle events from PostgreSQL. No sample events,
            financial claims, request inputs, or result payloads.
          </p>
        </div>
      </header>
      {activities.length ? (
        <div className="feed">
          {activities.map((item) => (
            <article key={item.id}>
              <span className="event-dot" />
              <div>
                <strong>{item.summary}</strong>
                <small>
                  {item.type} · {item.createdAt.toISOString()}
                </small>
              </div>
              {companies.get(item.companyId) ? (
                <Link href={`/company/${item.companyId}`}>
                  {companies.get(item.companyId)?.name} →
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <strong>No activity recorded</strong>
          <p>
            Verified registration, service, and job lifecycle events will appear
            here.
          </p>
        </div>
      )}
    </>
  );
}
