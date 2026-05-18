import { useCallback, useEffect, useRef, useState } from "react";
import { createShooAuth, decodeIdentityClaims } from "@shoojs/react";
import type { StartSignInOptions } from "@shoojs/react";

const MANUAL_SIGN_OUT_KEY = "shoo_manual_sign_out";
const AUTH_ATTEMPT_STORAGE_KEY = "shoo_auth_attempted_at";
const AUTH_ATTEMPT_COOLDOWN_MS = 75_000;
const REFRESH_LEEWAY_MS = 30_000;
const SESSION_MONITOR_INTERVAL_MS = 60_000;

const shoo = createShooAuth({
  callbackPath: "/shoo/callback",
  requestPii: true,
});

let reauthInFlight: Promise<void> | null = null;
let callbackInFlight: Promise<void> | null = null;

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

function beginReauth({
  onStarted,
}: {
  onStarted?: () => void;
} = {}) {
  if (hasManualSignOut() || hasRecentAuthAttempt()) {
    return Promise.resolve();
  }

  if (reauthInFlight !== null) {
    return reauthInFlight;
  }

  onStarted?.();
  markAuthAttempt();

  const promise = shoo
    .startSignIn({
      requestPii: false,
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
  if (!isCallbackRoute()) {
    return Promise.resolve();
  }

  if (callbackInFlight !== null) {
    return callbackInFlight;
  }

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
  const [isReauthing, setIsReauthing] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    const state = readStoredTokenState();
    return (
      state.userId !== null &&
      state.token !== null &&
      !hasExpired(state.expiresAtMs)
    );
  });
  const ran = useRef(false);
  const sessionMonitor = useRef<ReturnType<typeof shoo.startSessionMonitor> | null>(
    null,
  );

  const stopSessionMonitor = useCallback(() => {
    sessionMonitor.current?.stop();
    sessionMonitor.current = null;
  }, []);

  const startSessionMonitor = useCallback(() => {
    if (sessionMonitor.current !== null) {
      return;
    }

    sessionMonitor.current = shoo.startSessionMonitor({
      intervalMs: SESSION_MONITOR_INTERVAL_MS,
      immediate: true,
      onLoginRequired: () => {
        stopSessionMonitor();
        if (hasManualSignOut()) {
          shoo.clearIdentity();
          setIsAuthenticated(false);
          return;
        }

        void beginReauth({
          onStarted: () => setIsReauthing(true),
        }).catch(() => {
          shoo.clearIdentity();
          setIsAuthenticated(false);
          setIsReauthing(false);
        });
      },
      onError: () => {
        // Keep local state and let the next monitor tick retry.
      },
    });
  }, [stopSessionMonitor]);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;

    void handleCallbackOnce()
      .catch((error: unknown) => {
        console.error("Shoo callback failed", error);
        if (isCallbackRoute()) {
          window.location.replace("/");
        }
      })
      .finally(() => {
      const state = readStoredTokenState();
      const authenticated =
        state.userId !== null &&
        state.token !== null &&
        !hasExpired(state.expiresAtMs);

      if (!authenticated && state.token !== null) {
        shoo.clearIdentity();
      }
      if (authenticated) {
        startSessionMonitor();
      } else {
        stopSessionMonitor();
      }
      setIsAuthenticated(authenticated);
      setIsLoading(false);
      });
  }, [startSessionMonitor, stopSessionMonitor]);

  useEffect(() => {
    if (isLoading || isAuthenticated || isCallbackRoute() || hasManualSignOut()) {
      return;
    }

    void beginReauth({
      onStarted: () => setIsReauthing(true),
    }).catch(() => setIsReauthing(false));
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    return () => {
      stopSessionMonitor();
    };
  }, [stopSessionMonitor]);

  const fetchAccessToken = useCallback(
    async (opts: { forceRefreshToken: boolean }) => {
      const state = readStoredTokenState();
      if (state.token === null || state.userId === null) {
        stopSessionMonitor();
        setIsAuthenticated(false);
        return null;
      }

      if (hasExpired(state.expiresAtMs)) {
        stopSessionMonitor();
        shoo.clearIdentity();
        setIsAuthenticated(false);
        if (!hasManualSignOut()) {
          void beginReauth({
            onStarted: () => setIsReauthing(true),
          }).catch(() => setIsReauthing(false));
        }
        return null;
      }

      setIsAuthenticated(true);
      startSessionMonitor();

      if (opts.forceRefreshToken && expiresSoon(state.expiresAtMs)) {
        void beginReauth({
          onStarted: () => setIsReauthing(true),
        }).catch(() => setIsReauthing(false));
      }

      return state.token;
    },
    [startSessionMonitor, stopSessionMonitor],
  );

  return {
    isLoading,
    isAuthenticated,
    isReauthing,
    needsManualSignIn: hasManualSignOut(),
    fetchAccessToken,
  };
}

export async function signIn(opts?: StartSignInOptions) {
  window.sessionStorage.removeItem(MANUAL_SIGN_OUT_KEY);
  window.sessionStorage.removeItem(AUTH_ATTEMPT_STORAGE_KEY);
  await shoo.startSignIn(opts);
}

export function signOut() {
  window.sessionStorage.setItem(MANUAL_SIGN_OUT_KEY, "1");
  shoo.clearIdentity();
  window.location.reload();
}
