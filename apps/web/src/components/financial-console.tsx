"use client";
import { useState } from "react";
type WalletProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};
type Invocation = {
  id: string;
  state: string;
  terms: { amount: string; provider: string };
  output: unknown;
};
type Prepared = {
  operation: {
    id: string;
    calls: { to: string; data: string; value: string }[];
  };
  ownerApprovalCalls: { to: string; data: string; value: string }[];
  from: string;
  chainId: number;
};
async function api(
  command: string,
  input: unknown,
  token = "",
  mode = "agent",
) {
  const r = await fetch(`/api/finance/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-normic-auth-mode": mode,
    },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(
      data.error?.message ?? "The operation could not be completed.",
    );
  return data;
}
export function HumanPurchase({
  serviceId,
  blocked,
}: {
  serviceId: string;
  blocked: boolean;
}) {
  const [session, setSession] = useState(""),
    [wallet, setWallet] = useState(""),
    [input, setInput] = useState("{}"),
    [invocation, setInvocation] = useState<Invocation | null>(null),
    [prepared, setPrepared] = useState<Prepared | null>(null),
    [tx, setTx] = useState(""),
    [message, setMessage] = useState(
      "Connect your wallet to request this service. No AI agent is required.",
    ),
    [busy, setBusy] = useState(false);
  const ethereum = () => {
    const e = (window as unknown as { ethereum?: WalletProvider }).ethereum;
    if (!e) throw new Error("Install an EVM wallet to continue.");
    return e;
  };
  const network = async () => {
    if ((await ethereum().request({ method: "eth_chainId" })) !== "0x1237")
      throw new Error("Switch your wallet to Robinhood Chain Mainnet (4663).");
    const accounts = (await ethereum().request({
      method: "eth_accounts",
    })) as string[];
    if (wallet && accounts[0]?.toLowerCase() !== wallet.toLowerCase())
      throw new Error("Wallet account changed. Reconnect before continuing.");
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Wallet action failed.");
    } finally {
      setBusy(false);
    }
  };
  async function connect() {
    const accounts = (await ethereum().request({
        method: "eth_requestAccounts",
      })) as string[],
      address = accounts[0];
    if (!address) throw new Error("No wallet account selected.");
    await network();
    const challenge = await api("wallet_challenge", { wallet: address });
    const encoded =
      "0x" +
      Array.from(new TextEncoder().encode(challenge.message as string), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const signature = await ethereum().request({
      method: "personal_sign",
      params: [encoded, address],
    });
    const authenticated = await api("wallet_authenticate", {
      challengeId: challenge.id,
      signature,
    });
    setSession(authenticated.secret);
    setWallet(address);
    setMessage("Wallet verified. Creating a request does not move funds.");
  }
  async function prepare(action: string) {
    if (!invocation) return;
    const p = await api(action, { invocationId: invocation.id }, session);
    setPrepared(p);
    setTx("");
    setMessage(
      "Review the prepared call below. Approval and payment each require your wallet confirmation. Gas is paid in ETH.",
    );
  }
  async function send() {
    if (!prepared || !invocation) return;
    await network();
    for (const call of [
      ...prepared.ownerApprovalCalls,
      ...prepared.operation.calls,
    ]) {
      await network();
      const transaction = { ...call, from: prepared.from };
      await ethereum().request({
        method: "eth_call",
        params: [transaction, "latest"],
      });
      const hash = (await ethereum().request({
        method: "eth_sendTransaction",
        params: [transaction],
      })) as string;
      // A mined approval is needed before the next call. Never blindly resend.
      setTx(hash);
      setMessage(
        "Transaction submitted. Check its receipt before preparing another call.",
      );
      if (
        call !== prepared.operation.calls[prepared.operation.calls.length - 1]
      ) {
        setPrepared(null);
        setMessage(
          "Approval submitted. Wait for its receipt, then prepare payment again. No payment has been confirmed.",
        );
        return;
      }
    }
    setPrepared(null);
  }
  return (
    <section className="panel finance-form">
      <h2>Buy with USDG</h2>
      {blocked ? (
        <div className="notice warning">
          Payments are BLOCKED: a verified mainnet escrow and provider
          configuration are required. No payment will be requested.
        </div>
      ) : null}
      <p aria-live="polite">{message}</p>
      <button
        className="button primary"
        disabled={busy || blocked}
        onClick={() => void run(connect)}
      >
        Connect EVM wallet
      </button>
      {wallet ? <small>Buyer: {wallet}</small> : null}
      <label>
        Service input (JSON)
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={5}
        />
      </label>
      <button
        className="button"
        disabled={busy || !session || blocked || !!invocation}
        onClick={() =>
          void run(async () => {
            const i = await api(
              "request_service",
              { serviceId, input: JSON.parse(input) },
              session,
            );
            setInvocation(i);
            setMessage(
              "Payment required. The provider cannot see this job until funding is finalized.",
            );
          })
        }
      >
        Create payment requirement
      </button>
      {invocation ? (
        <>
          <p>
            Escrow state: <strong>{invocation.state}</strong>
          </p>
          <small>
            Amount: {invocation.terms.amount} USDG base units · Provider:{" "}
            {invocation.terms.provider}
          </small>
          <div className="finance-actions">
            {[
              ["fund_service", "Prepare funding", "payment_required"],
              ["accept_result", "Accept result & prepare release", "SUBMITTED"],
              ["dispute_result", "Prepare dispute", "SUBMITTED"],
              ["refund_service", "Prepare timeout refund", "FUNDED,ACCEPTED"],
            ].map(([action, label, states]) => (
              <button
                className="button"
                key={action}
                disabled={
                  busy || !states!.split(",").includes(invocation.state)
                }
                onClick={() => void run(() => prepare(action!))}
              >
                {label}
              </button>
            ))}
          </div>
          {invocation.output ? (
            <pre>{JSON.stringify(invocation.output, null, 2)}</pre>
          ) : null}
        </>
      ) : null}
      {prepared ? (
        <>
          <pre>
            {JSON.stringify(
              {
                chainId: prepared.chainId,
                from: prepared.from,
                approvals: prepared.ownerApprovalCalls,
                calls: prepared.operation.calls,
              },
              null,
              2,
            )}
          </pre>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void run(send)}
          >
            Simulate & confirm in wallet
          </button>
        </>
      ) : null}
      {tx ? (
        <a
          href={`https://robinhoodchain.blockscout.com/tx/${tx}`}
          target="_blank"
          rel="noreferrer"
        >
          View submitted transaction ↗
        </a>
      ) : null}
      {invocation ? (
        <>
          <label>
            Transaction hash for confirmation
            <input
              value={tx}
              onChange={(e) => setTx(e.target.value)}
              placeholder="0x…"
            />
          </label>
          <button
            className="button"
            disabled={busy || !tx}
            onClick={() =>
              void run(async () => {
                setInvocation(
                  await api(
                    "confirm_payment",
                    { invocationId: invocation.id, transactionHash: tx },
                    session,
                  ),
                );
                setMessage(
                  "Finalized receipt verified. Accounting reflects only verified escrow events.",
                );
              })
            }
          >
            Verify finalized receipt
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setInvocation(
                  await api(
                    "get_invocation",
                    { invocationId: invocation.id },
                    session,
                  ),
                ),
              )
            }
          >
            Refresh job and result
          </button>
        </>
      ) : null}
    </section>
  );
}
export function WalletSettings() {
  const [companyId, setCompany] = useState(""),
    [token, setToken] = useState(""),
    [mode, setMode] = useState("agent"),
    [data, setData] = useState<unknown>(null),
    [message, setMessage] = useState(
      "Credentials stay in this page's memory and are never saved in browser storage.",
    ),
    [policy, setPolicy] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      setData(await fn());
      setMessage(
        "Request completed. Onchain authorization and finality remain required for execution.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel finance-form">
      <h2>Wallet & spending permissions</h2>
      <label>
        Company ID
        <input value={companyId} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label>
        Authorization
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="agent">Scoped agent credential (read)</option>
          <option value="owner">Verified owner access token</option>
        </select>
      </label>
      <label>
        Bearer credential
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p aria-live="polite">{message}</p>
      <div className="finance-actions">
        {[
          ["get_wallet", "Wallet identity"],
          ["get_balance", "Real balances"],
          ["get_spending_policy", "Session & policy"],
          ["get_transactions", "Transactions"],
        ].map(([command, label]) => (
          <button
            className="button"
            disabled={busy || !token || !companyId}
            key={command}
            onClick={() =>
              void run(() => api(command!, { companyId }, token, mode))
            }
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        Explicit policy (JSON; token base units, no default limits)
        <textarea
          rows={7}
          value={policy}
          onChange={(e) => setPolicy(e.target.value)}
          placeholder="Paste an explicitly approved spending policy."
        />
      </label>
      <div className="finance-actions">
        <button
          className="button"
          disabled={busy || mode !== "owner" || !policy}
          onClick={() =>
            void run(() =>
              api(
                "update_spending_policy",
                { ...JSON.parse(policy), companyId },
                token,
                mode,
              ),
            )
          }
        >
          Update owner policy
        </button>
        <button
          className="button"
          disabled={busy || mode !== "owner" || !companyId || !token}
          onClick={() =>
            void run(() =>
              api("revoke_financial_session", { companyId }, token, mode),
            )
          }
        >
          Revoke local session
        </button>
      </div>
      <p>
        Local revocation blocks Normic immediately. Revoke the smart wallet
        permission and escrow authorization onchain from your owner wallet as
        well. Already submitted transactions cannot be undone.
      </p>
      {data !== null ? <pre>{JSON.stringify(data, null, 2)}</pre> : null}
    </section>
  );
}
