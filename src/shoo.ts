import { useCallback, useEffect, useRef, useState } from "react";
import { createShooAuth, decodeIdentityClaims } from "@shoojs/react";
import type { StartSignInOptions } from "@shoojs/react";

const REFRESH_LEEWAY_MS = 30_000;

const shoo = createShooAuth({
  callbackPath: "/shoo/callback",
  requestPii: true,
});

let reauthInFlight: Promise<void> | null = null;

function readStoredTokenState() {
  const identity = shoo.getIdentity();
  const token = identity.token ?? null;
  const claims = token === null ? null : decodeIdentityClaims(token);

  return {
    token,
    userId: identity.userId,
    expiresAtMs: typeof claims?.exp === "number" ? claims.exp * 1000 : null,
  };
}

function hasExpired(expiresAtMs: number | null) {
  return expiresAtMs !== null && expiresAtMs <= Date.now();
}

function expiresSoon(expiresAtMs: number | null) {
  return expiresAtMs !== null && expiresAtMs - Date.now() <= REFRESH_LEEWAY_MS;
}

function beginReauth() {
  if (reauthInFlight !== null) {
    return reauthInFlight;
  }

  const promise = shoo
    .startSignIn()
    .then(() => undefined)
    .finally(() => {
      reauthInFlight = null;
    });
  reauthInFlight = promise;
  return reauthInFlight;
}

export function useAuth() {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    const state = readStoredTokenState();
    return (
      state.userId !== null &&
      state.token !== null &&
      !hasExpired(state.expiresAtMs)
    );
  });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;

    shoo.handleCallback().finally(() => {
      const state = readStoredTokenState();
      const authenticated =
        state.userId !== null &&
        state.token !== null &&
        !hasExpired(state.expiresAtMs);

      if (!authenticated && state.token !== null) {
        shoo.clearIdentity();
      }
      setIsAuthenticated(authenticated);
      setIsLoading(false);
    });
  }, []);

  const fetchAccessToken = useCallback(
    async (opts: { forceRefreshToken: boolean }) => {
      const state = readStoredTokenState();
      if (state.token === null || state.userId === null) {
        setIsAuthenticated(false);
        return null;
      }

      if (hasExpired(state.expiresAtMs)) {
        shoo.clearIdentity();
        setIsAuthenticated(false);
        if (opts.forceRefreshToken) {
          void beginReauth().catch(() => undefined);
        }
        return null;
      }

      setIsAuthenticated(true);

      if (opts.forceRefreshToken && expiresSoon(state.expiresAtMs)) {
        void beginReauth().catch(() => undefined);
      }

      return state.token;
    },
    [],
  );

  return { isLoading, isAuthenticated, fetchAccessToken };
}

export async function signIn(opts?: StartSignInOptions) {
  await shoo.startSignIn(opts);
}

export function signOut() {
  shoo.clearIdentity();
  window.location.reload();
}
