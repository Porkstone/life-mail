import { useCallback, useEffect, useRef, useState } from "react";
import { createShooAuth, decodeIdentityClaims } from "@shoojs/react";
import type { StartSignInOptions } from "@shoojs/react";

const MANUAL_SIGN_OUT_KEY = "shoo_manual_sign_out";
const REFRESH_LEEWAY_MS = 90_000;
const SESSION_MONITOR_INTERVAL_MS = 60_000;

const shoo = createShooAuth({
  callbackPath: "/shoo/callback",
  requestPii: true,
});

let reauthInFlight: Promise<void> | null = null;

function currentRoute() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function isCallbackRoute() {
  return window.location.pathname === "/shoo/callback";
}

function hasManualSignOut() {
  return window.sessionStorage.getItem(MANUAL_SIGN_OUT_KEY) === "1";
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

function scheduleTokenRefresh({
  expiresAtMs,
  onRefresh,
}: {
  expiresAtMs: number;
  onRefresh: () => void;
}) {
  const delayMs = Math.max(0, expiresAtMs - Date.now() - REFRESH_LEEWAY_MS);
  return window.setTimeout(onRefresh, delayMs);
}

function beginReauth({
  onStarted,
}: {
  onStarted?: () => void;
} = {}) {
  if (hasManualSignOut()) {
    return Promise.resolve();
  }

  if (reauthInFlight !== null) {
    return reauthInFlight;
  }

  onStarted?.();

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
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionMonitor = useRef<ReturnType<typeof shoo.startSessionMonitor> | null>(
    null,
  );

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();
    const state = readStoredTokenState();
    if (state.expiresAtMs === null || hasExpired(state.expiresAtMs)) {
      return;
    }

    refreshTimer.current = scheduleTokenRefresh({
      expiresAtMs: state.expiresAtMs,
      onRefresh: () => {
        void beginReauth({
          onStarted: () => setIsReauthing(true),
        }).catch(() => setIsReauthing(false));
      },
    });
  }, [clearRefreshTimer]);

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
        clearRefreshTimer();
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
  }, [clearRefreshTimer, stopSessionMonitor]);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;

    void shoo.handleCallback().finally(() => {
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
        scheduleRefresh();
      } else {
        stopSessionMonitor();
        clearRefreshTimer();
      }
      setIsAuthenticated(authenticated);
      setIsLoading(false);
    });
  }, [
    clearRefreshTimer,
    scheduleRefresh,
    startSessionMonitor,
    stopSessionMonitor,
  ]);

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
      clearRefreshTimer();
    };
  }, [clearRefreshTimer, stopSessionMonitor]);

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
        clearRefreshTimer();
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
      scheduleRefresh();

      if (opts.forceRefreshToken && expiresSoon(state.expiresAtMs)) {
        void beginReauth({
          onStarted: () => setIsReauthing(true),
        }).catch(() => setIsReauthing(false));
      }

      return state.token;
    },
    [
      clearRefreshTimer,
      scheduleRefresh,
      startSessionMonitor,
      stopSessionMonitor,
    ],
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
  await shoo.startSignIn(opts);
}

export function signOut() {
  window.sessionStorage.setItem(MANUAL_SIGN_OUT_KEY, "1");
  shoo.clearIdentity();
  window.location.reload();
}
