import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin must stay external — bundling it breaks paper API routes
  // on Vercel (HTML 500 before the handler runs).
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
