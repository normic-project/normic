"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  EMAIL_CONFIRMATION_PENDING_KEY,
  EMAIL_VERIFIED_NOTICE_KEY,
  hasEmailConfirmationReturn,
  isVerifiedSupabaseUser,
  shouldShowEmailVerifiedNotice,
} from "@/lib/frontend-auth-state";

export function EmailVerificationNotice() {
  const router = useRouter();
  const auth = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createBrowserClient(url, key) : null;
  }, []);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!auth) return;
    const client = auth;
    let active = true;
    const confirmationPending =
      sessionStorage.getItem(EMAIL_CONFIRMATION_PENDING_KEY) === "true";
    const confirmationReturn = hasEmailConfirmationReturn(
      new URL(window.location.href),
      confirmationPending,
    );
    const previouslyValidatedNotice =
      sessionStorage.getItem(EMAIL_VERIFIED_NOTICE_KEY) === "true";

    async function verifyCurrentSession() {
      const { data: sessionData } = await client.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      let trustedVerifiedUser = false;
      if (accessToken) {
        const { data, error } = await client.auth.getUser(accessToken);
        trustedVerifiedUser = !error && isVerifiedSupabaseUser(data.user);
      }
      if (!active) return;
      const shouldShow = shouldShowEmailVerifiedNotice({
        confirmationReturn,
        trustedVerifiedUser,
        previouslyValidatedNotice,
      });
      if (!shouldShow) return;

      sessionStorage.setItem(EMAIL_VERIFIED_NOTICE_KEY, "true");
      sessionStorage.removeItem(EMAIL_CONFIRMATION_PENDING_KEY);
      setOpen(true);
      if (confirmationReturn)
        window.history.replaceState({}, "", window.location.pathname);
    }

    void verifyCurrentSession();
    const { data } = client.auth.onAuthStateChange(() => {
      window.setTimeout(() => void verifyCurrentSession(), 0);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [auth]);

  if (!open) return null;

  return (
    <div className="verification-overlay" role="presentation">
      <section
        className="verification-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="verification-title"
      >
        <span>ACCOUNT CONFIRMATION</span>
        <h2 id="verification-title">Email verified</h2>
        <p>Your Normic account is ready.</p>
        <button
          type="button"
          onClick={() => {
            sessionStorage.removeItem(EMAIL_VERIFIED_NOTICE_KEY);
            setOpen(false);
            router.push("/owner");
          }}
        >
          Continue
        </button>
      </section>
    </div>
  );
}
