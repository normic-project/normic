"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import type { ComponentProps } from "react";

export function PasswordInput(props: Omit<ComponentProps<"input">, "type">) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="password-control">
      <label htmlFor={id}>Password</label>
      <div className="password-field">
        <input {...props} id={id} type={visible ? "text" : "password"} />
        <button
          type="button"
          className="password-visibility"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-controls={id}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          <Icon size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
