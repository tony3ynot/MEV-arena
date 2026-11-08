import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next dev` would otherwise write an AGENTS.md into this folder on every start.
  agentRules: false,
};

export default nextConfig;
