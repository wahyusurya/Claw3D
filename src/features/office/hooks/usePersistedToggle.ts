/**
 * usePersistedToggle — boolean UI preference remembered per browser (localStorage).
 * Starts false and reads the stored value after mount (same pattern as useOnboardingState).
 */
import { useCallback, useEffect, useState } from "react";

export const usePersistedToggle = (storageKey: string): [boolean, () => void] => {
  const [value, setValue] = useState(false);

  useEffect(() => {
    try {
      setValue(window.localStorage.getItem(storageKey) === "true");
    } catch {
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setValue((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
      }
      return next;
    });
  }, [storageKey]);

  return [value, toggle];
};
