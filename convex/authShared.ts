export const SHOO_ISSUER = "https://shoo.dev";
export const SHOO_JWKS_URL = "https://shoo.dev/.well-known/jwks.json";

// Audience claim for the session JWTs this app mints for itself.
export const SESSION_JWT_AUDIENCE = "life-mail";

const DEFAULT_APP_ORIGINS = [
  "http://localhost:5174",
  "https://life-mail.vercel.app",
] as const;

function extraShooJwtAudiences() {
  return (process.env.EXTRA_SHOO_JWT_AUDIENCES ?? "")
    .split(",")
    .map((audience) => audience.trim())
    .filter((audience) => audience.length > 0);
}

export function shooJwtAudiences() {
  return [
    ...new Set([
      ...DEFAULT_APP_ORIGINS.map((origin) => `origin:${origin}`),
      ...extraShooJwtAudiences(),
    ]),
  ];
}

export function allowedAppOrigins() {
  return [
    ...new Set(
      shooJwtAudiences().map((audience) =>
        audience.startsWith("origin:")
          ? audience.slice("origin:".length)
          : audience,
      ),
    ),
  ];
}
