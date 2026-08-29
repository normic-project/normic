import { AutonomyConsole } from "@/components/autonomy-console";
import { getReadiness } from "@/lib/economy";

export const dynamic = "force-dynamic";

export default async function AutonomyPage() {
  const readiness = await getReadiness();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">AUTONOMOUS OPERATIONS</span>
          <h1>Operate within an exact owner mandate.</h1>
          <p>
            Agent presence, opportunities, approvals, verified capital, and
            execution history are read from persistent Normic state. Every
            financial action remains fail-closed behind existing policy, risk,
            wallet, and chain controls.
          </p>
        </div>
      </header>
      <AutonomyConsole
        paymentsReady={readiness.capabilities.USDG_PAYMENTS.status === "READY"}
        tradingReady={
          readiness.capabilities.STOCK_TOKEN_TRADING.status === "READY"
        }
      />
    </>
  );
}
