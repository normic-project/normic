import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as React from "react";
import type * as ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductShell } from "../../apps/web/src/components/product-shell";
import sitemap from "../../apps/web/src/app/sitemap";

vi.mock("../../apps/web/src/components/brand", () => ({
  Brand: () => "Normic",
}));

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = requireFromWeb("react") as typeof React;
const { renderToStaticMarkup } = requireFromWeb(
  "react-dom/server",
) as typeof ReactDOMServer;

describe("internal readiness stays out of the owner UI", () => {
  it("renders owner content and navigation without infrastructure status", () => {
    const html = renderToStaticMarkup(
      createElement(ProductShell, { children: "Owner dashboard content" }),
    );
    expect(html).toContain("Owner dashboard content");
    for (const path of ["/owner", "/connect", "/docs", "/activity"])
      expect(html).toContain(`href="${path}"`);
    for (const removed of [
      'href="/status"',
      "Capability status",
      "Public beta:",
      "Market connectivity",
      "network-note",
    ])
      expect(html).not.toContain(removed);
  });

  it("removes the status page and sitemap entry", () => {
    expect(existsSync("apps/web/src/app/(product)/status/page.tsx")).toBe(
      false,
    );
    expect(
      sitemap().some(({ url }) => new URL(url).pathname === "/status"),
    ).toBe(false);
  });

  it.each([
    "apps/web/src/components/site-header.tsx",
    "apps/web/src/components/system-story.tsx",
    "apps/web/src/app/(product)/docs/page.tsx",
  ])("removes status-only links from %s", (file) => {
    expect(readFileSync(file, "utf8")).not.toContain('href="/status"');
  });

  it.each(["api/status", "health"])(
    "preserves the %s server readiness endpoint",
    (path) => {
      expect(
        readFileSync(`apps/web/src/app/${path}/route.ts`, "utf8"),
      ).toContain("export const GET = handleNormicServerRequest;");
    },
  );
});
