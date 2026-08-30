export const EMAIL_CONFIRMATION_PENDING_KEY =
  "normic.email-confirmation-pending";
export const EMAIL_VERIFIED_NOTICE_KEY = "normic.email-verified-notice";

export type OwnerAuthView =
  "unauthenticated" | "verification-required" | "connect" | "connected";

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
}): OwnerAuthView {
  if (!input.authenticated)
    return input.verificationRequested
      ? "verification-required"
      : "unauthenticated";
  if (!input.emailVerified) return "verification-required";
  return input.connected ? "connected" : "connect";
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
