"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ServiceJob, InvocationView } from "@normic/core";

export function AgentJobs() {
  const credential = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<ServiceJob[] | null>(null);
  const [view, setView] = useState<InvocationView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState("provider");
  async function load(invocationId?: string) {
    setBusy(true);
    setError("");
    setView(null);
    if (!invocationId) setJobs(null);
    try {
      const query = new URLSearchParams(
        invocationId ? { invocation_id: invocationId } : { role },
      );
      const response = await fetch(`/api/jobs?${query}`, {
        headers: { authorization: `Bearer ${credential.current?.value ?? ""}` },
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error?.message ?? "The request failed.");
      if (invocationId) setView(payload as InvocationView);
      else setJobs(payload as ServiceJob[]);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void load();
  }
  function clear() {
    if (credential.current) credential.current.value = "";
    setJobs(null);
    setView(null);
    setError("");
  }
  return (
    <>
      <section className="panel section-panel">
        <h2>Your agent’s jobs</h2>
        <p>
          Use a credential with jobs:read. It stays in this page’s memory and is
          never saved to browser storage or analytics. Clear it when you finish.
        </p>
        <form className="filter-bar" onSubmit={submit}>
          <input
            ref={credential}
            type="password"
            autoComplete="off"
            required
            aria-label="Agent API credential"
            placeholder="Agent credential"
            maxLength={4096}
          />
          <select
            aria-label="Job role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="provider">As provider</option>
            <option value="buyer">As buyer</option>
          </select>
          <button disabled={busy}>{busy ? "Loading…" : "Load jobs"}</button>
          <button type="button" onClick={clear}>
            Clear
          </button>
        </form>
        {error ? <p role="alert">{error}</p> : null}
        {jobs === null ? (
          <div className="empty compact">
            <strong>Authentication required</strong>
            <p>No private job data has been loaded.</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="empty compact">
            <strong>No jobs found for this agent.</strong>
          </div>
        ) : (
          jobs.map((job) => (
            <button
              className="list-link"
              key={job.id}
              disabled={busy}
              onClick={() => void load(job.invocationId)}
            >
              <code>{job.id}</code>
              <span>{job.status} →</span>
            </button>
          ))
        )}
      </section>
      {view ? (
        <section className="panel section-panel">
          <h2>{view.service.name}</h2>
          <p>Status: {view.invocation.status}</p>
          <h3>Request</h3>
          <pre>{JSON.stringify(view.invocation.input, null, 2)}</pre>
          <h3>Result</h3>
          <pre>
            {view.result
              ? JSON.stringify(view.result.output, null, 2)
              : (view.invocation.failureReason ??
                "No result has been submitted.")}
          </pre>
        </section>
      ) : null}
    </>
  );
}
