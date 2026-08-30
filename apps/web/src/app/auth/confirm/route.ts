import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isVerifiedSupabaseUser } from "@/lib/frontend-auth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function confirmationRedirect(verified: boolean) {
  // The fragment is only a UX hint. The browser still validates the user with
  // Supabase before showing "Email verified"; no token is forwarded to it.
  const response = NextResponse.redirect(
    verified
      ? "https://normic.tech/#type=email"
      : "https://normic.tech/owner#error_code=otp_expired",
    303,
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (
    params.getAll("token_hash").length !== 1 ||
    params.getAll("type").length !== 1 ||
    params.get("type") !== "email" ||
    !tokenHash ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(tokenHash) ||
    !url ||
    !key
  )
    return confirmationRedirect(false);

  try {
    const response = confirmationRedirect(true);
    const supabase = createServerClient(url, key, {
      cookieOptions: { secure: process.env.NODE_ENV === "production" },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookies, headers) {
          for (const { name, value, options } of cookies)
            response.cookies.set(name, value, options);
          for (const [name, value] of Object.entries(headers))
            response.headers.set(name, value);
        },
      },
    });
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "email",
    });
    if (
      error ||
      !data.session?.access_token ||
      !isVerifiedSupabaseUser(data.user)
    )
      return confirmationRedirect(false);
    return response;
  } catch {
    // Never reflect provider errors, tokens, or partial session cookies.
    return confirmationRedirect(false);
  }
}

// Next otherwise runs GET for HEAD, which would consume a one-time token.
export function HEAD() {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}
