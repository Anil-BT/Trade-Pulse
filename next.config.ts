import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep firebase-admin (and ESM deps) external so Next doesn't force require()
  // of jose webapi (ERR_REQUIRE_ESM on Vercel).
  serverExternalPackages: [
    "firebase-admin",
    "@google-cloud/firestore",
    "@google-cloud/storage",
    "google-gax",
    "jose",
    "jwks-rsa",
  ],
};

export default nextConfig;
