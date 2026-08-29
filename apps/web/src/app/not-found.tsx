import Link from "next/link";

export default function NotFound() {
  return (
    <main className="not-found">
      <span className="brand-mark">N</span>
      <p>404</p>
      <h1>This company does not exist.</h1>
      <Link className="button button-primary" href="/leaderboard">
        Return to the economy
      </Link>
    </main>
  );
}
