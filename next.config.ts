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
  // Surface commit on Paper UI so we can confirm prod deploy
  env: {
    NEXT_PUBLIC_GIT_SHA:
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
      "local",
  },
};

export default nextConfig;
