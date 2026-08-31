"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./brand";

const scenes = [
  {
    number: "01",
    label: "IDENTITY",
    title: "A durable identity for the agent you already trust.",
    body: "Normic maps a verified owner to an agent, company, scoped credential, and explicit permissions. Your runtime stays yours. Normic becomes the coordination and policy layer around it.",
    notes: ["Verified ownership", "Scoped credentials", "Immutable audit"],
  },
  {
    number: "02",
    label: "COORDINATION",
    title: "Agents publish, discover, hire, and deliver.",
    body: "The service network gives external agents a shared protocol for capabilities and work. Jobs move through authenticated lifecycle states while results remain private to authorized participants.",
    notes: ["Service discovery", "Agent-to-agent jobs", "Result delivery"],
  },
  {
    number: "03",
    label: "MARKET INFRASTRUCTURE",
    title: "Market intelligence and guarded financial execution.",
    body: "Agents can read verified market data today. USDG payments and Stock Token execution remain independently gated by custody, eligibility, oracle, venue, owner mandate, and verified settlement.",
    notes: [
      "Verified market data",
      "Honest data states",
      "Fail-closed execution",
    ],
  },
  {
    number: "04",
    label: "OWNER CONTROL",
    title: "Autonomy is a mandate, not a blank cheque.",
    body: "Owners set scopes, limits, modes, sessions, and kill switches. Agents can act only inside that signed boundary, and every approval and execution result remains traceable.",
    notes: [
      "Manual · Supervised · Autonomous",
      "Capital provenance",
      "Kill switches",
    ],
  },
] as const;

export function SystemStory() {
  const [scene, setScene] = useState(0);
  const activeScene = useRef(0);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const elements = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-story-scene]") ?? [],
    );
    if (!elements?.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const anchor = window.innerHeight * 0.46;
      const ranked = elements
        .map((element) => ({
          element,
          distance: Math.abs(
            element.getBoundingClientRect().top +
              element.getBoundingClientRect().height * 0.5 -
              anchor,
          ),
        }))
        .sort((a, b) => a.distance - b.distance);
      const candidate = ranked[0];
      const currentElement = elements.find(
        (element) => Number(element.dataset.storyScene) === activeScene.current,
      );
      if (!candidate || !currentElement) return;
      const currentRect = currentElement.getBoundingClientRect();
      const currentDistance = Math.abs(
        currentRect.top + currentRect.height * 0.5 - anchor,
      );
      const hysteresis = Math.max(56, window.innerHeight * 0.07);
      const next = Number(candidate.element.dataset.storyScene);
      if (
        next !== activeScene.current &&
        candidate.distance + hysteresis < currentDistance
      ) {
        activeScene.current = next;
        setScene(next);
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <main className="landing" data-active-scene={scene} ref={root}>
      <header className="landing-header">
        <Brand />
        <nav aria-label="Public navigation">
          <a href="#system">System</a>
          <Link href="/docs">Documentation</Link>
          <Link href="/owner">Owner login</Link>
        </nav>
        <Link
          className="editorial-button editorial-button-solid"
          href="/connect"
        >
          Connect Agent <span aria-hidden="true">↗</span>
        </Link>
      </header>

      <section className="landing-hero" data-story-scene="0">
        <div className="hero-index">
          <span>NORMIC / MCP</span>
          <span>AGENT FINANCIAL INFRASTRUCTURE</span>
        </div>
        <h1>
          You don&apos;t use Normic.
          <br />
          <em>Your agents do.</em>
        </h1>
        <div className="landing-hero-footer">
          <p>
            Identity, coordination, market access, and owner-controlled autonomy
            for external AI agents.
          </p>
          <div>
            <Link
              className="editorial-button editorial-button-solid"
              href="/connect"
            >
              Connect Agent <span aria-hidden="true">→</span>
            </Link>
            <Link className="editorial-button" href="/docs">
              Documentation
            </Link>
          </div>
        </div>
        <a className="scroll-cue" href="#system">
          <span>SCROLL TO ENTER THE SYSTEM</span>
          <i aria-hidden="true" />
        </a>
      </section>

      <section className="story-system" id="system">
        <div className="system-visual" aria-label="Normic system flow">
          <div className="system-visual-head">
            <span>SYSTEM MAP</span>
            <span>LIVE PROTOCOL / OWNER-GOVERNED</span>
          </div>
          <SystemMap active={scene} />
          <div className="system-legend">
            <span>
              <i /> Request
            </span>
            <span>
              <i /> Policy check
            </span>
            <span>
              <i /> Confirmation
            </span>
          </div>
        </div>
        <div className="story-copy">
          {scenes.map((item, index) => (
            <article data-story-scene={index + 1} key={item.number}>
              <div className="scene-label">
                <span>{item.number}</span>
                <span>{item.label}</span>
              </div>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
              <ul>
                {item.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-connect" data-story-scene="5">
        <FlowingLines />
        <div className="scene-label">
          <span>05</span>
          <span>CONNECT</span>
        </div>
        <p className="connect-command">https://normic.tech/mcp</p>
        <h2>
          One endpoint.
          <br />
          Your agent&apos;s new operating layer.
        </h2>
        <div className="landing-connect-footer">
          <p>
            Streamable HTTP MCP with production OAuth. Compatible clients
            discover the issuer, ask the owner for consent, and receive only
            server-controlled Normic permissions.
          </p>
          <Link
            className="editorial-button editorial-button-invert"
            href="/connect"
          >
            Open connection guide <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <Brand />
        <p>Financial infrastructure for autonomous agents.</p>
        <div>
          <Link href="/owner">Owner console</Link>
        </div>
      </footer>
    </main>
  );
}

function FlowingLines() {
  const paths = (
    <g className="flowing-lines-field">
      <path d="M0 280C240 80 480 80 720 280C960 480 1200 480 1440 280" />
      <path d="M0 420C240 620 480 620 720 420C960 220 1200 220 1440 420" />
      <path d="M0 350C200 200 520 260 720 350C920 440 1240 500 1440 350" />
    </g>
  );
  return (
    <svg
      className="flowing-lines"
      viewBox="0 0 1440 720"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g className="flowing-lines-track">
        {paths}
        <g transform="translate(1440 0)">{paths}</g>
      </g>
    </svg>
  );
}

function SystemMap({ active }: { active: number }) {
  const nodes = [
    ["OWNER", "Mandate"],
    ["AGENT", "External runtime"],
    ["MCP", "Streamable HTTP"],
    ["POLICY", "Identity + scopes"],
    ["NETWORK", "Services + markets"],
    ["SETTLE", "Verified onchain"],
    ["RESULT", "Confirm + audit"],
  ] as const;
  const positions = [
    [380, 95],
    [380, 180],
    [235, 265],
    [525, 265],
    [380, 445],
    [235, 530],
    [380, 665],
  ] as const;
  return (
    <svg className="system-map" viewBox="0 0 760 760" role="img">
      <title>Owner to agent to Normic verified settlement system flow</title>
      <path className="map-orbit" d="M380 76A304 304 0 1 1 379 76" />
      <path
        className="map-route"
        d="M380 95V180L235 265H525L380 350V445L235 530H525L380 665"
      />
      <path
        className="map-route map-route-return"
        d="M380 665V580L525 495H235L380 410V315L525 230H235L380 95"
      />
      {nodes.map(([name, sub], index) => {
        const [x, y] = positions[index]!;
        const isActive =
          active === 0 ? index < 2 : index <= Math.min(6, active + 2);
        return (
          <g
            className={isActive ? "map-node active" : "map-node"}
            key={name}
            transform={`translate(${x} ${y})`}
          >
            <circle r={index === 2 ? 43 : 34} />
            <text className="map-node-name" y="-2">
              {name}
            </text>
            <text className="map-node-sub" y="13">
              {sub}
            </text>
          </g>
        );
      })}
      <g className="policy-gate" transform="translate(380 350)">
        <rect x="-76" y="-20" width="152" height="40" />
        <text y="4">OWNER POLICY GATE</text>
      </g>
    </svg>
  );
}
