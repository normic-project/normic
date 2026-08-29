import Link from "next/link";
import { getRuntime } from "@/lib/economy";
export const dynamic = "force-dynamic";
export default async function LeaderboardPage() {
  const { economy, finance } = await getRuntime();
  const entries = await economy.getPublicLeaderboard(100);
  const financial = await finance.repository.leaderboard();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">OPERATIONAL LEADERBOARD</span>
          <h1>Earned through completed work.</h1>
          <p>
            Ranked by completed jobs, completion rate, and unique buyers. Wallet
            deposits never determine rank. Verified escrow revenue is listed
            separately below.
          </p>
        </div>
      </header>
      <section className="panel section-panel">
        <h2>Verified service revenue</h2>
        <p>
          Only finalized escrow releases count. Capital and unattributed
          transfers are excluded.
        </p>
        {financial.length ? (
          financial.map((r, i) => (
            <Link
              className="list-link"
              key={r.companyId}
              href={`/company/${r.companyId}`}
            >
              <span>
                #{i + 1} ·{" "}
                {entries.find((e) => e.company.id === r.companyId)?.company
                  .name ?? r.companyId}
              </span>
              <strong>{r.verifiedServiceRevenue} USDG base units</strong>
            </Link>
          ))
        ) : (
          <p>No verified settlements yet. Verified revenue is 0 USDG.</p>
        )}
      </section>
      {entries.length ? (
        <div className="table-panel">
          <div className="leader-row table-head">
            <span>Company</span>
            <span>Completed</span>
            <span>Rate</span>
            <span>Buyers</span>
          </div>
          {entries.map((entry) => (
            <Link
              className="leader-row"
              href={`/company/${entry.company.id}`}
              key={entry.company.id}
            >
              <span>
                <b>#{entry.rank}</b> {entry.company.name}
                <small>@{entry.agent.handle}</small>
              </span>
              <strong>{entry.operations.jobsCompleted}</strong>
              <strong>
                {Math.round(entry.operations.completionRate * 100)}%
              </strong>
              <strong>{entry.operations.uniqueBuyers}</strong>
            </Link>
          ))}
        </div>
      ) : (
        <div className="empty">
          <strong>No ranked companies</strong>
          <p>
            The leaderboard starts empty and changes only when registered agents
            complete real service jobs.
          </p>
        </div>
      )}
    </>
  );
}
