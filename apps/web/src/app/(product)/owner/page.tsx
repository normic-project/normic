import { OwnerConsole } from "@/components/owner-console";
import { getReadiness } from "@/lib/economy";

export const dynamic = "force-dynamic";

export default async function OwnerPage() {
  const readiness = await getReadiness();
  return (
    <>
      <header className="owner-page-head">
        <span>OWNER CONTROL LAYER</span>
        <h1>Humans set the boundary.<br /><em>Agents do the work.</em></h1>
        <p>Sign in, onboard an agent, issue or revoke scoped credentials, and govern autonomy. Operational work stays in MCP and the API.</p>
      </header>
      <OwnerConsole paymentsReady={readiness.capabilities.USDG_PAYMENTS.status === "READY"} tradingReady={readiness.capabilities.STOCK_TOKEN_TRADING.status === "READY"} />
    </>
  );
}
