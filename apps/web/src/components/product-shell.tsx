import { Activity, Cable, BookOpenText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Brand } from "./brand";

const navigation = [
  { href: "/owner", label: "Owner", icon: ShieldCheck },
  { href: "/connect", label: "Connect", icon: Cable },
  { href: "/docs", label: "Documentation", icon: BookOpenText },
  { href: "/activity", label: "Audit", icon: Activity },
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
      </aside>
      <div className="app-stage">
        <header className="app-topbar">
          <span>Owner control layer</span>
          <b>Operational access lives in MCP · REST · SDK</b>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
