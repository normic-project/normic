"use client";

import { useState } from "react";

async function tradingApi(
  command: string,
  input: unknown,
  token: string,
  mode: string,
) {
  const response = await fetch(`/api/trading/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      authorization: `Bearer ${token}`,
      "x-normic-auth-mode": mode,
    },
    body: JSON.stringify(input),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error?.message ?? "Trading request failed.");
  return payload;
}

type Capability = {
  state: "ready" | "blocked";
  missing: readonly string[];
  chainId: number;
  venue: { venue: string; state: string };
};

export function TradingConsole({ capability }: { capability: Capability }) {
  const [companyId, setCompanyId] = useState("");
  const [token, setToken] = useState("");
  const [mode, setMode] = useState("agent");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState("BUY");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [policy, setPolicy] = useState("");
  const [output, setOutput] = useState<unknown>(null);
  const [message, setMessage] = useState(
    "Credentials remain in page memory and are never written to browser storage.",
  );
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const value = await operation();
      setOutput(value);
      setMessage("Request completed without an implicit transaction.");
      return value;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const read = (command: string) =>
    run(() => tradingApi(command, { companyId }, token, mode));

  return (
    <div className="trading-layout">
      <section className="panel finance-form">
        <div className="panel-heading">
          <div>
            <span className="kicker">AUTHENTICATED PORTFOLIO</span>
            <h2>Earned-capital portfolio</h2>
          </div>
          <span className={`data-state ${capability.state}`}>
            {capability.state.toUpperCase()}
          </span>
        </div>
        <label>
          Company ID
          <input
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
          />
        </label>
        <label>
          Authorization mode
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="agent">Scoped agent credential</option>
            <option value="owner">Verified owner access token</option>
          </select>
        </label>
        <label>
          Bearer credential
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p aria-live="polite">{message}</p>
        <div className="finance-actions">
          {[
            ["get_portfolio", "Portfolio"],
            ["get_investable_balance", "Investable capital"],
            ["get_trading_policy", "Policy & session"],
            ["get_trading_eligibility", "Eligibility"],
            ["get_trades", "Trades"],
            ["get_token_approvals", "Token approvals"],
          ].map(([command, label]) => (
            <button
              className="button"
              disabled={busy || !companyId || !token}
              key={command}
              onClick={() => void read(command!)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel finance-form">
        <span className="kicker">QUOTE ≠ EXECUTE</span>
        <h2>Stock Token order</h2>
        <div className="trade-fields">
          <label>
            Side
            <select
              value={side}
              onChange={(event) => setSide(event.target.value)}
            >
              <option>BUY</option>
              <option>SELL</option>
            </select>
          </label>
          <label>
            Symbol
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="NVDA"
            />
          </label>
          <label>
            Amount in raw input-token units
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button"
          disabled={
            busy ||
            capability.state !== "ready" ||
            mode !== "agent" ||
            !companyId ||
            !token ||
            !symbol ||
            !amount
          }
          onClick={() =>
            void run(async () => {
              const value = await tradingApi(
                "quote_stock_token",
                { companyId, symbol, side, amountIn: amount },
                token,
                mode,
              );
              setQuote(value);
              return value;
            })
          }
        >
          Request real venue quote
        </button>
        <button
          className="button button-dark"
          disabled={
            busy || !quote || capability.state !== "ready" || mode !== "agent"
          }
          onClick={() =>
            void run(() =>
              tradingApi(
                side === "BUY" ? "buy_stock_token" : "sell_stock_token",
                {
                  quoteId: quote?.id,
                  decision: {
                    objective: "Allocate owner-permitted earned capital",
                    reasonSummary:
                      "Uses a bounded portion of verified earned capital while preserving configured operating limits.",
                    riskChecks: [
                      "Owner policy",
                      "Earned-capital lineage",
                      "Oracle and venue quote",
                    ],
                  },
                },
                token,
                mode,
              ),
            )
          }
        >
          Execute exact approved quote
        </button>
        <p className="muted-copy">
          Execution is spot-only through verified market infrastructure. It
          requires an eligible owner, an active separate trading session, exact
          allowance, safe oracle data, successful simulation, and a reviewed
          custody adapter. Submitted is never treated as confirmed.
        </p>
      </section>

      <section className="panel finance-form">
        <span className="kicker">OWNER OVERRIDE</span>
        <h2>Trading policy</h2>
        <label>
          Explicit policy JSON (raw USDG units; no invented defaults)
          <textarea
            rows={11}
            value={policy}
            onChange={(event) => setPolicy(event.target.value)}
            placeholder="Paste a complete owner-approved policy."
          />
        </label>
        <div className="finance-actions">
          <button
            className="button"
            disabled={
              busy || mode !== "owner" || !policy || !companyId || !token
            }
            onClick={() =>
              void run(() =>
                tradingApi(
                  "update_trading_policy",
                  { ...JSON.parse(policy), companyId },
                  token,
                  mode,
                ),
              )
            }
          >
            Apply owner policy
          </button>
          <button
            className="button danger-button"
            disabled={
              busy || mode !== "owner" || !policy || !companyId || !token
            }
            onClick={() =>
              void run(() =>
                tradingApi(
                  "update_trading_policy",
                  { ...JSON.parse(policy), companyId, enabled: false },
                  token,
                  mode,
                ),
              )
            }
          >
            Pause trading
          </button>
          <button
            className="button"
            disabled={busy || mode !== "owner" || !companyId || !token}
            onClick={() =>
              void run(() =>
                tradingApi(
                  "revoke_trading_session",
                  { companyId },
                  token,
                  mode,
                ),
              )
            }
          >
            Revoke trading session
          </button>
        </div>
        <p>
          Local pause and revocation block new Normic execution immediately.
          Existing confirmed transactions cannot be reversed. Complete provider
          permission and token-allowance revocation with the owner wallet.
        </p>
      </section>

      {output !== null ? (
        <section className="panel trading-output">
          <h2>Verified response</h2>
          <pre>{JSON.stringify(output, null, 2)}</pre>
        </section>
      ) : null}
    </div>
  );
}
