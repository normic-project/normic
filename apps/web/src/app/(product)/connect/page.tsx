export const dynamic = "force-dynamic";

export default function ConnectPage() {
  const url =
    process.env.NORMIC_REMOTE_MCP_URL ??
    `${process.env.NORMIC_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100"}/mcp`;
  const production = process.env.NODE_ENV === "production";
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">REMOTE MCP · AGENT-FIRST ACCESS</span>
          <h1>One endpoint. Your agent does the rest.</h1>
          <p>
            Sign in as the owner, select Connect Agent, then add the Streamable
            HTTP endpoint to the compatible MCP client you already use.
          </p>
        </div>
      </header>
      <div className="notice warning">
        <strong>Use your configured Normic origin.</strong>
        <p>
          Use your deployed Normic MCP URL. Never commit{" "}
          <code>NORMIC_MCP_TOKEN</code>, paste it into logs, or expose it in
          browser code.
        </p>
        <p>
          {production
            ? "Production MCP requires an OAuth access token from your configured issuer. API credentials are for REST/SDK; they are not a substitute for a production MCP access token."
            : "This local development server accepts an agent API credential for MCP. Production uses an external OAuth issuer."}
        </p>
      </div>
      <div className="connect-grid">
        <Setup
          title="Claude Code"
          note={
            production
              ? "Register the remote endpoint, then run /mcp inside Claude Code to authorize with the configured issuer."
              : "Official remote HTTP transport with an environment-backed Authorization header."
          }
          code={
            production
              ? `claude mcp add --transport http normic ${url}`
              : `// .mcp.json — set NORMIC_MCP_TOKEN in the client environment\n${JSON.stringify({ mcpServers: { normic: { type: "http", url, headers: { Authorization: "Bearer ${NORMIC_MCP_TOKEN}" } } } }, null, 2)}`
          }
        />
        <Setup
          title="Hermes"
          note="Add this to ~/.hermes/config.yaml. Set NORMIC_MCP_TOKEN to a current issuer access token in production, or an API credential locally. Arrange refresh through your issuer; environment-backed headers do not refresh themselves."
          code={`mcp_servers:\n  normic:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer \${NORMIC_MCP_TOKEN}"`}
        />
        <Setup
          title="OpenClaw"
          note={
            production
              ? "Use the documented OAuth login flow after the operator has configured the issuer and its client registration policy."
              : "In protected local OpenClaw configuration, replace this placeholder. Do not commit credentials or set auth:oauth for a static development credential."
          }
          code={
            production
              ? `openclaw mcp add normic --url ${url} --transport streamable-http --auth oauth\nopenclaw mcp login normic\nopenclaw mcp doctor normic --probe`
              : `${JSON.stringify({ mcp: { servers: { normic: { url, transport: "streamable-http", headers: { Authorization: "Bearer <your-scoped-credential>" } } } } }, null, 2)}\n\n// Then run: openclaw mcp doctor normic --probe`
          }
        />
        <Setup
          title="Generic MCP client"
          note="Use normal MCP discovery after OAuth authorization. Normic publishes descriptive tool names, schemas, and capability metadata; no separate skill file is required."
          code={`Transport: Streamable HTTP\nEndpoint: ${url}\nAuthentication: OAuth 2.1\nDiscovery: tools/list`}
        />
      </div>
      <section className="panel section-panel" id="documentation">
        <h2>Authentication contract</h2>
        <ol className="steps">
          <li>
            <b>1</b>
            <div>
              <strong>Prepare the connection</strong>
              <p>
                Sign in to the Owner Console and select Connect Agent. Normic
                atomically prepares or reuses the internal identity, scoped
                credential, and trusted OAuth grant.
              </p>
            </div>
          </li>
          <li>
            <b>2</b>
            <div>
              <strong>Authorize from your client</strong>
              <p>
                Add <code>{url}</code> to your MCP client. The owner approves
                authorization, while Normic supplies the safe scope set from
                trusted server-side state.
              </p>
            </div>
          </li>
          <li>
            <b>3</b>
            <div>
              <strong>Discover and operate</strong>
              <p>
                The client uses standard MCP discovery to obtain available tools
                and schemas. Owners can revoke the connection immediately from
                the Owner Console.
              </p>
            </div>
          </li>
        </ol>
      </section>
      <div className="source-note">
        Configuration references:{" "}
        <a href="https://code.claude.com/docs/en/mcp">Claude Code</a> ·{" "}
        <a href="https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md">
          Hermes
        </a>{" "}
        · <a href="https://docs.openclaw.ai/cli/mcp">OpenClaw</a>. Syntax
        verified against official documentation; individual client runtimes are
        not bundled with Normic.
      </div>
    </>
  );
}
function Setup({
  title,
  note,
  code,
}: {
  title: string;
  note: string;
  code: string;
}) {
  return (
    <article className="setup-card">
      <span className="kicker">CLIENT</span>
      <h2>{title}</h2>
      <p>{note}</p>
      <pre>{code}</pre>
    </article>
  );
}
