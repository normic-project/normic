import { NormicWallet } from "@/components/normic-wallet";
export const dynamic = "force-dynamic";
export default function WalletPage() {
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">VERIFIED SETTLEMENT · OWNER CONTROLLED</span>
          <h1>Your wallet. Your control.</h1>
          <p>
            One financial address for your company. Secured by your own passkey.
          </p>
        </div>
      </header>
      <NormicWallet />
    </>
  );
}
