// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as React from "react";
import type * as ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerNavigation } from "../../apps/web/src/components/owner-navigation";

vi.mock("../../apps/web/node_modules/next/navigation", () => ({
  usePathname: () => "/wallet",
}));
vi.mock("../../apps/web/src/components/brand", () => ({
  Brand: () => "Normic",
}));
const requireWeb = createRequire(resolve("apps/web/package.json"));
const { createElement, act } = requireWeb("react") as typeof React;
const { createRoot } = requireWeb("react-dom/client") as typeof ReactDOMClient;
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
const originalShow = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lacks the browser's top-layer implementation; browser smoke checks
  // verify native focus trapping. These shims exercise our event/state wiring.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    },
    close: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
        this.dispatchEvent(new Event("close"));
      }),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(OwnerNavigation)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const [name, original] of [
    ["showModal", originalShow],
    ["close", originalClose],
  ] as const) {
    if (original)
      Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.unstubAllGlobals();
});
const trigger = () =>
  container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const dialog = () => container.querySelector("dialog")!;
const open = () => act(async () => trigger().click());

describe("compact owner navigation", () => {
  it("opens a modal with all five destinations and Wallet marked as current", async () => {
    expect(dialog().open).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(dialog().open).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close owner menu",
    );
    expect(document.body.style.overflow).toBe("hidden");
    expect(
      [...dialog().querySelectorAll("nav a")].map((a) => a.textContent),
    ).toEqual(["Owner", "Wallet", "Connect", "Documentation", "Audit"]);
    expect(
      dialog().querySelector('a[aria-current="page"]')?.getAttribute("href"),
    ).toBe("/wallet");
    expect(dialog().textContent).toContain("Normic");
    expect(dialog().querySelector('a[href="/status"]')).toBeNull();
  });
  it.each(["close", "escape", "cancel", "outside", "destination"])(
    "closes via %s and restores focus/scroll",
    async (action) => {
      await open();
      await act(async () => {
        if (action === "escape")
          dialog().dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        else if (action === "cancel")
          dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
        else if (action === "outside") dialog().click();
        else if (action === "destination") {
          // Prevent jsdom navigation, but preserve bubbling to the menu handler.
          const link =
            dialog().querySelector<HTMLAnchorElement>('a[href="/wallet"]')!;
          link.addEventListener("click", (e) => e.preventDefault(), {
            once: true,
          });
          link.click();
        } else
          dialog()
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Close owner menu"]',
            )!
            .click();
      });
      expect(dialog().open).toBe(false);
      expect(document.activeElement).toBe(trigger());
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.body.style.overflow).toBe("");
    },
  );
  it("does not dismiss when the menu panel itself is clicked", async () => {
    await open();
    await act(async () =>
      (dialog().querySelector(".owner-menu-content") as HTMLElement).click(),
    );
    expect(dialog().open).toBe(true);
  });
});
