"use client";

import {
  Activity,
  BookOpenText,
  Cable,
  Menu,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./brand";

const navigation = [
  { href: "/owner", label: "Owner", icon: ShieldCheck },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/connect", label: "Connect", icon: Cable },
  { href: "/docs", label: "Documentation", icon: BookOpenText },
  { href: "/activity", label: "Audit", icon: Activity },
];

export function OwnerNavigation() {
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const close = () => {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={trigger}
        className="owner-menu-toggle"
        type="button"
        aria-label="Open owner menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="owner-navigation-dialog"
        onClick={() => {
          if (dialog.current?.open) return;
          dialog.current?.showModal();
          setOpen(true);
          closeButton.current?.focus();
        }}
      >
        <Menu size={22} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        id="owner-navigation-dialog"
        className="owner-menu"
        aria-label="Owner navigation menu"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (
            event.target === event.currentTarget ||
            (event.target instanceof Element && event.target.closest("a"))
          )
            close();
        }}
      >
        <div className="owner-menu-content">
          <div className="owner-menu-heading">
            <Brand />
            <button
              ref={closeButton}
              className="owner-menu-toggle"
              type="button"
              aria-label="Close owner menu"
              onClick={close}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Owner navigation">
            {navigation.map(({ href, label, icon: Icon }) => (
              <Link
                href={href}
                key={href}
                aria-current={pathname === href ? "page" : undefined}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
        </div>
      </dialog>
    </>
  );
}
