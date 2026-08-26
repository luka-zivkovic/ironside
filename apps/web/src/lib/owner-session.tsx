import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OwnerSessionResponse } from "@ironside/shared/browser";
import { ApiError } from "./api.js";
import { fetchOwnerAuthStatus, fetchOwnerSession, logoutOwner } from "./owner-auth-api.js";

export type OwnerGateState =
  | { status: "loading" }
  | { status: "setup" }
  | { status: "anonymous"; organizationName: string; username: string }
  | { status: "authenticated"; session: OwnerSessionResponse }
  | { status: "error"; message: string };

interface OwnerSessionContextValue {
  state: OwnerGateState;
  refresh: () => Promise<void>;
  acceptSession: (session: OwnerSessionResponse) => void;
  signOut: () => Promise<void>;
}

const OwnerSessionContext = createContext<OwnerSessionContextValue | null>(null);

export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OwnerGateState>({ status: "loading" });

  const refresh = useCallback(async () => {
    // Keep authenticated screens stable during focus/deadline revalidation;
    // the response below will replace the state if the session was revoked.
    setState((current) => current.status === "authenticated" ? current : { status: "loading" });
    try {
      const status = await fetchOwnerAuthStatus();
      if (status.state === "setup") {
        setState({ status: "setup" });
        return;
      }
      try {
        const session = await fetchOwnerSession();
        setState({ status: "authenticated", session });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setState({
            status: "anonymous",
            organizationName: status.organizationName,
            username: status.username
          });
          return;
        }
        throw error;
      }
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not load owner access" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (state.status !== "authenticated") return;

    const deadline = Math.min(
      new Date(state.session.idleExpiresAt).getTime(),
      new Date(state.session.absoluteExpiresAt).getTime()
    );
    let revalidating = false;
    const revalidate = () => {
      if (revalidating) return;
      revalidating = true;
      void refresh().finally(() => {
        revalidating = false;
      });
    };
    const timeout = window.setTimeout(revalidate, Math.max(1_000, deadline - Date.now() + 1_000));
    const revalidateVisibleSession = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidateVisibleSession);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidateVisibleSession);
    };
  }, [refresh, state]);

  const value = useMemo<OwnerSessionContextValue>(
    () => ({
      state,
      refresh,
      acceptSession: (session) => setState({ status: "authenticated", session }),
      signOut: async () => {
        const prior = state.status === "authenticated" ? state.session : null;
        await logoutOwner();
        if (prior) {
          setState({
            status: "anonymous",
            organizationName: prior.organizationName,
            username: prior.username
          });
        } else {
          await refresh();
        }
      }
    }),
    [refresh, state]
  );

  return <OwnerSessionContext.Provider value={value}>{children}</OwnerSessionContext.Provider>;
}

export function useOwnerSession(): OwnerSessionContextValue {
  const value = useContext(OwnerSessionContext);
  if (!value) throw new Error("useOwnerSession must be used within OwnerSessionProvider");
  return value;
}
