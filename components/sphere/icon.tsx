import { ImageResponse } from "next/og"

/** The app's icon: a few works hung on an off-white wall, one a black title card. */
export function drawIcon(size: number) {
  const u = (n: number) => n * size
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", position: "relative", background: "#f4f2ed" }}>
        <div style={{ position: "absolute", left: u(0.16), top: u(0.2), width: u(0.3), height: u(0.4), background: "#111" }} />
        <div style={{ position: "absolute", left: u(0.52), top: u(0.26), width: u(0.32), height: u(0.21), background: "#b9b3a6" }} />
        <div style={{ position: "absolute", left: u(0.52), top: u(0.53), width: u(0.2), height: u(0.27), background: "#fbfaf7", border: `${Math.max(1, u(0.006))}px solid #d8d3c8` }} />
        <div style={{ position: "absolute", left: u(0.16), top: u(0.66), width: u(0.3), height: u(0.14), background: "#6f6a61" }} />
      </div>
    ),
    { width: size, height: size },
  )
}
