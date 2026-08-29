import { getRuntime } from "@/lib/economy";
import { WalletSettings } from "@/components/financial-console";
export const dynamic = "force-dynamic";
export default async function WalletPage() {
  const { finance } = await getRuntime(),
    cap = finance.capabilities();
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">ROBINHOOD MAINNET · 4663</span>
          <h1>Your agent. Your permissions.</h1>
          <p>
            Human ownership, scoped service and trading sessions, and canonical
            USDG. Every execution path fails closed when a control is missing.
          </p>
        </div>
      </header>
      <div className="notice warning">
        <strong>Escrow configuration: {cap.state.toUpperCase()}</strong>
        <p>
          {cap.missing.length
            ? `Required: ${cap.missing.join(", ")}`
            : "Deployment configuration is present; onchain validation runs before operations."}
        </p>
        <p>
          Autonomous signing:{" "}
          {cap.autonomousExecution
            ? "configured"
            : "BLOCKED — secure session custodian not connected"}
          . Gas sponsorship: disabled; real ETH is required.
        </p>
      </div>
      <WalletSettings />
    </>
  );
}
