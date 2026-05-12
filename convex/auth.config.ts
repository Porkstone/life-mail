import type { AuthConfig } from "convex/server";

// Shoo uses a pairwise subject per origin (see https://docs.shoo.dev — "Pairwise subject").
// JWT `aud` is the redirect origin (e.g. `origin:http://localhost:5174`). Convex needs one
// customJwt provider per distinct audience you accept.
//
// Add every origin you serve (production, previews) to `EXTRA_SHOO_JWT_AUDIENCES` below.
// Each value must match Shoo’s `aud` claim exactly (usually `origin:` + your site origin).

const SHOO_ISSUER = "https://shoo.dev";
const SHOO_JWKS = "https://shoo.dev/.well-known/jwks.json";

const DEFAULT_AUDIENCES = ["origin:http://localhost:5174"] as const;

// Example: "origin:https://life-mail.vercel.app"
const EXTRA_SHOO_JWT_AUDIENCES: string[] = [];

function shooJwtAudiences() {
  return [...new Set([...DEFAULT_AUDIENCES, ...EXTRA_SHOO_JWT_AUDIENCES])];
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
