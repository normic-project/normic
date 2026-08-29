"use client";

import { createBrowserClient } from "@supabase/ssr";
import type {
  AgentIdentity,
  ApiCredential,
  BootstrapRegistrationResult,
  Permission,
} from "@normic/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AutonomyConsole } from "./autonomy-console";

type OwnerConnection = {
  connected: boolean;
  identity: AgentIdentity | null;
  permissions: Permission[];
  credentials: ApiCredential[];
};

const EMPTY_CONNECTION: OwnerConnection = {
  connected: false,
  identity: null,
  permissions: [],
  credentials: [],
};

async function ownerRequest<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const value = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(value.error?.message ?? "Request failed.");
  return value;
}

export function OwnerConsole({
  paymentsReady,
  tradingReady,
}: {
  paymentsReady: boolean;
  tradingReady: boolean;
}) {
  const auth = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createBrowserClient(url, key) : null;
  }, []);
  const [ownerToken, setOwnerToken] = useState("");
  const [connection, setConnection] =
    useState<OwnerConnection>(EMPTY_CONNECTION);
  const [message, setMessage] = useState(
    "Sign in with a verified Normic Account.",
  );

  const loadConnection = useCallback(async (token: string) => {
    if (!token) return;
    try {
      const value = await ownerRequest<OwnerConnection>(
        "/onboarding/connection",
        token,
      );
      setConnection(value);
      setMessage(
        value.connected
          ? "External agent connection is ready."
          : "Account verified. Connect an external agent when ready.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to load connection.",
      );
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    void auth.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token ?? "";
      setOwnerToken(token);
      if (token) void loadConnection(token);
    });
    const { data } = auth.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? "";
      setOwnerToken(token);
      if (!token) setConnection(EMPTY_CONNECTION);
    });
    return () => data.subscription.unsubscribe();
  }, [auth, loadConnection]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return setMessage("Normic Authentication is unavailable.");
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const action =
      submitter instanceof HTMLButtonElement && submitter.value === "signup"
        ? "signup"
        : "signin";
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(form.get("password") ?? "");
    setMessage(
      action === "signin"
        ? "Signing in securely…"
        : "Creating your Normic Account…",
    );
    const result =
      action === "signup"
        ? await auth.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: `${window.location.origin}/owner` },
          })
        : await auth.auth.signInWithPassword({ email, password });
    if (result.error) return setMessage(result.error.message);
    if (!result.data.session)
      return setMessage(
        "Check your email, verify the account, then return here to sign in.",
      );
    setOwnerToken(result.data.session.access_token);
    await loadConnection(result.data.session.access_token);
  }

  async function connectAgent() {
    if (!ownerToken) return setMessage("Secure sign in is required first.");
    try {
      setMessage("Preparing a trusted external-agent connection…");
      const value = await ownerRequest<BootstrapRegistrationResult>(
        "/onboarding/connect",
        ownerToken,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: "{}",
        },
      );
      setConnection({
        connected: true,
        identity: {
          agent: value.identity.agent,
          company: value.identity.company,
          scopes: value.credential.scopes,
          credentialId: value.credential.id,
        },
        permissions: [],
        credentials: [value.credential],
      });
      await loadConnection(ownerToken);
      setMessage(
        "Connection prepared. Add https://normic.tech/mcp to your MCP client and approve the Normic authorization request.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Connection preparation failed.",
      );
    }
  }

  async function revokeCredential(id: string) {
    if (!ownerToken) return;
    try {
      await ownerRequest(
        `/onboarding/credentials/${encodeURIComponent(id)}/revoke`,
        ownerToken,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: "{}",
        },
      );
      await loadConnection(ownerToken);
      setMessage(
        "Credential revoked. The connected client can no longer authenticate.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Credential revocation failed.",
      );
    }
  }

  async function signOut() {
    await auth?.auth.signOut();
    setOwnerToken("");
    setConnection(EMPTY_CONNECTION);
    setMessage("Owner session ended.");
  }

  const { identity, permissions, credentials } = connection;

  return (
    <div className="owner-console">
      <section className="owner-auth-panel">
        <div className="owner-auth-copy">
          <span className="owner-section-index">01 / NORMIC ACCOUNT</span>
          <h2>Secure sign in.</h2>
          <p>
            Human authentication stays separate from MCP credentials and agent
            permissions.
          </p>
        </div>
        <form
          className="owner-form owner-auth-form"
          onSubmit={(event) => void authenticate(event)}
        >
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={8}
              required
            />
          </label>
          <div className="owner-actions">
            <button type="submit" name="action" value="signin">
              Sign In
            </button>
            <button
              type="submit"
              name="action"
              value="signup"
              className="owner-button-quiet"
            >
              Create Account
            </button>
            {ownerToken ? (
              <button
                type="button"
                className="owner-button-quiet"
                onClick={() => void signOut()}
              >
                Sign Out
              </button>
            ) : null}
          </div>
        </form>
      </section>

      {ownerToken ? (
        <section className="owner-section owner-connect-agent">
          <div className="owner-section-head">
            <span>02 / CONNECTED AGENTS</span>
            <h2>
              {connection.connected
                ? "Connection ready."
                : "Connect your agent."}
            </h2>
            <p>
              Normic prepares one trusted internal identity and a safe,
              non-financial scope set. Your external agent remains in your own
              MCP client.
            </p>
          </div>
          <div className="owner-connection-action">
            <span
              className={
                connection.connected
                  ? "connection-state ready"
                  : "connection-state"
              }
            >
              {connection.connected ? "CONNECTED" : "NOT CONNECTED"}
            </span>
            <code>https://normic.tech/mcp</code>
            <button type="button" onClick={() => void connectAgent()}>
              Connect Agent
            </button>
            <Link href="/connect">Open client instructions →</Link>
          </div>
          <p className="owner-message" role="status">
            {message}
          </p>
        </section>
      ) : (
        <p className="owner-message owner-message-standalone" role="status">
          {message}
        </p>
      )}

      {identity ? (
        <>
          <section className="owner-section">
            <div className="owner-section-head">
              <span>03 / IDENTITY + SECURITY</span>
              <h2>Connected agent.</h2>
              <p>
                {identity.company.name} · owner-authorized internal identity for
                an external MCP client.
              </p>
            </div>
            <div className="owner-data-grid">
              <div>
                <small>CONNECTION</small>
                <p>
                  {connection.connected ? "Ready" : "Revoked or incomplete"}
                </p>
              </div>
              <div>
                <small>INTERNAL IDENTITY</small>
                <code>{identity.agent.id}</code>
              </div>
              <div>
                <small>ACTIVE SCOPES</small>
                <p>{identity.scopes.join(" · ") || "None"}</p>
              </div>
              <div>
                <small>PERMISSIONS</small>
                <p>
                  {permissions
                    .map(
                      (permission) =>
                        `${permission.action}: ${permission.decision}`,
                    )
                    .join(" · ") || "None"}
                </p>
              </div>
            </div>
          </section>

          <section className="owner-section">
            <div className="owner-section-head">
              <span>04 / CREDENTIALS</span>
              <h2>Scoped access.</h2>
              <p>
                Credentials are server-controlled, non-recoverable, and
                immediately revocable by the verified owner.
              </p>
            </div>
            <div className="owner-credential-list">
              {credentials.map((credential) => (
                <article key={credential.id}>
                  <div>
                    <strong>{credential.label}</strong>
                    <small>
                      {credential.revokedAt ? "REVOKED" : "ACTIVE"} ·{" "}
                      {credential.prefix}
                    </small>
                    <p>{credential.scopes.join(" · ")}</p>
                  </div>
                  {!credential.revokedAt ? (
                    <button
                      onClick={() => void revokeCredential(credential.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          </section>

          <section className="owner-section">
            <div className="owner-section-head">
              <span>05 / AUTONOMY</span>
              <h2>Mandate, limits, and kill switches.</h2>
              <p>
                Financial controls remain disabled whenever production
                capabilities are blocked.
              </p>
            </div>
            <AutonomyConsole
              paymentsReady={paymentsReady}
              tradingReady={tradingReady}
              initialCompanyId={identity.company.id}
              initialOwnerToken={ownerToken}
              compactAuth
            />
          </section>
          <div className="owner-audit-link">
            <Link href="/activity">
              Open security and audit activity <span>→</span>
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
