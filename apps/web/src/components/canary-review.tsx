"use client";

import { useRef, useState } from "react";
import type { FinancialService } from "@normic/core";
import {
  walletRequest,
  WalletRequestError,
} from "@/lib/financial-wallet-client";

type Review = Awaited<ReturnType<FinancialService["prepareCanaryReview"]>>;
const blockers: Record<string, string> = {
  DISTINCT_COUNTERPARTY_REQUIRED:
    "A real wallet owned by a different company and owner is required.",
  DISTINCT_PROVIDER_AND_REAL_001_USDG_SERVICE_REQUIRED:
    "A different real owner must connect their agent, create their own Normic wallet and publish the agreed 0.01 USDG service.",
  BUYER_USDG_FUNDING_REQUIRED:
    "Fund this buyer address with the missing canonical USDG before payment.",
  USEROP_GAS_ESTIMATE_REQUIRED:
    "A complete counterfactual UserOperation gas estimate is required. No gas amount is being guessed.",
  BUYER_ETH_FUNDING_REQUIRED:
    "The buyer needs ETH for the estimated owner setup. Later session/payment gas is additional.",
  PROVIDER_ETH_FUNDING_REQUIRED:
    "The provider needs ETH for its own deployment/session setup and subsequent actions.",
  OWNER_ALLOWANCE_REDUCTION_REQUIRED:
    "The existing escrow allowance exceeds 0.01 USDG. Reduce it independently before this canary; this review does not silently change it.",
  OWNER_SCOPED_SIGNER_PREPARATION_AND_PASSKEY_APPROVAL_REQUIRED:
    "The scoped session request and its gas must be ready before you personally approve with your existing passkey.",
  COMPLETE_LIFECYCLE_GAS_UNVERIFIED:
    "Later escrow actions and revocation still need complete UserOperation gas estimates. Do not treat the setup quote as total funding.",
};

export function CanaryReview({
  companyId,
  getOwnerToken,
}: {
  companyId: string;
  getOwnerToken: () => Promise<string>;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [role, setRole] = useState<"buyer" | "provider">("buyer");
  const key = useRef<string | null>(null),
    running = useRef(false);
  const prepare = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      key.current ??= crypto.randomUUID();
      const result = await walletRequest<Review>(
        await getOwnerToken(),
        "prepare_canary_review",
        { companyId, role },
        key.current,
      );
      setReview(result);
      key.current = null; // A new review refreshes expiry, balances and provider state.
    } catch (error) {
      if (error instanceof WalletRequestError && error.code === "CONFLICT")
        key.current = null;
      setMessage(
        error instanceof WalletRequestError
          ? error.message
          : "The canary review could not be prepared. No signature or transaction was requested.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="owner-section"
      aria-label="USDG canary review"
      aria-busy={busy}
    >
      <div className="owner-section-head">
        <span>OWNER REVIEW ONLY</span>
        <h3>Review the first 0.01 USDG canary.</h3>
        <p>
          Prepare an unsigned request. This does not sign, deploy, approve
          tokens or make a payment. This prepares or reuses your separate,
          export-protected Privy session signer without giving it onchain
          authority.
        </p>
      </div>
      <label>
        Your canary role
        <select
          value={role}
          disabled={busy}
          onChange={(event) => {
            setRole(event.target.value as "buyer" | "provider");
            setReview(null);
            key.current = null;
          }}
        >
          <option value="buyer">Buyer — fund + release</option>
          <option value="provider">Provider — accept + submit</option>
        </select>
      </label>
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => void prepare()}
      >
        {busy ? "Preparing review…" : "Prepare canary review"}
      </button>
      {review && (
        <>
          <dl className="owner-data-grid">
            <div>
              <dt>Wallet</dt>
              <dd style={{ overflowWrap: "anywhere" }}>{review.wallet}</dd>
            </div>
            <div>
              <dt>Network / token</dt>
              <dd>Robinhood Mainnet · 4663 · canonical USDG</dd>
            </div>
            <div>
              <dt>Owner limits</dt>
              <dd>
                {review.role === "provider"
                  ? "No USDG spending authority; no authority over buyer funds."
                  : "0.01 USDG per transaction · 0.01 USDG per day"}
              </dd>
            </div>
            <div>
              <dt>Session expiry</dt>
              <dd>60 minutes from preparation · {review.expiresAt}</dd>
            </div>
            <div>
              <dt>Agent actions</dt>
              <dd>
                {review.role === "provider"
                  ? "Accept + submit only."
                  : "Fund + release only."}{" "}
                No root, native ETH transfer, trading, withdrawal or
                permission-management authority.
              </dd>
            </div>
            <div>
              <dt>Escrow</dt>
              <dd style={{ overflowWrap: "anywhere" }}>{review.escrow}</dd>
            </div>
            <div>
              <dt>USDG approval</dt>
              <dd>
                {review.approvalRequired
                  ? "Exactly 10,000 base units to this escrow; owner approval required."
                  : "No new approval prepared."}
              </dd>
            </div>
            <div>
              <dt>Account deployment</dt>
              <dd>
                {review.deployed
                  ? "Already deployed"
                  : "Counterfactual: deployment is included in the first owner-approved UserOperation."}
              </dd>
            </div>
            <div>
              <dt>Gas</dt>
              <dd>
                Not sponsored.{" "}
                {review.gas.requiredWei
                  ? `Owner setup estimate + 30% buffer: ${review.gas.requiredWei} wei; additional ETH needed: ${review.gas.deficitWei} wei.`
                  : "UserOperation estimate unavailable; funding amount is unverified."}{" "}
                Later payment/revocation gas is additional.
              </dd>
            </div>
          </dl>
          <p>
            The buyer session and any provider canary-only session must be
            revoked immediately after verified settlement. Each wallet owner
            approves their own root actions.
          </p>
          <ul>
            {review.blockers.map((code) => (
              <li key={code}>
                {blockers[code] ??
                  "An additional verified prerequisite is required."}
              </li>
            ))}
          </ul>
          <p role="status">
            Review only — no passkey prompt or transaction. Financial execution
            remains disabled.
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
