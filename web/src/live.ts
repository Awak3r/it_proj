import { authHeaders } from "./api";

// fetch keeps Telegram credentials in headers: native EventSource cannot set them.
export function startLiveUpdates(
  refresh: (force?: boolean) => Promise<boolean>,
) {
  let stopped = false;
  let connected = false;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let update: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  const tg = window.Telegram?.WebApp;
  const visible = () =>
    document.visibilityState !== "hidden" && tg?.isActive !== false;
  const invalidate = () => {
    if (stopped || !visible() || update) return;
    // Coalesce bursts; force a new read so an older in-flight snapshot cannot win.
    update = setTimeout(() => {
      update = undefined;
      if (!stopped && visible()) void refresh(true);
    }, 50);
  };
  async function connect() {
    if (stopped || !visible()) return;
    const attempt = new AbortController();
    controller = attempt;
    let watchdog: ReturnType<typeof setTimeout>;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => attempt.abort(), 45000);
    };
    alive();
    try {
      const response = await fetch("/api/updates", {
        headers: { ...authHeaders(), Accept: "text/event-stream" },
        signal: attempt.signal,
        cache: "no-store",
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      )
        throw new Error("Stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!attempt.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          alive();
          buffer += decoder.decode(value, { stream: true });
          // Keep partial frames/chunks, including split CRLF sequences.
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (stopped || controller !== attempt || attempt.signal.aborted)
              return;
            const event = frame
              .split(/\r?\n/)
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            if (event === "change") {
              connected = true;
              delay = 1000;
              invalidate(); // Initial/reconnected stream also requests a full snapshot.
            } else if (event === "unavailable") {
              connected = false;
            }
          }
          if (buffer.length > 65536) throw new Error("Invalid stream frame");
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Polling remains available while the stream reconnects.
    } finally {
      clearTimeout(watchdog!);
      attempt.abort();
      if (controller === attempt) {
        connected = false;
        controller = undefined;
        if (!stopped && visible()) {
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }
  }
  const resume = () => {
    clearTimeout(retry);
    const previous = controller;
    controller = undefined;
    previous?.abort();
    connected = false;
    if (!stopped && visible()) {
      delay = 1000;
      invalidate();
      void connect();
    }
  };
  const fallback = setInterval(() => {
    if (!connected && visible()) void refresh();
  }, 3000);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  tg?.onEvent?.("activated", resume);
  tg?.onEvent?.("deactivated", resume);
  void connect();
  return () => {
    stopped = true;
    clearInterval(fallback);
    clearTimeout(retry);
    clearTimeout(update);
    controller?.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
    tg?.offEvent?.("activated", resume);
    tg?.offEvent?.("deactivated", resume);
  };
}
