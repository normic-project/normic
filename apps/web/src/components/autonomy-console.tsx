"use client";

import { useState } from "react";
import type {
  ActionHistory,
  AgentHeartbeat,
  AutonomyRiskStatus,
  Opportunity,
  OwnerMandate,
} from "@normic/core";

type Overview = {
  autonomy: { mandate: OwnerMandate | null; heartbeat: AgentHeartbeat | null };
  treasury: Record<string, unknown>;
  capital: Record<string, unknown>;
  risk: AutonomyRiskStatus;
  opportunities: Opportunity[];
  approvals: {
    plan: { id: string; action: { type: string }; reasonSummary: string };
  }[];
  history: ActionHistory[];
};

export function AutonomyConsole({
  paymentsReady,
  tradingReady,
}: {
  paymentsReady: boolean;
  tradingReady: boolean;
}) {
  const [companyId, setCompanyId] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [ownerToken, setOwnerToken] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<OwnerMandate | null>(null);
  const [message, setMessage] = useState(
    "Connect a scoped agent credential to load live state.",
  );

  async function command<T>(
    name: string,
    body: unknown,
    mode: "agent" | "owner" = "agent",
    mutation = false,
  ) {
    const token = mode === "owner" ? ownerToken : agentToken;
    const response = await fetch(`/api/autonomy/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-normic-auth-mode": mode,
        ...(mutation ? { "idempotency-key": crypto.randomUUID() } : {}),
      },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as T & {
      error?: { message?: string };
    };
    if (!response.ok)
      throw new Error(value.error?.message ?? "Request failed.");
    return value;
  }

  async function load() {
    try {
      setMessage("Loading verified autonomy state…");
      const [autonomy, treasury, capital, risk, opportunities, history] =
        await Promise.all([
          command<Overview["autonomy"]>("get_autonomy", { companyId }),
          command<Record<string, unknown>>("get_treasury", { companyId }),
          command<Record<string, unknown>>("get_capital_sources", {
            companyId,
          }),
          command<AutonomyRiskStatus>("get_risk_status", { companyId }),
          command<Opportunity[]>("get_opportunities", { companyId, limit: 50 }),
          command<ActionHistory[]>("get_action_history", {
            companyId,
            limit: 50,
          }),
        ]);
      let approvals: Overview["approvals"] = [];
      if (ownerToken)
        approvals = await command<Overview["approvals"]>(
          "get_pending_approvals",
          { companyId },
          "owner",
        );
      const value = {
        autonomy,
        treasury,
        capital,
        risk,
        opportunities,
        approvals,
        history,
      };
      setOverview(value);
      setDraft(autonomy.mandate);
      setMessage("Live state loaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    }
  }

  async function heartbeat() {
    try {
      const mandate = overview?.autonomy.mandate;
      if (!mandate)
        throw new Error("An owner mandate must be configured first.");
      const expiry = new Date(
        Math.min(
          Date.now() + 5 * 60_000,
          new Date(mandate.sessionExpiresAt).getTime(),
        ),
      ).toISOString();
      await command(
        "heartbeat",
        {
          companyId,
          sessionId: crypto.randomUUID(),
          status: "ONLINE",
          currentJobId: null,
          expiresAt: expiry,
        },
        "agent",
        true,
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Heartbeat failed.");
    }
  }

  async function saveMandate() {
    if (!draft) return;
    try {
      const {
        version: _version,
        updatedAt: _updatedAt,
        updatedBy: _updatedBy,
        ...input
      } = draft;
      await command("update_mandate", input, "owner", true);
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Mandate update failed.",
      );
    }
  }

  async function pause() {
    try {
      await command("pause_autonomy", { companyId }, "owner", true);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pause failed.");
    }
  }

  async function decide(planId: string, approved: boolean) {
    try {
      await command(
        approved ? "approve_action_plan" : "reject_action_plan",
        { planId },
        "owner",
        true,
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Approval failed.");
    }
  }

  const balance = overview?.treasury.balance as
    { state?: string; usdg?: { units?: string } } | undefined;
  const portfolio = overview?.treasury.portfolio as
    | { state?: string; stockValueUsdg?: string; positions?: unknown[] }
    | undefined;

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="section-heading">
          <div>
            <span className="kicker">AUTHENTICATED CONTROL PLANE</span>
            <h2>Connect live identities</h2>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Company ID
            <input
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
            />
          </label>
          <label>
            Agent API credential
            <input
              type="password"
              autoComplete="off"
              value={agentToken}
              onChange={(event) => setAgentToken(event.target.value)}
            />
          </label>
          <label>
            Owner access token
            <input
              type="password"
              autoComplete="off"
              value={ownerToken}
              onChange={(event) => setOwnerToken(event.target.value)}
            />
          </label>
        </div>
        <div className="button-row">
          <button onClick={() => void load()}>Load live state</button>
          <button className="secondary" onClick={() => void heartbeat()}>
            Send heartbeat
          </button>
        </div>
        <p className="source-note">{message}</p>
      </section>

      {overview ? (
        <>
          <section className="metric-grid">
            <article className="metric-card">
              <span>Agent presence</span>
              <strong>
                {overview.autonomy.heartbeat?.status ?? "OFFLINE"}
              </strong>
              <small>
                {overview.autonomy.heartbeat?.currentJobId ?? "No current job"}
              </small>
            </article>
            <article className="metric-card">
              <span>Autonomy mode</span>
              <strong>
                {overview.autonomy.mandate?.mode ?? "NOT CONFIGURED"}
              </strong>
              <small>Mandate v{overview.autonomy.mandate?.version ?? 0}</small>
            </article>
            <article className="metric-card">
              <span>Verified USDG balance</span>
              <strong>
                {balance?.state === "available"
                  ? balance.usdg?.units
                  : "Unavailable"}
              </strong>
              <small>Robinhood Chain finalized source</small>
            </article>
            <article className="metric-card">
              <span>Investable capital</span>
              <strong>
                {String(overview.capital.availableUsdg ?? "Unavailable")}
              </strong>
              <small>Verified earned-capital lineage only</small>
            </article>
            <article className="metric-card">
              <span>Stock Token portfolio</span>
              <strong>
                {portfolio?.state === "available"
                  ? portfolio.stockValueUsdg
                  : "Unavailable"}
              </strong>
              <small>
                {portfolio?.positions?.length ?? 0} reconciled position(s)
              </small>
            </article>
            <article className="metric-card">
              <span>Risk status</span>
              <strong>{overview.risk.state}</strong>
              <small>
                {overview.risk.circuitBreakers.length} active breaker(s)
              </small>
            </article>
          </section>

          {draft ? (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <span className="kicker">OWNER ONLY</span>
                  <h2>Mandate and kill switches</h2>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Autonomy mode
                  <select
                    value={draft.mode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        mode: event.target.value as OwnerMandate["mode"],
                      })
                    }
                  >
                    <option>MANUAL</option>
                    <option>SUPERVISED</option>
                    <option>AUTONOMOUS</option>
                  </select>
                </label>
                {(
                  [
                    ["maxServiceSpendUsdg", "Maximum service spend"],
                    ["maxTradeUsdg", "Maximum trade size"],
                    ["maxDailyInvestmentUsdg", "Maximum daily investment"],
                    [
                      "maxStockTokenExposureUsdg",
                      "Maximum Stock Token exposure",
                    ],
                    ["minimumCashReserveUsdg", "Minimum USDG cash reserve"],
                    ["maxTotalDailySpendUsdg", "Maximum total daily spending"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field}>
                    {label} · base units
                    <input
                      inputMode="numeric"
                      value={String(draft[field as keyof OwnerMandate] ?? "")}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          [field]: event.target.value || null,
                        })
                      }
                    />
                  </label>
                ))}
                <label>
                  Allowed Stock Token asset IDs
                  <textarea
                    value={draft.allowedStockTokenIds.join("\n")}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        allowedStockTokenIds: event.target.value
                          .split(/\s+/)
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label>
                  Session expiration
                  <input
                    type="datetime-local"
                    value={draft.sessionExpiresAt.slice(0, 16)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        sessionExpiresAt: new Date(
                          event.target.value,
                        ).toISOString(),
                      })
                    }
                  />
                </label>
              </div>
              <div className="toggle-grid">
                {(
                  [
                    ["allowServiceOperations", "Service operations"],
                    ["allowServiceBuying", "Service buying"],
                    ["allowStockTokenTrading", "Stock Token trading"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={Boolean(draft[field as keyof OwnerMandate])}
                      disabled={
                        ((field === "allowServiceBuying" && !paymentsReady) ||
                          (field === "allowStockTokenTrading" &&
                            !tradingReady)) &&
                        !Boolean(draft[field as keyof OwnerMandate])
                      }
                      onChange={(event) =>
                        setDraft({ ...draft, [field]: event.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
                {Object.entries(draft.killSwitches).map(([field, enabled]) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          killSwitches: {
                            ...draft.killSwitches,
                            [field]: event.target.checked,
                          },
                        })
                      }
                    />
                    {field.replaceAll(/([A-Z])/g, " $1")}
                  </label>
                ))}
              </div>
              <div className="button-row">
                <button onClick={() => void saveMandate()}>
                  Save owner mandate
                </button>
                <button className="danger" onClick={() => void pause()}>
                  Pause all autonomy
                </button>
              </div>
            </section>
          ) : null}

          <section className="split-grid">
            <div className="panel">
              <h2>Pending approvals</h2>
              {overview.approvals.length ? (
                overview.approvals.map(({ plan }) => (
                  <article className="list-row" key={plan.id}>
                    <div>
                      <strong>{plan.action.type.replaceAll("_", " ")}</strong>
                      <p>{plan.reasonSummary}</p>
                    </div>
                    <div className="button-row">
                      <button onClick={() => void decide(plan.id, true)}>
                        Approve exact payload
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void decide(plan.id, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty-state">No pending approvals.</p>
              )}
            </div>
            <div className="panel">
              <h2>Real opportunities</h2>
              {overview.opportunities.length ? (
                overview.opportunities.map((opportunity) => (
                  <article className="list-row" key={opportunity.id}>
                    <div>
                      <strong>{opportunity.title}</strong>
                      <p>{opportunity.summary}</p>
                    </div>
                    <span className="tag">{opportunity.status}</span>
                  </article>
                ))
              ) : (
                <p className="empty-state">
                  No opportunities exist in current Normic state.
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <h2>Action history</h2>
            {overview.history.length ? (
              overview.history.map((entry) => (
                <article className="list-row" key={entry.id}>
                  <div>
                    <strong>{entry.actionType.replaceAll("_", " ")}</strong>
                    <p>
                      Mandate v{entry.mandateVersion} · policy{" "}
                      {entry.policyResult.result} · risk{" "}
                      {entry.riskResult.result}
                    </p>
                  </div>
                  <span className="tag">{entry.executionResult}</span>
                </article>
              ))
            ) : (
              <p className="empty-state">
                No autonomous actions have been recorded.
              </p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
