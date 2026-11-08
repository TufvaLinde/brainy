import type { NextConfig } from "next"

const config: NextConfig = {
  // Card pictures come from the web or from /images, where they may be SVGs.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }, { protocol: "http", hostname: "**" }],
    dangerouslyAllowSVG: true,
  },
}

export default config
