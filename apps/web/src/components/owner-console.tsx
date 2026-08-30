"use client";

import { createBrowserClient } from "@supabase/ssr";
import type {
  AgentIdentity,
  ApiCredential,
  BootstrapRegistrationResult,
  Permission,
} from "@normic/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  EMAIL_CONFIRMATION_PENDING_KEY,
  EMAIL_CONFIRMATION_ADDRESS_KEY,
  EMAIL_CONFIRMATION_ERROR_KEY,
  EMAIL_RESEND_AFTER_KEY,
  clearPendingEmailConfirmation,
  clearEmailConfirmationErrorUrl,
  emailResendSeconds,
  getOwnerAuthView,
  hasEmailConfirmationError,
  hasAuthenticatedMcpActivity,
  isVerifiedSupabaseUser,
} from "@/lib/frontend-auth-state";
import { ownerRequestHeaders } from "@/lib/owner-request";
import { AutonomyConsole } from "./autonomy-console";
import { PasswordInput } from "./password-input";

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
    headers: ownerRequestHeaders(token, init.headers),
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
  const [authReady, setAuthReady] = useState(false);
  const [ownerToken, setOwnerToken] = useState("");
  const [emailVerified, setEmailVerified] = useState(false);
  const [verificationRequested, setVerificationRequested] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState("");
  const [confirmationError, setConfirmationError] = useState(false);
  const [signupPreferred, setSignupPreferred] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const resendInFlight = useRef(false);
  const authInFlight = useRef(false);
  const sessionRevision = useRef(0);
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

  const applySession = useCallback(
    async (session: { access_token: string } | null) => {
      const revision = ++sessionRevision.current;
      if (!auth || !session) {
        setOwnerToken("");
        setEmailVerified(false);
        setConnection(EMPTY_CONNECTION);
        setAuthReady(true);
        return;
      }

      const { data, error } = await auth.auth.getUser(session.access_token);
      if (revision !== sessionRevision.current) return;
      if (error || !data.user) {
        setOwnerToken("");
        setEmailVerified(false);
        setConnection(EMPTY_CONNECTION);
        setMessage("Your secure session could not be verified. Sign in again.");
        setAuthReady(true);
        return;
      }

      const verified = isVerifiedSupabaseUser(data.user);
      setOwnerToken(session.access_token);
      setEmailVerified(verified);
      setConnection(EMPTY_CONNECTION);
      setAuthReady(true);
      if (!verified) {
        setVerificationEmail(data.user.email ?? "");
        setMessage("Confirm your email before connecting an external agent.");
        return;
      }

      setVerificationRequested(false);
      setConfirmationError(false);
      setVerificationEmail("");
      clearPendingEmailConfirmation(sessionStorage);
      await loadConnection(session.access_token);
    },
    [auth, loadConnection],
  );

  useEffect(() => {
    if (!auth) {
      queueMicrotask(() => setAuthReady(true));
      return;
    }
    void auth.auth.getSession().then(({ data }) => {
      setVerificationRequested(
        sessionStorage.getItem(EMAIL_CONFIRMATION_PENDING_KEY) === "true",
      );
      setVerificationEmail(
        sessionStorage.getItem(EMAIL_CONFIRMATION_ADDRESS_KEY) ?? "",
      );
      setConfirmationError(
        sessionStorage.getItem(EMAIL_CONFIRMATION_ERROR_KEY) === "true" ||
          hasEmailConfirmationError(new URL(window.location.href)),
      );
      void applySession(data.session);
    });
    const { data } = auth.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => void applySession(session), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [applySession, auth]);

  useEffect(() => {
    const sync = () =>
      setResendSeconds(
        emailResendSeconds(sessionStorage.getItem(EMAIL_RESEND_AFTER_KEY)),
      );
    sync();
    const timer = window.setInterval(sync, 1000);
    return () => window.clearInterval(timer);
  }, []);

  function startResendCooldown() {
    sessionStorage.setItem(EMAIL_RESEND_AFTER_KEY, String(Date.now() + 60_000));
    setResendSeconds(60);
  }

  function requireVerification(email: string) {
    sessionStorage.setItem(EMAIL_CONFIRMATION_PENDING_KEY, "true");
    sessionStorage.setItem(EMAIL_CONFIRMATION_ADDRESS_KEY, email);
    setVerificationEmail(email);
    setVerificationRequested(true);
    setConfirmationError(false);
    startResendCooldown();
    setMessage(
      "If this address needs verification, check its inbox for your link.",
    );
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return setMessage("Normic Authentication is unavailable.");
    if (authInFlight.current) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const action = (
      submitter instanceof HTMLButtonElement
        ? submitter.value === "signup"
        : signupPreferred
    )
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
    authInFlight.current = true;
    setAuthBusy(true);
    try {
      const result =
        action === "signup"
          ? await auth.auth.signUp({
              email,
              password,
              options: { emailRedirectTo: window.location.origin },
            })
          : await auth.auth.signInWithPassword({ email, password });
      if (result.error) {
        if (
          result.error.code === "email_not_confirmed" ||
          (action === "signup" &&
            ["user_already_exists", "email_exists"].includes(
              result.error.code ?? "",
            ))
        ) {
          requireVerification(email);
          return;
        }
        setMessage(
          result.error.status === 429
            ? "Too many attempts. Please wait before trying again."
            : "Authentication could not be completed. Check your details and try again.",
        );
        return;
      }
      if (action === "signup") requireVerification(email);
      if (!result.data.session) {
        setAuthReady(true);
        return setMessage(
          "Check your email, confirm the account, then return to normic.tech.",
        );
      }
      await applySession(result.data.session);
    } catch {
      setMessage(
        "Authentication is temporarily unavailable. Please try again.",
      );
    } finally {
      authInFlight.current = false;
      setAuthBusy(false);
    }
  }

  async function resendVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !auth ||
      resendInFlight.current ||
      emailResendSeconds(sessionStorage.getItem(EMAIL_RESEND_AFTER_KEY)) > 0
    )
      return;
    const email = verificationEmail.trim().toLowerCase();
    if (!email) return;
    resendInFlight.current = true;
    setResendBusy(true);
    startResendCooldown();
    setMessage("Requesting a new verification link…");
    try {
      const { error } = await auth.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: "https://normic.tech" },
      });
      startResendCooldown();
      if (
        error?.status === 429 ||
        ["over_email_send_rate_limit", "over_request_rate_limit"].includes(
          error?.code ?? "",
        )
      ) {
        setMessage(
          "Please wait before requesting another link. Email delivery is rate-limited.",
        );
      } else if (error && (!error.status || error.status >= 500)) {
        setMessage(
          "We couldn't request a link right now. Please try again later.",
        );
      } else {
        // Use the same response for unknown, already verified, and pending addresses.
        setMessage(
          "If this address needs verification, a new link will arrive shortly.",
        );
      }
    } catch {
      setMessage(
        "We couldn't request a link right now. Please try again later.",
      );
    } finally {
      resendInFlight.current = false;
      setResendBusy(false);
    }
  }

  async function resetVerification(signup: boolean) {
    if (resendInFlight.current || authInFlight.current) return;
    // Only an unverified session can reach these controls.
    if (ownerToken) {
      if (!auth) return;
      try {
        const { error } = await auth.auth.signOut({ scope: "local" });
        if (error) throw error;
      } catch {
        return setMessage("Unable to clear this session. Please try again.");
      }
    }
    ++sessionRevision.current;
    clearPendingEmailConfirmation(sessionStorage);
    clearEmailConfirmationErrorUrl();
    setOwnerToken("");
    setEmailVerified(false);
    setConnection(EMPTY_CONNECTION);
    setVerificationEmail("");
    setVerificationRequested(false);
    setConfirmationError(false);
    setSignupPreferred(signup);
    setMessage(
      signup
        ? "Create your account with another email address."
        : "Sign in with a verified Normic Account.",
    );
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
    setOwnerToken("");
    setEmailVerified(false);
    setVerificationRequested(false);
    setConnection(EMPTY_CONNECTION);
    setAuthReady(true);
    setMessage("Sign in with a verified Normic Account.");
    setConfirmationError(false);
    setVerificationEmail("");
    clearPendingEmailConfirmation(sessionStorage);
    await auth?.auth.signOut();
  }

  const { identity, permissions, credentials } = connection;
  const mcpAuthenticated = hasAuthenticatedMcpActivity(
    credentials,
    identity?.credentialId,
  );
  const view = authReady
    ? getOwnerAuthView({
        authenticated: Boolean(ownerToken),
        emailVerified,
        connected: connection.connected,
        verificationRequested,
        confirmationError,
      })
    : "loading";

  return (
    <div className="owner-console">
      <section className={`owner-auth-panel owner-auth-panel-${view}`}>
        {ownerToken ? (
          <button
            type="button"
            className="owner-account-control"
            onClick={() => void signOut()}
          >
            Sign Out
          </button>
        ) : null}

        <div className="owner-primary-state" key={view} aria-live="polite">
          {view === "loading" ? (
            <div className="owner-auth-copy owner-loading-state">
              <span className="owner-section-index">01 / NORMIC ACCOUNT</span>
              <h2>Checking secure session.</h2>
              <p>Restoring your verified Normic Account.</p>
            </div>
          ) : null}

          {view === "unauthenticated" ? (
            <>
              <div className="owner-auth-copy">
                <span className="owner-section-index">01 / NORMIC ACCOUNT</span>
                <h2>
                  {signupPreferred ? "Create your account." : "Secure sign in."}
                </h2>
                <p>
                  Human authentication stays separate from MCP credentials and
                  agent permissions.
                </p>
              </div>
              <form
                className="owner-form owner-auth-form"
                onSubmit={(event) => void authenticate(event)}
              >
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </label>
                <PasswordInput
                  name="password"
                  autoComplete={
                    signupPreferred ? "new-password" : "current-password"
                  }
                  minLength={8}
                  required
                />
                <div className="owner-actions">
                  <button
                    type="submit"
                    name="action"
                    value="signin"
                    disabled={authBusy}
                  >
                    Sign In
                  </button>
                  <button
                    type="submit"
                    name="action"
                    value="signup"
                    className="owner-button-quiet"
                    disabled={authBusy}
                  >
                    Create Account
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {view === "verification-required" || view === "expired-link" ? (
            <>
              <div className="owner-auth-copy">
                <span className="owner-section-index">
                  {view === "expired-link"
                    ? "EMAIL LINK EXPIRED"
                    : "CHECK YOUR EMAIL"}
                </span>
                <h2>
                  {view === "expired-link"
                    ? "Email link expired."
                    : "Check your email."}
                </h2>
                {view === "expired-link" ? (
                  <p>This verification link is no longer valid.</p>
                ) : (
                  <>
                    <p>We sent a verification link to:</p>
                    <p className="owner-verification-email">
                      {verificationEmail || "your email address"}
                    </p>
                  </>
                )}
              </div>
              <form
                className="owner-form owner-auth-form owner-verification-form"
                onSubmit={(event) => void resendVerification(event)}
              >
                {view === "expired-link" || !verificationEmail ? (
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={verificationEmail}
                      onChange={(event) =>
                        setVerificationEmail(event.target.value)
                      }
                      disabled={resendBusy}
                    />
                  </label>
                ) : null}
                <button
                  type="submit"
                  disabled={!auth || resendBusy || resendSeconds > 0}
                >
                  {resendBusy
                    ? "Requesting link…"
                    : view === "expired-link"
                      ? "Send new verification link"
                      : "Resend verification email"}
                </button>
                <p
                  className="owner-resend-countdown"
                  role="timer"
                  aria-live="off"
                >
                  {resendSeconds > 0
                    ? `Resend available in ${resendSeconds}s`
                    : "You can request a new verification link."}
                </p>
                <button
                  type="button"
                  className="owner-button-quiet"
                  disabled={resendBusy}
                  onClick={() =>
                    void resetVerification(view !== "expired-link")
                  }
                >
                  {view === "expired-link"
                    ? "Back to sign in"
                    : "Use another email"}
                </button>
              </form>
            </>
          ) : null}

          {view === "connect" || view === "connected" ? (
            <>
              <div className="owner-auth-copy">
                <span className="owner-section-index">
                  02 / CONNECT YOUR AGENT
                </span>
                <h2>
                  {view === "connected"
                    ? mcpAuthenticated
                      ? "Agent connected."
                      : "Connection ready."
                    : "Connect your agent."}
                </h2>
                <p>
                  Your external agent stays in your own client. Normic provides
                  the secure MCP connection, identity, permissions and
                  capabilities.
                </p>
              </div>
              <div className="owner-connection-action">
                {view === "connected" ? (
                  <span className="connection-state ready">
                    {mcpAuthenticated ? "CONNECTED" : "CONNECTION READY"}
                  </span>
                ) : (
                  <small>MCP ENDPOINT</small>
                )}
                <code>https://normic.tech/mcp</code>
                {view === "connect" ? (
                  <button type="button" onClick={() => void connectAgent()}>
                    Connect Agent
                  </button>
                ) : identity ? (
                  <p className="owner-connected-summary">
                    {identity.company.name} · {identity.agent.name}
                  </p>
                ) : null}
                <Link href="/connect">Open client instructions →</Link>
              </div>
            </>
          ) : null}
        </div>

        <p className="owner-primary-message" role="status">
          {message}
        </p>
      </section>

      {identity ? (
        <>
          <section className="owner-section">
            <div className="owner-section-head">
              <span>03 / IDENTITY + SECURITY</span>
              <h2>
                {mcpAuthenticated
                  ? "Connected agent."
                  : "Prepared agent identity."}
              </h2>
              <p>
                {identity.company.name} · owner-authorized internal identity for
                an external MCP client.
              </p>
            </div>
            <div className="owner-data-grid">
              <div>
                <small>CONNECTION</small>
                <p>
                  {connection.connected
                    ? mcpAuthenticated
                      ? "Connected"
                      : "Connection ready"
                    : "Revoked or incomplete"}
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
