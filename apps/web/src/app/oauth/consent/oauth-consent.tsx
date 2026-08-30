"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { PasswordInput } from "../../../components/password-input";

type ConsentDetails = {
  clientName: string;
  redirectUri: string;
  scopes: string[];
};

export function OAuthAuthorizationPrompt({
  details,
  onDecision,
}: {
  details: ConsentDetails;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  return (
    <div className="oauth-form oauth-authorization-prompt">
      <p className="oauth-request">
        <strong>{details.clientName}</strong> is requesting access to your
        Normic identity.
      </p>
      <div className="button-row oauth-actions">
        <button type="button" onClick={() => onDecision("approve")}>
          Authorize
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => onDecision("deny")}
        >
          Deny
        </button>
      </div>
      <p className="oauth-note">Normic permissions stay owner-controlled.</p>
      <details className="oauth-technical-details">
        <summary>View technical details</summary>
        <dl className="oauth-details">
          <div>
            <dt>Redirect URI</dt>
            <dd>{details.redirectUri}</dd>
          </div>
          <div>
            <dt>Requested identity scopes</dt>
            <dd>{details.scopes.join(", ") || "None"}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

export function OAuthConsent({ authorizationId }: { authorizationId: string }) {
  const supabase = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createBrowserClient(url, key) : null;
  }, []);
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const loadAuthorization = useCallback(async () => {
    if (!authorizationId || authorizationId.length > 512) {
      setError("This authorization request is missing or invalid.");
      setBusy(false);
      return;
    }
    if (!supabase) {
      setError("Production OAuth is not configured for this deployment.");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      setNeedsLogin(true);
      setBusy(false);
      return;
    }
    const { data, error: detailsError } =
      await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    if (detailsError || !data) {
      setError(detailsError?.message ?? "Authorization request is invalid.");
      setBusy(false);
      return;
    }
    if (!("authorization_id" in data)) {
      window.location.replace(data.redirect_url);
      return;
    }
    setNeedsLogin(false);
    setDetails({
      clientName: data.client.name,
      redirectUri: data.redirect_uri,
      scopes: data.scope.split(" ").filter(Boolean),
    });
    setBusy(false);
  }, [authorizationId, supabase]);

  useEffect(() => {
    void loadAuthorization();
  }, [loadAuthorization]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError("");
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      setError("Sign-in failed. Check your credentials and try again.");
      setBusy(false);
      return;
    }
    await loadAuthorization();
  }

  async function decide(decision: "approve" | "deny") {
    if (!supabase) return;
    setBusy(true);
    setError("");
    const result =
      decision === "approve"
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          });
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Authorization decision failed.");
      setBusy(false);
      return;
    }
    window.location.assign(result.data.redirect_url);
  }

  return (
    <main className="oauth-shell">
      <section className="oauth-card" aria-busy={busy}>
        <span className="kicker">NORMIC OAUTH</span>
        <h1>Authorize MCP access</h1>
        {busy && <p>Checking this authorization request…</p>}
        {error && <p className="oauth-error">{error}</p>}
        {!busy && needsLogin && (
          <form className="oauth-form" onSubmit={signIn}>
            <p>
              Sign in with your existing verified Normic account to review the
              requesting MCP client.
            </p>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <PasswordInput
              name="password"
              autoComplete="current-password"
              required
            />
            <button type="submit">Sign in</button>
          </form>
        )}
        {!busy && details && (
          <OAuthAuthorizationPrompt
            details={details}
            onDecision={(decision) => void decide(decision)}
          />
        )}
      </section>
    </main>
  );
}
