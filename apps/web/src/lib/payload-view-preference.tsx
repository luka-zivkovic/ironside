import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type PayloadViewPreference = "rendered" | "pretty" | "source" | "raw";

interface PayloadViewPreferenceContextValue {
  preference: PayloadViewPreference | null;
  setPreference: (preference: PayloadViewPreference) => void;
}

const STORAGE_KEY_PREFIX = "ironside.payloadViewMode.v1:";
const VALID_PREFERENCES = new Set<PayloadViewPreference>(["rendered", "pretty", "source", "raw"]);
const defaultContext: PayloadViewPreferenceContextValue = {
  preference: null,
  setPreference: () => undefined
};
const PayloadViewPreferenceContext = createContext<PayloadViewPreferenceContextValue>(defaultContext);

export function payloadViewPreferenceStorageKey(principalId: string): string {
  return `${STORAGE_KEY_PREFIX}${principalId}`;
}

export function readPayloadViewPreference(
  principalId: string,
  storage: Pick<Storage, "getItem"> | undefined = browserLocalStorage()
): PayloadViewPreference | null {
  try {
    const value = storage?.getItem(payloadViewPreferenceStorageKey(principalId));
    return value && VALID_PREFERENCES.has(value as PayloadViewPreference)
      ? value as PayloadViewPreference
      : null;
  } catch {
    return null;
  }
}

export function writePayloadViewPreference(
  principalId: string,
  preference: PayloadViewPreference,
  storage: Pick<Storage, "setItem"> | undefined = browserLocalStorage()
): void {
  try {
    storage?.setItem(payloadViewPreferenceStorageKey(principalId), preference);
  } catch {
    // This browser-local preference is non-secret and optional.
  }
}

export function PayloadViewPreferenceProvider({
  principalId,
  children
}: {
  principalId: string;
  children: ReactNode;
}) {
  const storageKey = payloadViewPreferenceStorageKey(principalId);
  const [preference, setPreferenceState] = useState<PayloadViewPreference | null>(() =>
    readPayloadViewPreference(principalId)
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setPreferenceState(readPayloadViewPreference(principalId));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [principalId, storageKey]);

  const setPreference = useCallback((nextPreference: PayloadViewPreference) => {
    setPreferenceState(nextPreference);
    writePayloadViewPreference(principalId, nextPreference);
  }, [principalId]);

  const value = useMemo<PayloadViewPreferenceContextValue>(
    () => ({ preference, setPreference }),
    [preference, setPreference]
  );

  return (
    <PayloadViewPreferenceContext.Provider value={value}>
      {children}
    </PayloadViewPreferenceContext.Provider>
  );
}

export function usePayloadViewPreference(): PayloadViewPreferenceContextValue {
  return useContext(PayloadViewPreferenceContext);
}

function browserLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
