import { describe, expect, it } from "vitest";
import {
  getOwnerAuthView,
  hasEmailConfirmationReturn,
  isVerifiedSupabaseUser,
  shouldShowEmailVerifiedNotice,
} from "../../apps/web/src/lib/frontend-auth-state.js";

describe("owner frontend authentication state", () => {
  it("keeps unauthenticated and unverified users away from Connect Agent", () => {
    expect(
      getOwnerAuthView({
        authenticated: false,
        emailVerified: false,
        connected: false,
      }),
    ).toBe("unauthenticated");
    expect(
      getOwnerAuthView({
        authenticated: true,
        emailVerified: false,
        connected: false,
      }),
    ).toBe("verification-required");
  });

  it("uses the primary panel for verified connection states", () => {
    expect(
      getOwnerAuthView({
        authenticated: true,
        emailVerified: true,
        connected: false,
      }),
    ).toBe("connect");
    expect(
      getOwnerAuthView({
        authenticated: true,
        emailVerified: true,
        connected: true,
      }),
    ).toBe("connected");
  });

  it("recognizes only intended Supabase confirmation returns", () => {
    expect(
      hasEmailConfirmationReturn(
        new URL("https://normic.tech/?code=valid"),
        true,
      ),
    ).toBe(true);
    expect(
      hasEmailConfirmationReturn(
        new URL("https://normic.tech/?code=untrusted"),
        false,
      ),
    ).toBe(false);
    expect(
      hasEmailConfirmationReturn(
        new URL("https://normic.tech/#access_token=redacted&type=signup"),
        false,
      ),
    ).toBe(true);
    expect(
      hasEmailConfirmationReturn(new URL("https://normic.tech/"), false),
    ).toBe(false);
  });

  it("never treats a callback marker alone as email verification", () => {
    expect(isVerifiedSupabaseUser({ email_confirmed_at: null })).toBe(false);
    expect(
      shouldShowEmailVerifiedNotice({
        confirmationReturn: true,
        trustedVerifiedUser: false,
        previouslyValidatedNotice: false,
      }),
    ).toBe(false);
    expect(
      shouldShowEmailVerifiedNotice({
        confirmationReturn: true,
        trustedVerifiedUser: true,
        previouslyValidatedNotice: false,
      }),
    ).toBe(true);
  });
});
