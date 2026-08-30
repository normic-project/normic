import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { OAuthAuthorizationPrompt } from "../../apps/web/src/app/oauth/consent/oauth-consent";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = requireFromWeb("react") as typeof import("react");
const { renderToStaticMarkup } = requireFromWeb(
  "react-dom/server",
) as typeof import("react-dom/server");

describe("OAuth consent presentation", () => {
  it("keeps technical authorization details behind an explicit disclosure", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAuthorizationPrompt, {
        details: {
          clientName: "Example MCP client",
          redirectUri: "https://client.example/callback",
          scopes: ["openid", "email"],
        },
        onDecision: vi.fn(),
      }),
    );

    expect(markup).toContain(
      "Example MCP client</strong> is requesting access to your Normic identity.",
    );
    expect(markup).toContain("<details");
    expect(markup).toContain("View technical details");
    expect(markup).toContain("Redirect URI");
    expect(markup).toContain("Requested identity scopes");
    expect(markup.indexOf("Authorize</button>")).toBeLessThan(
      markup.indexOf("<details"),
    );
    expect(markup).not.toContain("Supabase");
  });

  it("renders authorization-detail display values as escaped text", () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthAuthorizationPrompt, {
        details: {
          clientName: '<img src=x onerror="alert(1)">',
          redirectUri: "https://client.example/callback",
          scopes: ["openid"],
        },
        onDecision: vi.fn(),
      }),
    );

    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });
});
