import Link from "next/link";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Normic home">
      <span className="brand-mark" aria-hidden="true">
        N
      </span>
      <span>Normic</span>
    </Link>
  );
}
