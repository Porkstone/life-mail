import { useCallback, useEffect, useRef, useState } from "react";
import { createShooAuth, decodeIdentityClaims } from "@shoojs/react";
import type { StartSignInOptions } from "@shoojs/react";

// Shoo id_tokens only live 5 minutes and can only be renewed with a full-page
// redirect to shoo.dev, which made the app reload every few minutes. Instead,
// the Shoo token is exchanged once (at sign-in) for a session issued by our
// Convex backend: a 1-hour access token plus a 30-day refresh token that is
// renewed silently over fetch — no page navigation. See convex/http.ts.

const MANUAL_SIGN_OUT_KEY = "shoo_manual_sign_out";
const AUTH_ATTEMPT_STORAGE_KEY = "shoo_auth_attempted_at";
const AUTH_ATTEMPT_COOLDOWN_MS = 75_000;
const SESSION_STORAGE_KEY = "life-mail_session";
const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 120_000;

const shoo = createShooAuth({
  callbackPath: "/shoo/callback",
  requestPii: true,
});

type StoredSession = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
};

let reauthInFlight: Promise<void> | null = null;
let callbackInFlight: Promise<void> | null = null;
let refreshInFlight: Promise<StoredSession | null> | null = null;

function convexSiteUrl() {
  const override = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (override !== undefined) return override;

  const cloudUrl = import.meta.env.VITE_CONVEX_URL as string;
  return cloudUrl.replace(/\.convex\.cloud$/, ".convex.site");
}

function currentRoute() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function isCallbackRoute() {
  return window.location.pathname === "/shoo/callback";
}

function hasManualSignOut() {
  return window.sessionStorage.getItem(MANUAL_SIGN_OUT_KEY) === "1";
}

export function needsManualSignIn() {
  return hasManualSignOut();
}

function hasRecentAuthAttempt() {
  const attemptedAt = Number(
    window.sessionStorage.getItem(AUTH_ATTEMPT_STORAGE_KEY),
  );

  return Number.isFinite(attemptedAt)
    && Date.now() - attemptedAt < AUTH_ATTEMPT_COOLDOWN_MS;
}

function markAuthAttempt() {
  window.sessionStorage.setItem(AUTH_ATTEMPT_STORAGE_KEY, String(Date.now()));
}

function readSession(): StoredSession | null {
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.accessTokenExpiresAt !== "number" ||
      typeof parsed.refreshToken !== "string"
    )
      return null;

    return {
      accessToken: parsed.accessToken,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      refreshToken: parsed.refreshToken,
    };
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

function readValidShooToken() {
  const identity = shoo.getIdentity();
  if (identity.userId === null || identity.token === undefined) return null;

  const claims = decodeIdentityClaims(identity.token);
  if (typeof claims?.exp !== "number" || claims.exp * 1000 <= Date.now())
    return null;

  return identity.token;
}

async function exchangeShooTokenForSession(idToken: string) {
  const response = await fetch(`${convexSiteUrl()}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    accessToken: string;
    expiresInSeconds: number;
    refreshToken: string;
  };

  const session: StoredSession = {
    accessToken: data.accessToken,
    accessTokenExpiresAt: Date.now() + data.expiresInSeconds * 1000,
    refreshToken: data.refreshToken,
  };
  writeSession(session);
  return session;
}

// Returns the refreshed session, the existing session on transient network
// errors (so Convex can retry), or null when the session is truly dead.
async function refreshSessionOnce(session: StoredSession) {
  if (refreshInFlight !== null) return refreshInFlight;

  const promise = (async () => {
    let response: Response;
    try {
      response = await fetch(`${convexSiteUrl()}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
    } catch {
      return session;
    }

    if (response.status === 401) {
      clearSession();
      return null;
    }
    if (!response.ok) return session;

    const data = (await response.json()) as {
      accessToken: string;
      expiresInSeconds: number;
    };
    const refreshed: StoredSession = {
      accessToken: data.accessToken,
      accessTokenExpiresAt: Date.now() + data.expiresInSeconds * 1000,
      refreshToken: session.refreshToken,
    };
    writeSession(refreshed);
    return refreshed;
  })().finally(() => {
    refreshInFlight = null;
  });

  refreshInFlight = promise;
  return promise;
}

function beginReauth() {
  if (hasManualSignOut() || hasRecentAuthAttempt()) return Promise.resolve();

  if (reauthInFlight !== null) return reauthInFlight;

  markAuthAttempt();
  const promise = shoo
    .startSignIn({
      requestPii: true,
      returnTo: currentRoute(),
    })
    .then(() => undefined)
    .finally(() => {
      reauthInFlight = null;
    });
  reauthInFlight = promise;
  return reauthInFlight;
}

function handleCallbackOnce() {
  if (!isCallbackRoute()) return Promise.resolve();

  if (callbackInFlight !== null) return callbackInFlight;

  const promise = shoo
    .handleCallback()
    .then(() => undefined)
    .finally(() => {
      callbackInFlight = null;
    });
  callbackInFlight = promise;
  return callbackInFlight;
}

export function useAuth() {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => readSession() !== null,
  );
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const initialize = async () => {
      try {
        await handleCallbackOnce();
      } catch (error: unknown) {
        console.error("Shoo callback failed", error);
        if (isCallbackRoute()) {
          window.location.replace("/");
          return;
        }
      }

      // handleCallback navigates away via location.replace; the session
      // exchange happens on the destination page's load instead.
      if (isCallbackRoute()) return;

      let session = readSession();
      if (session === null) {
        const shooToken = readValidShooToken();
        if (shooToken !== null) {
          session = await exchangeShooTokenForSession(shooToken);
          // The Shoo token is single-purpose now; the session is the source
          // of truth from here on.
          if (session !== null) shoo.clearIdentity();
        }
      }

      setIsAuthenticated(session !== null);
      setIsLoading(false);
    };

    void initialize();
  }, []);

  useEffect(() => {
    if (isLoading || isAuthenticated || isCallbackRoute() || hasManualSignOut())
      return;

    void beginReauth();
  }, [isAuthenticated, isLoading]);

  const fetchAccessToken = useCallback(
    async (opts: { forceRefreshToken: boolean }) => {
      const session = readSession();
      if (session === null) {
        setIsAuthenticated(false);
        return null;
      }

      const expiresSoon =
        session.accessTokenExpiresAt - Date.now() <=
        ACCESS_TOKEN_REFRESH_LEEWAY_MS;
      if (!opts.forceRefreshToken && !expiresSoon) return session.accessToken;

      const refreshed = await refreshSessionOnce(session);
      if (refreshed === null) {
        setIsAuthenticated(false);
        if (!hasManualSignOut()) void beginReauth();
        return null;
      }

      return refreshed.accessToken;
    },
    [],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}

export async function signIn(opts?: StartSignInOptions) {
  window.sessionStorage.removeItem(MANUAL_SIGN_OUT_KEY);
  window.sessionStorage.removeItem(AUTH_ATTEMPT_STORAGE_KEY);
  await shoo.startSignIn({ requestPii: true, ...opts });
}

export function signOut() {
  const session = readSession();
  if (session !== null) {
    void fetch(`${convexSiteUrl()}/auth/signout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      keepalive: true,
    }).catch(() => undefined);
  }

  window.sessionStorage.setItem(MANUAL_SIGN_OUT_KEY, "1");
  clearSession();
  shoo.clearIdentity();
  window.location.reload();
}
