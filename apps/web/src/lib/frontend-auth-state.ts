export const EMAIL_CONFIRMATION_PENDING_KEY =
  "normic.email-confirmation-pending";
export const EMAIL_VERIFIED_NOTICE_KEY = "normic.email-verified-notice";
export const EMAIL_CONFIRMATION_ADDRESS_KEY = "normic.confirmation-email";
export const EMAIL_CONFIRMATION_ERROR_KEY = "normic.confirmation-error";
export const EMAIL_RESEND_AFTER_KEY = "normic.confirmation-resend-after";

export type OwnerAuthView =
  | "unauthenticated"
  | "verification-required"
  | "expired-link"
  | "connect"
  | "connected";

export function isVerifiedSupabaseUser(
  user: { email_confirmed_at?: string | null } | null | undefined,
): boolean {
  return Boolean(user?.email_confirmed_at);
}

export function getOwnerAuthView(input: {
  authenticated: boolean;
  emailVerified: boolean;
  connected: boolean;
  verificationRequested?: boolean;
  confirmationError?: boolean;
}): OwnerAuthView {
  if (input.authenticated && input.emailVerified)
    return input.connected ? "connected" : "connect";
  if (input.confirmationError) return "expired-link";
  if (!input.authenticated)
    return input.verificationRequested
      ? "verification-required"
      : "unauthenticated";
  if (!input.emailVerified) return "verification-required";
  return input.connected ? "connected" : "connect";
}

// A recovery hint only: callers must check the current Supabase session first.
export function hasEmailConfirmationError(url: URL): boolean {
  return [url.searchParams, new URLSearchParams(url.hash.slice(1))].some(
    (params) =>
      ["otp_expired", "otp_invalid", "invalid_token", "token_expired"].includes(
        params.get("error_code") ?? "",
      ) ||
      (params.has("error") &&
        /(?:email|confirmation|verification).*(?:expired|invalid)|(?:expired|invalid).*(?:email|confirmation|verification)/i.test(
          params.get("error_description") ?? "",
        )),
  );
}

export function clearEmailConfirmationErrorUrl() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  for (const key of ["error", "error_code", "error_description"]) {
    url.searchParams.delete(key);
    hash.delete(key);
  }
  url.hash = hash.toString();
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function clearPendingEmailConfirmation(storage: Storage) {
  for (const key of [
    EMAIL_CONFIRMATION_PENDING_KEY,
    EMAIL_CONFIRMATION_ADDRESS_KEY,
    EMAIL_CONFIRMATION_ERROR_KEY,
    EMAIL_VERIFIED_NOTICE_KEY,
  ])
    storage.removeItem(key);
  // Keep the resend deadline: changing email must not bypass the cooldown.
}

export function emailResendSeconds(deadline: string | null, now = Date.now()) {
  const time = Number(deadline);
  return Number.isFinite(time)
    ? Math.max(0, Math.ceil((time - now) / 1000))
    : 0;
}

export function hasEmailConfirmationReturn(
  url: URL,
  confirmationPending: boolean,
): boolean {
  const queryType = url.searchParams.get("type");
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const hashType = hash.get("type");
  return (
    (confirmationPending && url.searchParams.has("code")) ||
    queryType === "signup" ||
    queryType === "email" ||
    hashType === "signup" ||
    hashType === "email"
  );
}

export function shouldShowEmailVerifiedNotice(input: {
  confirmationReturn: boolean;
  trustedVerifiedUser: boolean;
  previouslyValidatedNotice: boolean;
}): boolean {
  return (
    input.previouslyValidatedNotice ||
    (input.confirmationReturn && input.trustedVerifiedUser)
  );
}

export function hasAuthenticatedMcpActivity(
  credentials: readonly {
    id: string;
    lastUsedAt: Date | string | null;
  }[],
  credentialId: string | undefined,
): boolean {
  return Boolean(
    credentialId &&
    credentials.find((credential) => credential.id === credentialId)
      ?.lastUsedAt,
  );
}
