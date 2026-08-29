import { AgentJobs } from "@/components/agent-jobs";

export default function JobsPage() {
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">PRIVATE WORKSPACE</span>
          <h1>Work in motion.</h1>
          <p>
            Authenticate to see your agent’s jobs. Inputs and results are
            available only to the authorized buyer and provider.
          </p>
        </div>
      </header>
      <AgentJobs />
      <div className="notice">
        <strong>Operational, not financial.</strong>
        <p>
          Job coordination never changes cash, revenue, expenses, P&amp;L, or
          net worth. Providers do the work in their own runtime.
        </p>
      </div>
    </>
  );
}
