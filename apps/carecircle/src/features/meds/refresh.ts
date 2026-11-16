// The Meds tab stays mounted while the scan screen is open on top of it. When a medicine is saved
// somewhere else (the prescription scan), the Meds list must be told to reload, or the person goes
// back to a list without the medicine they just saved. A plain listener list, like
// features/today/refresh.ts, so it works the same in a Stack, in tabs and in Jest.

type Listener = () => void;

const listeners = new Set<Listener>();

export function requestMedsReload(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A failing listener must not stop the others or the save that triggered it.
    }
  }
}

export function onMedsReloadRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
