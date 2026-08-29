"use client";

import { createBrowserClient } from "@supabase/ssr";
import type {
  AgentIdentity,
  ApiCredential,
  ApiScope,
  BootstrapRegistrationResult,
  Permission,
} from "@normic/core";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { AutonomyConsole } from "./autonomy-console";

const SAFE_BETA_SCOPES = [
  "company:read",
  "company:write",
  "services:read",
  "services:write",
  "jobs:read",
  "jobs:write",
  "transactions:read",
  "markets:read",
] satisfies ApiScope[];

export function OwnerConsole({ paymentsReady, tradingReady }: { paymentsReady: boolean; tradingReady: boolean }) {
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createBrowserClient(url, key) : null;
  }, []);
  const [ownerToken, setOwnerToken] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [message, setMessage] = useState("Sign in with a verified Supabase owner account.");

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return setMessage("Production Supabase authentication is unavailable.");
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const action = submitter instanceof HTMLButtonElement && submitter.value === "signup" ? "signup" : "signin";
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    setMessage(action === "signin" ? "Verifying owner session…" : "Creating verified owner account…");
    if (action === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/owner` } });
      if (error) return setMessage(error.message);
      if (!data.session) return setMessage("Check your email, verify the account, then return here to sign in.");
      setOwnerToken(data.session.access_token);
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) return setMessage(error?.message ?? "Sign-in failed.");
      setOwnerToken(data.session.access_token);
    }
    setOwnerEmail(email);
    setMessage("Verified owner session active. Onboard a new agent or connect an existing credential.");
  }

  async function onboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ownerToken) return setMessage("Sign in with a verified owner account first.");
    const form = new FormData(event.currentTarget);
    const body = {
      creatorEmail: ownerEmail,
      creatorName: String(form.get("creatorName") ?? ""),
      agentName: String(form.get("agentName") ?? ""),
      handle: String(form.get("handle") ?? ""),
      framework: String(form.get("framework") ?? "custom"),
      companyName: String(form.get("companyName") ?? ""),
      companySlug: String(form.get("companySlug") ?? ""),
      description: String(form.get("description") ?? ""),
      industry: String(form.get("industry") ?? ""),
      website: null,
      credentialLabel: "Primary public-beta agent",
    };
    setMessage("Creating the owner mapping and agent atomically…");
    const response = await fetch("/api/v1/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}`, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as BootstrapRegistrationResult & { error?: { message?: string } };
    if (!response.ok) return setMessage(value.error?.message ?? "Onboarding failed.");
    if (!value.secret) return setMessage("Onboarding completed, but the one-time secret was already displayed.");
    setIssuedSecret(value.secret);
    setAgentToken(value.secret);
    setMessage("Agent created. Save the one-time credential in a secret manager now.");
    await loadAgent(value.secret);
  }

  async function agentRequest<T>(path: string, init: RequestInit = {}, token = agentToken): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    const value = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(value.error?.message ?? "Request failed.");
    return value;
  }

  async function loadAgent(token = agentToken) {
    if (!token) return setMessage("Enter an active agent API credential.");
    try {
      setMessage("Loading authenticated owner controls…");
      const [nextIdentity, nextPermissions, nextCredentials] = await Promise.all([
        agentRequest<AgentIdentity>("/identity", {}, token),
        agentRequest<Permission[]>("/permissions", {}, token),
        agentRequest<ApiCredential[]>("/credentials", {}, token),
      ]);
      setIdentity(nextIdentity);
      setPermissions(nextPermissions);
      setCredentials(nextCredentials);
      setMessage("Authenticated owner controls loaded from production state.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load owner controls.");
    }
  }

  async function createCredential() {
    try {
      const result = await agentRequest<{ credential: ApiCredential; secret: string | null }>("/credentials", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ label: "Public-beta MCP agent", scopes: SAFE_BETA_SCOPES, expiresAt: null }),
      });
      setIssuedSecret(result.secret);
      await loadAgent();
      setMessage("Scoped credential created. Store the one-time secret securely.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Credential creation failed."); }
  }

  async function revokeCredential(id: string) {
    try {
      await agentRequest(`/credentials/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: "{}" });
      await loadAgent();
      setMessage("Credential revoked.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Credential revocation failed."); }
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setOwnerToken(""); setOwnerEmail(""); setIdentity(null); setPermissions([]); setCredentials([]); setIssuedSecret(null);
    setMessage("Owner session ended.");
  }

  return (
    <div className="owner-console">
      <section className="owner-auth-grid">
        <div>
          <span className="owner-section-index">01 / OWNER IDENTITY</span>
          <h2>Verified human control.</h2>
          <p>Owner sessions use standard Supabase authentication. MCP credentials and permissions remain separate.</p>
        </div>
        <form className="owner-form" onSubmit={(event) => void authenticate(event)}>
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required /></label>
          <div className="owner-actions">
            <button type="submit" name="action" value="signin">Sign in</button>
            <button type="submit" name="action" value="signup" className="owner-button-quiet">Create account</button>
            {ownerToken ? <button type="button" className="owner-button-quiet" onClick={() => void signOut()}>Sign out</button> : null}
          </div>
        </form>
      </section>

      {ownerToken && !identity ? (
        <section className="owner-section">
          <div className="owner-section-head"><span>02 / ONBOARD</span><h2>Create the first agent.</h2><p>One atomic request creates the mapped owner, company, active agent, permissions, ledger foundation, audit trail, and first scoped credential.</p></div>
          <form className="owner-form owner-onboarding-form" onSubmit={(event) => void onboard(event)}>
            <label>Your name<input name="creatorName" required minLength={2} /></label>
            <label>Agent name<input name="agentName" required minLength={2} /></label>
            <label>Agent handle<input name="handle" required pattern="[a-z0-9_]+" /></label>
            <label>Framework<select name="framework"><option value="claude-code">Claude Code</option><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option><option value="codex">Codex</option><option value="custom">Other MCP client</option></select></label>
            <label>Company name<input name="companyName" required minLength={2} /></label>
            <label>Company slug<input name="companySlug" required pattern="[a-z0-9-]+" /></label>
            <label>Industry<input name="industry" required minLength={2} /></label>
            <label className="owner-wide">Description<textarea name="description" required minLength={10} /></label>
            <button type="submit">Create owner + agent</button>
          </form>
        </section>
      ) : null}

      <section className="owner-section owner-connect-agent">
        <div className="owner-section-head"><span>03 / AGENT ACCESS</span><h2>Connect an existing agent.</h2><p>The API credential stays in browser memory only and is sent only to same-origin Normic routes.</p></div>
        <div className="owner-token-row"><input aria-label="Agent API credential" type="password" autoComplete="off" value={agentToken} onChange={(event) => setAgentToken(event.target.value)} placeholder="nmc_live_…" /><button onClick={() => void loadAgent()}>Load controls</button></div>
        <p className="owner-message" role="status">{message}</p>
        {issuedSecret ? <div className="owner-secret"><strong>ONE-TIME CREDENTIAL — SAVE NOW</strong><code>{issuedSecret}</code><button onClick={() => setIssuedSecret(null)}>I have stored it</button></div> : null}
      </section>

      {identity ? (
        <>
          <section className="owner-section">
            <div className="owner-section-head"><span>04 / IDENTITY + POLICY</span><h2>@{identity.agent.handle}</h2><p>{identity.company.name} · active agent owned by the authenticated Normic user.</p></div>
            <div className="owner-data-grid">
              <div><small>AGENT ID</small><code>{identity.agent.id}</code></div>
              <div><small>COMPANY ID</small><code>{identity.company.id}</code></div>
              <div><small>ACTIVE SCOPES</small><p>{identity.scopes.join(" · ")}</p></div>
              <div><small>PERMISSIONS</small><p>{permissions.map((permission) => `${permission.action}: ${permission.decision}`).join(" · ")}</p></div>
            </div>
          </section>

          <section className="owner-section">
            <div className="owner-section-head"><span>05 / CREDENTIALS</span><h2>Scoped access.</h2><p>Create the safe public-beta scope set or revoke an existing credential. Secrets are never recoverable.</p><button onClick={() => void createCredential()}>Create safe credential</button></div>
            <div className="owner-credential-list">
              {credentials.map((credential) => <article key={credential.id}><div><strong>{credential.label}</strong><small>{credential.revokedAt ? "REVOKED" : "ACTIVE"} · {credential.prefix}</small><p>{credential.scopes.join(" · ")}</p></div>{!credential.revokedAt ? <button onClick={() => void revokeCredential(credential.id)}>Revoke</button> : null}</article>)}
            </div>
          </section>

          <section className="owner-section">
            <div className="owner-section-head"><span>06 / AUTONOMY</span><h2>Mandate, limits, and kill switches.</h2><p>Financial controls remain disabled whenever production capabilities are blocked.</p></div>
            <AutonomyConsole paymentsReady={paymentsReady} tradingReady={tradingReady} initialCompanyId={identity.company.id} initialAgentToken={agentToken} initialOwnerToken={ownerToken} compactAuth />
          </section>
          <div className="owner-audit-link"><Link href="/activity">Open security and audit activity <span>→</span></Link></div>
        </>
      ) : null}
    </div>
  );
}
