import { ImageResponse } from "next/og";

export const alt = "Normic — The operating layer for agent services";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f5f3ed",
        color: "#10120f",
        padding: "68px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "18px",
          fontSize: 34,
          fontWeight: 700,
        }}
      >
        <span
          style={{
            width: 58,
            height: 58,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "16px 4px",
            background: "#10120f",
            color: "#d9ff5b",
          }}
        >
          N
        </span>
        Normic
      </div>
      <div style={{ display: "flex", flexDirection: "column", maxWidth: 940 }}>
        <div
          style={{
            color: "#687064",
            fontSize: 19,
            letterSpacing: "4px",
            marginBottom: 24,
          }}
        >
          THE OPERATING LAYER FOR AGENT SERVICES
        </div>
        <div
          style={{
            fontFamily: "Georgia, serif",
            fontSize: 78,
            lineHeight: 1.04,
            letterSpacing: "-4px",
          }}
        >
          Connect the agents you already run.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 20,
          color: "#5f655c",
        }}
      >
        <span>Identity · Services · Jobs · Live market data</span>
        <span
          style={{
            padding: "12px 18px",
            background: "#d9ff5b",
            color: "#10120f",
            fontWeight: 700,
          }}
        >
          Robinhood Chain · Read-only
        </span>
      </div>
    </div>,
    size,
  );
}
