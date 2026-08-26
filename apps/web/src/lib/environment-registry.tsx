import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectEnvironment } from "@ironside/shared/browser";
import {
  ApiError,
  fetchProjectEnvironments,
  setProjectEnvironmentVisibility
} from "./api";
import { useActiveProject } from "./projects";

interface EnvironmentRegistryState {
  environments: ProjectEnvironment[];
  limit: number;
  overflowed: boolean;
  overflowLastSeenAt: string | null;
  lastRebuiltAt: string | null;
  loading: boolean;
  error: string | null;
}

interface EnvironmentRegistryContextValue extends EnvironmentRegistryState {
  reload(): Promise<void>;
  setHidden(environment: string, hidden: boolean): Promise<void>;
}

const EnvironmentRegistryContext = createContext<EnvironmentRegistryContextValue | null>(null);

const EMPTY: EnvironmentRegistryState = {
  environments: [],
  limit: 100,
  overflowed: false,
  overflowLastSeenAt: null,
  lastRebuiltAt: null,
  loading: true,
  error: null
};

export function EnvironmentRegistryProvider({ children }: { children: ReactNode }) {
  const { project } = useActiveProject();
  const [state, setState] = useState<EnvironmentRegistryState>(EMPTY);

  async function reload(): Promise<void> {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetchProjectEnvironments(project.id);
      setState({ ...response, loading: false, error: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof ApiError ? error.message : "Failed to load environments"
      }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY);
    fetchProjectEnvironments(project.id)
      .then((response) => {
        if (!cancelled) setState({ ...response, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof ApiError ? error.message : "Failed to load environments"
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  async function setHidden(environment: string, hidden: boolean): Promise<void> {
    const updated = await setProjectEnvironmentVisibility(project.id, environment, hidden);
    setState((current) => ({
      ...current,
      environments: current.environments.map((candidate) =>
        candidate.name === updated.name ? updated : candidate
      )
    }));
  }

  const value = useMemo(
    () => ({ ...state, reload, setHidden }),
    [project.id, state]
  );

  return (
    <EnvironmentRegistryContext.Provider value={value}>
      {children}
    </EnvironmentRegistryContext.Provider>
  );
}

export function useEnvironmentRegistry(): EnvironmentRegistryContextValue {
  const value = useContext(EnvironmentRegistryContext);
  if (!value) throw new Error("useEnvironmentRegistry must be used inside EnvironmentRegistryProvider");
  return value;
}

