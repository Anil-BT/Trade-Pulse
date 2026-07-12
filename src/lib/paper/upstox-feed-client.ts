/**
 * Browser client for Upstox Market Data Feed V3 (WebSocket + protobuf).
 */
import {
  buildSubscribeBinary,
  decodeFeedBuffer,
  type LiveTick,
} from "./upstox-feed-decode";

export type FeedStatus =
  | "idle"
  | "connecting"
  | "subscribed"
  | "error"
  | "closed";

export type UpstoxFeedClientOpts = {
  authorizedRedirectUri: string;
  instrumentKeys: string[];
  mode?: "ltpc" | "full";
  onTicks: (ticks: LiveTick[]) => void;
  onStatus: (status: FeedStatus, detail?: string) => void;
  /** Max keys per sub message (Upstox LTPC allows 5000 total) */
  batchSize?: number;
};

export class UpstoxFeedClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private opts: UpstoxFeedClientOpts;
  private tickCount = 0;

  constructor(opts: UpstoxFeedClientOpts) {
    this.opts = opts;
  }

  get ticksReceived() {
    return this.tickCount;
  }

  start() {
    this.closed = false;
    this.opts.onStatus("connecting", "Opening Upstox Market Data Feed…");
    try {
      // Authorized wss URL already embeds auth (from /authorize)
      this.ws = new WebSocket(this.opts.authorizedRedirectUri);
    } catch (e) {
      this.opts.onStatus(
        "error",
        e instanceof Error ? e.message : "WebSocket open failed"
      );
      return;
    }
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      if (this.closed) return;
      this.opts.onStatus("connecting", "Connected — subscribing…");
      this.subscribeAll();
    };

    this.ws.onmessage = (ev) => {
      if (this.closed) return;
      try {
        let buf: ArrayBuffer | null = null;
        if (ev.data instanceof ArrayBuffer) {
          buf = ev.data;
        } else if (ev.data instanceof Blob) {
          // async path
          void (ev.data as Blob).arrayBuffer().then((b) => {
            this.handleBinary(b);
          });
          return;
        } else if (typeof ev.data === "string") {
          // rare text path
          try {
            const j = JSON.parse(ev.data);
            if (j?.type === "market_info") {
              this.opts.onStatus("subscribed", "Market info received");
            }
          } catch {
            /* ignore */
          }
          return;
        }
        if (buf) this.handleBinary(buf);
      } catch (e) {
        // decode errors are non-fatal (heartbeats etc.)
      }
    };

    this.ws.onerror = () => {
      if (!this.closed) {
        this.opts.onStatus("error", "WebSocket error");
      }
    };

    this.ws.onclose = () => {
      if (!this.closed) {
        this.opts.onStatus("closed", "Feed disconnected");
      }
    };
  }

  private handleBinary(buf: ArrayBuffer) {
    try {
      const decoded = decodeFeedBuffer(buf);
      if (decoded.type === "market_info") {
        this.opts.onStatus("subscribed", "NSE segment status received");
        return;
      }
      if (decoded.ticks.length) {
        this.tickCount += decoded.ticks.length;
        this.opts.onTicks(decoded.ticks);
        if (this.tickCount < 50 || this.tickCount % 200 === 0) {
          this.opts.onStatus(
            "subscribed",
            `Streaming · ${this.tickCount} tick updates`
          );
        }
      }
    } catch {
      // ignore undecodable frames
    }
  }

  private subscribeAll() {
    const keys = this.opts.instrumentKeys;
    const batch = this.opts.batchSize ?? 1000;
    const mode = this.opts.mode ?? "ltpc";
    for (let i = 0; i < keys.length; i += batch) {
      const slice = keys.slice(i, i + batch);
      const bin = buildSubscribeBinary(slice, mode);
      this.ws?.send(bin);
    }
    this.opts.onStatus(
      "subscribed",
      `Subscribed ${keys.length} F&O underlyings (LTPC stream)`
    );
  }

  stop() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.opts.onStatus("closed", "Feed stopped");
  }
}
