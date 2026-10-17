import { useEffect, useState } from "react";

/** The project the office team is working on ("owner/repo"), polled from the studio API. */
export const useActiveProject = (pollMs = 15_000): { project: string | null; loaded: boolean } => {
  const [state, setState] = useState<{ project: string | null; loaded: boolean }>({
    project: null,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/office/project", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { project?: unknown };
        if (cancelled) return;
        const project = typeof data.project === "string" && data.project ? data.project : null;
        setState((prev) => (prev.loaded && prev.project === project ? prev : { project, loaded: true }));
      } catch {
        // keep the last known value
      }
    };
    void load();
    const intervalId = window.setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pollMs]);

  return state;
};
