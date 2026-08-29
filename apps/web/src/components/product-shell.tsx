import {
  Activity,
  BriefcaseBusiness,
  Cable,
  ChartNoAxesCombined,
  Network,
  PieChart,
  Bot,
  Trophy,
  CircleGauge,
} from "lucide-react";
import Link from "next/link";
import { Brand } from "./brand";

const navigation = [
  { href: "/autonomy", label: "Autonomy", icon: Bot },
  { href: "/services", label: "Services", icon: Network },
  { href: "/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/wallet", label: "Wallet", icon: Cable },
  { href: "/portfolio", label: "Portfolio", icon: PieChart },
  { href: "/markets", label: "Markets", icon: ChartNoAxesCombined },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/connect", label: "Connect", icon: Cable },
  { href: "/status", label: "Status", icon: CircleGauge },
];
export function ProductShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="app-shell">
      <aside className="app-nav">
        <Brand />
        <nav aria-label="Product navigation">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link href={href} key={href} aria-label={label} title={label}>
              <Icon size={17} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="network-note">
          <span className="status-dot" />
          <div>
            <strong>Robinhood Chain</strong>
            <small>
              Mainnet ·{" "}
              {process.env.NORMIC_FINANCIAL_EXECUTION_ENABLED === "true"
                ? "financial configuration requested"
                : process.env.ROBINHOOD_MAINNET_ENABLED === "true"
                  ? "market reads · payments blocked"
                  : "integration inactive"}
            </small>
          </div>
        </div>
      </aside>
      <div className="app-stage">
        <header className="app-topbar">
          <span>Live service network</span>
          <b>USDG escrow · Stock Token trading is fail-closed</b>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
