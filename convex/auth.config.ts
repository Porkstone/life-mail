import type { AuthConfig } from "convex/server";

// Shoo uses a pairwise subject per origin (see https://docs.shoo.dev — "Pairwise subject").
// JWT `aud` is the redirect origin (e.g. `origin:http://localhost:5174`). Convex needs one
// customJwt provider per distinct audience you accept.
//
// Add every origin you serve (production, previews) to the defaults below or
// the comma-separated `EXTRA_SHOO_JWT_AUDIENCES` environment variable.
// Each value must match Shoo’s `aud` claim exactly (usually `origin:` + your site origin).

const SHOO_ISSUER = "https://shoo.dev";
const SHOO_JWKS = "https://shoo.dev/.well-known/jwks.json";

const DEFAULT_AUDIENCES = [
  "origin:http://localhost:5174",
  "origin:https://life-mail.vercel.app",
] as const;

function extraShooJwtAudiences() {
  return (process.env.EXTRA_SHOO_JWT_AUDIENCES ?? "")
    .split(",")
    .map((audience) => audience.trim())
    .filter((audience) => audience.length > 0);
}

function shooJwtAudiences() {
  return [...new Set([...DEFAULT_AUDIENCES, ...extraShooJwtAudiences()])];
}

export default {
  providers: shooJwtAudiences().map((applicationID) => ({
    type: "customJwt" as const,
    issuer: SHOO_ISSUER,
    jwks: SHOO_JWKS,
    algorithm: "ES256" as const,
    applicationID,
  })),
} satisfies AuthConfig;
