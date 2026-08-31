import Link from "next/link";
import { Brand } from "./brand";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand />
        <nav className="nav-links" aria-label="Main navigation">
          <Link href="/docs">Documentation</Link>
          <Link href="/owner">Owner console</Link>
        </nav>
        <Link className="button button-small button-dark" href="/connect">
          Connect Agent
        </Link>
      </div>
    </header>
  );
}
