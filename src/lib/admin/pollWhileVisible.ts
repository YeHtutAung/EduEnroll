interface VisibilityDocument {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `run` every `intervalMs`, but only while the tab is visible. A tab left
 * open in the background otherwise keeps querying the database for numbers
 * nobody is looking at.
 *
 * When the tab comes back, `run` fires once if the data has gone stale. The
 * caller does its own first load. Returns a clean-up function.
 */
export function pollWhileVisible(
  run: () => void,
  intervalMs: number,
  doc: VisibilityDocument = document,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRun = Date.now();

  const tick = () => {
    lastRun = Date.now();
    run();
  };
  const start = () => {
    if (timer === null) timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibilityChange = () => {
    if (doc.visibilityState !== "visible") {
      stop();
      return;
    }
    if (Date.now() - lastRun >= intervalMs) tick();
    start();
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  if (doc.visibilityState === "visible") start();

  return () => {
    stop();
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
