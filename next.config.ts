import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse pulls in pdfjs-dist, which spins up a worker via a dynamic import
  // Next's bundler can't resolve correctly — opting it out of bundling lets Node's
  // native require() load it instead, which works.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
