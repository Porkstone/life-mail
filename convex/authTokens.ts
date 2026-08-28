import {
  SESSION_JWT_AUDIENCE,
  SHOO_ISSUER,
  SHOO_JWKS_URL,
  shooJwtAudiences,
} from "./authShared";

export const SESSION_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

type EcJwk = JsonWebKey & { kid?: string };

export type ShooVerifiedClaims = {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
};

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);

  return bytes;
}

function base64UrlDecodeToString(value: string) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(value));
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(value)));
}

function privateJwk() {
  const raw = process.env.AUTH_PRIVATE_JWK;
  if (raw === undefined)
    throw new Error("AUTH_PRIVATE_JWK environment variable is not set");

  return JSON.parse(raw) as EcJwk & { d?: string; key_ops?: string[] };
}

export function siteIssuer() {
  const issuer = process.env.CONVEX_SITE_URL;
  if (issuer === undefined)
    throw new Error("CONVEX_SITE_URL is not available");

  return issuer;
}

export function publicJwks() {
  const { d: _d, key_ops: _keyOps, ...publicPart } = privateJwk();

  return {
    keys: [{ ...publicPart, use: "sig", alg: "ES256" }],
  };
}

export function generateRefreshToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncodeBytes(bytes);
}

export async function hashRefreshToken(refreshToken: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(refreshToken),
  );

  return base64UrlEncodeBytes(new Uint8Array(digest));
}

export async function mintSessionToken(claims: ShooVerifiedClaims) {
  const jwk = privateJwk();
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: jwk.kid };
  const payload = {
    iss: siteIssuer(),
    aud: SESSION_JWT_AUDIENCE,
    sub: claims.subject,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    ...(claims.emailVerified !== undefined
      ? { email_verified: claims.emailVerified }
      : {}),
    ...(claims.name !== undefined ? { name: claims.name } : {}),
  };

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );

  return {
    token: `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`,
    expiresInSeconds: SESSION_TOKEN_TTL_SECONDS,
  };
}

export async function verifyShooToken(
  token: string,
): Promise<ShooVerifiedClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const header = JSON.parse(base64UrlDecodeToString(parts[0])) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "ES256") throw new Error("Unexpected token algorithm");

  const payload = JSON.parse(base64UrlDecodeToString(parts[1])) as {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (payload.iss !== SHOO_ISSUER) throw new Error("Unexpected token issuer");
  if (typeof payload.sub !== "string" || payload.sub.length === 0)
    throw new Error("Token is missing a subject");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now())
    throw new Error("Token has expired");
  if (payload.aud === undefined || !shooJwtAudiences().includes(payload.aud))
    throw new Error("Token audience is not allowed");

  const response = await fetch(SHOO_JWKS_URL);
  if (!response.ok)
    throw new Error(`Failed to fetch Shoo JWKS (${response.status})`);

  const jwks = (await response.json()) as { keys?: EcJwk[] };
  const candidates = (jwks.keys ?? []).filter(
    (key) =>
      key.kty === "EC" &&
      key.crv === "P-256" &&
      (header.kid === undefined || key.kid === header.kid),
  );
  if (candidates.length === 0)
    throw new Error("No matching Shoo signing key found");

  const signature = base64UrlDecodeToBytes(parts[2]);
  const signingInput = encoder.encode(`${parts[0]}.${parts[1]}`);

  for (const candidate of candidates) {
    const key = await crypto.subtle.importKey(
      "jwk",
      candidate,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      signingInput,
    );
    if (valid) {
      return {
        subject: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified,
        name: payload.name,
      };
    }
  }

  throw new Error("Token signature verification failed");
}
