// A saved medicine change (add, edit, pause) changes which doses Today shows: the database
// trigger deletes future pending doses and asks the dose generator for new ones. The Today screen
// stays mounted underneath other screens, so it must be told to reload. This is a plain listener
// list, so it works the same in a Stack, in tabs and in Jest (no navigation context needed).

type Listener = () => void;

const listeners = new Set<Listener>();

export function requestTodayReload(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A failing listener must not stop the others or the save that triggered it.
    }
  }
}

export function onTodayReloadRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
