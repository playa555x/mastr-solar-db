// In-Process Event-Bus für Server-Sent-Events.
// Verteiler-Pattern: Module rufen `publish(topic, payload)` auf, Subscriber-Streams
// erhalten den Payload als SSE-Frame.
//
// Topics-Schema:
//   - "user.<id>.activity"       → eigenes Activity-Feed
//   - "import.progress"          → Import-Cron-Progress (Admin-only)
//   - "webhook.delivery"         → Webhook-Delivery-Events (Admin-only)
//
// SSE-Frame Format:
//   event: <event-name>
//   data: <json>
//   id: <monotonic>
//   \n\n
//
// Heartbeat alle 25s als Comment ": ping\n\n" um Proxies/Load-Balancer offen zu halten.

type Subscriber = (payload: any, eventName?: string) => void;

const subscribers = new Map<string, Set<Subscriber>>();
let lastId = 0;

export function subscribe(topic: string, fn: Subscriber): () => void {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic)!.add(fn);
  return () => {
    subscribers.get(topic)?.delete(fn);
    if (subscribers.get(topic)?.size === 0) subscribers.delete(topic);
  };
}

export function publish(topic: string, payload: any, eventName = "message"): void {
  const subs = subscribers.get(topic);
  if (!subs) return;
  for (const fn of subs) {
    try { fn(payload, eventName); } catch (e) { console.error("[sse-bus] subscriber failed:", e); }
  }
}

export function nextId(): number { return ++lastId; }

/**
 * Erzeugt eine Standard-SSE-Response für ein einzelnes Topic.
 * Sender ist gebunden an die Lifetime des Streams (Abort → unsubscribe).
 */
export function sseResponse(req: Request, topic: string, opts?: { onOpen?: (write: (event: string, data: any) => void) => void }): Response {
  const encoder = new TextEncoder();
  let close: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const write = (event: string, data: any) => {
        try {
          const id = nextId();
          const frame = `id: ${id}\nevent: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch (e) { /* stream closed */ }
      };
      // Initial Ping
      try { controller.enqueue(encoder.encode(": connected\n\n")); } catch {}
      // Heartbeat
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(heartbeat); }
      }, 25_000);
      // Subscribe
      const unsub = subscribe(topic, (payload, eventName) => write(eventName || "message", payload));
      // Abort
      const onAbort = () => { clearInterval(heartbeat); unsub(); try { controller.close(); } catch {} };
      close = onAbort;
      req.signal.addEventListener("abort", onAbort);
      // Caller-Hook
      if (opts?.onOpen) opts.onOpen(write);
    },
    cancel() {
      try { close?.(); } catch {}
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
