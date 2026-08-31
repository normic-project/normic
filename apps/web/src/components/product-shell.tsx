import { OwnerNavigation } from "./owner-navigation";
export function ProductShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="app-shell">
      <div className="app-stage">
        <header className="app-topbar">
          <div className="owner-topbar-navigation">
            <OwnerNavigation />
            <span>Owner control layer</span>
          </div>
          <b>Operational access lives in MCP · REST · SDK</b>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
