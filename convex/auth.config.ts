import type { AuthConfig } from "convex/server";
import {
  SESSION_JWT_AUDIENCE,
  SHOO_ISSUER,
  SHOO_JWKS_URL,
  shooJwtAudiences,
} from "./authShared";

// Shoo uses a pairwise subject per origin (see https://docs.shoo.dev — "Pairwise subject").
// JWT `aud` is the redirect origin (e.g. `origin:http://localhost:5174`). Convex needs one
// customJwt provider per distinct audience you accept.
//
// Add every origin you serve (production, previews) to the defaults in authShared.ts or
// the comma-separated `EXTRA_SHOO_JWT_AUDIENCES` environment variable.
// Each value must match Shoo’s `aud` claim exactly (usually `origin:` + your site origin).
//
// Shoo tokens are only used to establish a session; day-to-day Convex requests use
// self-issued session JWTs minted by the /auth/* HTTP actions (see convex/http.ts),
// which are refreshed silently without any page navigation.

const shooProviders = shooJwtAudiences().map((applicationID) => ({
  type: "customJwt" as const,
  issuer: SHOO_ISSUER,
  jwks: SHOO_JWKS_URL,
  algorithm: "ES256" as const,
  applicationID,
}));

const sessionProvider = {
  type: "customJwt" as const,
  issuer: process.env.CONVEX_SITE_URL ?? "",
  jwks: `${process.env.CONVEX_SITE_URL ?? ""}/.well-known/jwks.json`,
  algorithm: "ES256" as const,
  applicationID: SESSION_JWT_AUDIENCE,
};

export default {
  providers: [...shooProviders, sessionProvider],
} satisfies AuthConfig;
