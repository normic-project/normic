"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  browserSupportsWebAuthn,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type {
  AgentIdentity,
  ApiCredential,
  FinancialWallet,
} from "@normic/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasAuthenticatedMcpActivity,
  isVerifiedSupabaseUser,
} from "@/lib/frontend-auth-state";
import { ownerRequestHeaders } from "@/lib/owner-request";
import {
  loadFinancialWallet,
  reviewWalletApproval,
  walletRequest,
  WalletRequestError,
  type WalletIdentityState,
} from "@/lib/financial-wallet-client";

type Connection = {
  connected: boolean;
  identity: AgentIdentity | null;
  credentials: ApiCredential[];
};
type Owner = { token: string; subject: string; connection: Connection };

export function WalletDetails({
  wallet,
  companyName,
  agentName,
}: {
  wallet: FinancialWallet;
  companyName: string;
  agentName: string;
}) {
  return (
    <div className="owner-data-grid" aria-label="Normic wallet details">
      <div>
        <small>NORMIC WALLET</small>
        <p style={{ overflowWrap: "anywhere" }}>{wallet.address}</p>
      </div>
      <div>
        <small>COMPANY / AGENT</small>
        <p>
          {companyName} · {agentName}
        </p>
      </div>
      <div>
        <small>NETWORK</small>
        <p>Robinhood Mainnet · 4663</p>
      </div>
      <div>
        <small>STATUS</small>
        <p>
          {wallet.deployed
            ? "Wallet ready · deployed"
            : "Wallet ready · counterfactual"}
        </p>
      </div>
    </div>
  );
}

export function NormicWallet() {
  const auth = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
      key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createBrowserClient(url, key) : null;
  }, []);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [ready, setReady] = useState(!auth),
    [busy, setBusy] = useState(false);
  const [wallet, setWallet] = useState<FinancialWallet | null>(null);
  const [identity, setIdentity] = useState<WalletIdentityState | null>(null);
  const [message, setMessage] = useState("");
  const [approvalBlocked, setApprovalBlocked] = useState(false);
  const [registrationPending, setRegistrationPending] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false),
    subject = useRef<string | null>(null);
  const pending = useRef<{
    companyId: string;
    response: RegistrationResponseJSON;
    key: string;
  } | null>(null);
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);

  const refresh = useCallback(async (current: Owner) => {
    const id = current.connection.identity?.company.id;
    if (!id) return;
    const version = generation.current;
    const result = await loadFinancialWallet(current.token, id);
    if (version !== generation.current) return;
    setIdentity(result.identity);
    setWallet(result.wallet);
    if (!result.wallet) {
      try {
        const approval = await reviewWalletApproval(current.token, id);
        if (version !== generation.current) return;
        setApprovalBlocked(false);
        if (approval)
          setMessage(
            "Your agent requested wallet preparation. Only you can approve it by creating your passkey. No spending permission is granted.",
          );
      } catch (error) {
        if (version !== generation.current) return;
        setApprovalBlocked(true);
        setMessage(
          error instanceof WalletRequestError
            ? error.message
            : "This wallet request could not be verified. Ask your agent for a new link.",
        );
      }
    }
    if (result.wallet || result.identity.state !== "pending_passkey") {
      pending.current = null;
      setRegistrationPending(false);
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    let active = true;
    const sync = async () => {
      const version = ++generation.current;
      try {
        const {
          data: { session },
        } = await auth.auth.getSession();
        const verified = session?.access_token
          ? await auth.auth.getUser(session.access_token)
          : null;
        if (!active || version !== generation.current) return;
        const user = verified?.data.user;
        if (
          !session?.access_token ||
          verified?.error ||
          !user ||
          !isVerifiedSupabaseUser(user)
        ) {
          subject.current = null;
          pending.current = null;
          setRegistrationPending(false);
          setOwner(null);
          setWallet(null);
          setIdentity(null);
          setMessage("Sign in with your verified Normic account to continue.");
          return;
        }
        if (subject.current !== user.id) {
          pending.current = null;
          setRegistrationPending(false);
          setWallet(null);
          setIdentity(null);
          setOwner(null);
        }
        subject.current = user.id;
        const response = await fetch("/api/v1/onboarding/connection", {
          cache: "no-store",
          headers: ownerRequestHeaders(session.access_token),
        });
        if (!response.ok) throw new Error();
        const connection = (await response.json()) as Connection;
        if (!active || version !== generation.current) return;
        const current = {
          token: session.access_token,
          subject: user.id,
          connection,
        };
        setOwner(current);
        await refresh(current);
      } catch {
        if (active && version === generation.current) {
          setOwner(null);
          setWallet(null);
          setIdentity(null);
          setMessage(
            "We could not verify your wallet status. Please refresh to retry.",
          );
        }
      } finally {
        if (active && version === generation.current) setReady(true);
      }
    };
    void sync();
    const {
      data: { subscription },
    } = auth.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        ++generation.current;
        subject.current = null;
        pending.current = null;
        setRegistrationPending(false);
        setOwner(null);
        setWallet(null);
        setIdentity(null);
        setBusy(false);
        setMessage("");
      } else if (event !== "INITIAL_SESSION")
        setTimeout(() => {
          if (active) void sync();
        }, 0);
    });
    return () => {
      active = false;
      invalidate();
      subscription.unsubscribe();
    };
  }, [auth, refresh, invalidate]);

  const create = async () => {
    const companyId = owner?.connection.identity?.company.id;
    if (!auth || !owner || !companyId || wallet || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const version = generation.current;
    const unchanged = () => {
      if (generation.current !== version || subject.current !== owner.subject)
        throw new WalletRequestError("UNAUTHENTICATED");
    };
    try {
      // Refresh access token through the existing Supabase session, never a saved JWT input.
      const {
        data: { session },
      } = await auth.auth.getSession();
      unchanged();
      if (!session?.access_token || session.user.id !== owner.subject)
        throw new WalletRequestError("UNAUTHENTICATED");
      const token = session.access_token;
      const current = await loadFinancialWallet(token, companyId);
      unchanged();
      if (current.wallet) {
        setWallet(current.wallet);
        return;
      }
      // Recheck expiry, owner/company binding and live credential/grant before enrollment.
      await reviewWalletApproval(token, companyId);
      unchanged();
      if (current.identity.state !== "passkey_verified") {
        if (!browserSupportsWebAuthn() || !window.isSecureContext)
          throw new Error("PASSKEY_UNSUPPORTED");
        if (!pending.current) {
          await walletRequest(token, "prepare_financial_identity", {
            companyId,
          });
          unchanged();
          const options =
            await walletRequest<PublicKeyCredentialCreationOptionsJSON>(
              token,
              "begin_financial_passkey_registration",
              { companyId },
            );
          unchanged();
          const response = await startRegistration({ optionsJSON: options });
          unchanged();
          pending.current = { companyId, response, key: crypto.randomUUID() };
          setRegistrationPending(true);
        }
        if (pending.current.companyId !== companyId)
          throw new WalletRequestError("FORBIDDEN");
        await walletRequest(
          token,
          "complete_financial_passkey_registration",
          { companyId, response: pending.current.response },
          pending.current.key,
        );
        unchanged();
        pending.current = null;
        setRegistrationPending(false);
        setIdentity({ state: "passkey_verified", smartAccountAddress: null });
      }
      setMessage("Your passkey is verified. Preparing your Normic address…");
      const result = await walletRequest<FinancialWallet>(
        token,
        "provision_financial_wallet",
        { companyId },
      );
      unchanged();
      setWallet(result);
      setMessage("Your Normic wallet is ready. No transaction was sent.");
    } catch (error) {
      if (generation.current !== version) return;
      if (error instanceof WalletRequestError) {
        if (
          ["UNAUTHENTICATED", "INVALID_INPUT", "CONFLICT"].includes(error.code)
        ) {
          pending.current = null;
          setRegistrationPending(false);
        }
        setMessage(error.message);
      } else if (
        error instanceof Error &&
        error.message === "PASSKEY_UNSUPPORTED"
      ) {
        setMessage(
          "Use a browser and device that support passkeys, and open https://normic.tech/wallet.",
        );
      } else if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        ["NotAllowedError", "AbortError"].includes(String(error.name))
      ) {
        setMessage(
          "Passkey setup was canceled or timed out. You can try again when ready.",
        );
      } else
        setMessage(
          "Wallet setup could not finish. Retry to resume safely; an existing wallet will never be replaced.",
        );
      await refresh(owner).catch(() => undefined);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const connection = owner?.connection;
  const connected =
    !!connection?.connected &&
    hasAuthenticatedMcpActivity(
      connection.credentials,
      connection.identity?.credentialId,
    );
  return (
    <section
      className="owner-section normic-wallet-section"
      aria-busy={busy || !ready}
    >
      <div className="owner-section-head">
        <span>YOUR NORMIC WALLET</span>
        <h2>{wallet ? "Your financial address." : "Create Normic Wallet"}</h2>
        <p>
          Your passkey keeps you in control. Your agent receives only the
          permissions you explicitly approve.
        </p>
      </div>
      {!ready ? (
        <p role="status">Checking your account…</p>
      ) : !owner ? (
        <>
          <Link
            className="button"
            href="/owner"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sign in to Normic (new tab)
          </Link>
          <p>
            After signing in, return to this tab to review your wallet request.
          </p>
        </>
      ) : wallet && connection?.identity ? (
        <WalletDetails
          wallet={wallet}
          companyName={connection.identity.company.name}
          agentName={connection.identity.agent.name}
        />
      ) : !connected ? (
        <>
          <p>Connect your agent through MCP before creating your wallet.</p>
          <Link className="button" href="/owner">
            Connect your agent
          </Link>
        </>
      ) : identity?.state === "revoked" ? (
        <p>
          This financial identity is disabled. Its root cannot be replaced
          through sign-in.
        </p>
      ) : (
        <>
          <button
            className="button"
            type="button"
            disabled={busy || !identity || approvalBlocked}
            onClick={() => void create()}
          >
            {busy
              ? "Preparing your wallet…"
              : identity?.state === "passkey_verified" || registrationPending
                ? "Resume wallet setup"
                : "Create Normic Wallet"}
          </button>
          <p>
            Your device will ask you to create a passkey. No external wallet,
            payment or transaction is required.
          </p>
        </>
      )}
      {wallet ? (
        <p>
          Use your existing device or synced passkey to retain control. Normic
          cannot reset or replace your root key.
        </p>
      ) : null}
      <p className="owner-primary-message" role="status">
        {message}
      </p>
      <p>
        Payments, trading and autonomous execution remain disabled. Creating a
        wallet grants no agent spending authority.
      </p>
    </section>
  );
}
