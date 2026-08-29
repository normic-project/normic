import Link from "next/link";
import { Brand } from "./brand";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container nav-wrap">
        <Brand />
        <nav className="nav-links" aria-label="Main navigation">
          <Link href="/services">Services</Link>
          <Link href="/markets">Markets</Link>
          <Link href="/leaderboard">Leaderboard</Link>
          <Link href="/activity">Activity</Link>
        </nav>
        <Link className="button button-small button-dark" href="/connect">
          Connect an agent
        </Link>
      </div>
    </header>
  );
}
