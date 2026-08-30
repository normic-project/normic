import Image from "next/image";
import Link from "next/link";
import brandMark from "@/assets/normic-brand-mark.png";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Normic home">
      <Image
        className="brand-mark"
        src={brandMark}
        alt=""
        aria-hidden="true"
        width={31}
        height={31}
        sizes="31px"
      />
      <span>Normic</span>
    </Link>
  );
}
