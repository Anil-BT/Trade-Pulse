/**
 * Decode Upstox Market Data Feed V3 protobuf messages.
 * Proto: https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
 */
import protobuf from "protobufjs";

const PROTO = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;

message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
}
message MarketLevel { repeated Quote bidAskQuote = 1; }
message MarketOHLC { repeated OHLC ohlc = 1; }
message Quote {
  int64 bidQ = 1;
  double bidP = 2;
  int64 askQ = 3;
  double askP = 4;
}
message OptionGreeks {
  double delta = 1;
  double theta = 2;
  double gamma = 3;
  double vega = 4;
  double rho = 5;
}
message OHLC {
  string interval = 1;
  double open = 2;
  double high = 3;
  double low = 4;
  double close = 5;
  int64 vol = 6;
  int64 ts = 7;
}
enum Type { initial_feed = 0; live_feed = 1; market_info = 2; }
message MarketFullFeed {
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq = 9;
  double tsq = 10;
}
message IndexFullFeed {
  LTPC ltpc = 1;
  MarketOHLC marketOHLC = 2;
}
message FullFeed {
  oneof FullFeedUnion {
    MarketFullFeed marketFF = 1;
    IndexFullFeed indexFF = 2;
  }
}
message FirstLevelWithGreeks {
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}
message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}
enum RequestMode {
  ltpc = 0;
  full_d5 = 1;
  option_greeks = 2;
  full_d30 = 3;
}
enum MarketStatus {
  PRE_OPEN_START = 0;
  PRE_OPEN_END = 1;
  NORMAL_OPEN = 2;
  NORMAL_CLOSE = 3;
  CLOSING_START = 4;
  CLOSING_END = 5;
}
message MarketInfo {
  map<string, MarketStatus> segmentStatus = 1;
}
message FeedResponse {
  Type type = 1;
  map<string, Feed> feeds = 2;
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`;

export type LiveTick = {
  instrumentKey: string;
  ltp: number;
  ltt: number;
  ltq: number;
  cp: number;
};

let FeedResponseType: protobuf.Type | null = null;

function getFeedResponseType(): protobuf.Type {
  if (!FeedResponseType) {
    const parsed = protobuf.parse(PROTO);
    FeedResponseType = parsed.root.lookupType(
      "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse"
    );
  }
  return FeedResponseType;
}

function extractLtpc(feed: Record<string, unknown>): {
  ltp: number;
  ltt: number;
  ltq: number;
  cp: number;
} | null {
  // Feed.ltpc
  const direct = feed.ltpc as Record<string, number> | undefined;
  if (direct && Number.isFinite(direct.ltp)) {
    return {
      ltp: Number(direct.ltp),
      ltt: Number(direct.ltt || 0),
      ltq: Number(direct.ltq || 0),
      cp: Number(direct.cp || 0),
    };
  }
  // fullFeed.marketFF.ltpc / indexFF.ltpc
  const full = feed.fullFeed as Record<string, unknown> | undefined;
  if (full) {
    const mff = full.marketFF as Record<string, unknown> | undefined;
    const iff = full.indexFF as Record<string, unknown> | undefined;
    const ltpc = (mff?.ltpc || iff?.ltpc) as Record<string, number> | undefined;
    if (ltpc && Number.isFinite(ltpc.ltp)) {
      return {
        ltp: Number(ltpc.ltp),
        ltt: Number(ltpc.ltt || 0),
        ltq: Number(ltpc.ltq || 0),
        cp: Number(ltpc.cp || 0),
      };
    }
  }
  const fl = feed.firstLevelWithGreeks as Record<string, unknown> | undefined;
  if (fl?.ltpc) {
    const ltpc = fl.ltpc as Record<string, number>;
    if (Number.isFinite(ltpc.ltp)) {
      return {
        ltp: Number(ltpc.ltp),
        ltt: Number(ltpc.ltt || 0),
        ltq: Number(ltpc.ltq || 0),
        cp: Number(ltpc.cp || 0),
      };
    }
  }
  return null;
}

/** Decode a binary WebSocket frame into ticks. */
export function decodeFeedBuffer(buf: ArrayBuffer | Uint8Array): {
  type: string;
  ticks: LiveTick[];
  currentTs: number;
  marketInfo?: Record<string, string | number>;
} {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const Type = getFeedResponseType();
  const msg = Type.decode(bytes) as unknown as {
    type?: number;
    feeds?: Record<string, Record<string, unknown>>;
    currentTs?: number | string;
    marketInfo?: { segmentStatus?: Record<string, number> };
  };
  const decoded = Type.toObject(msg as protobuf.Message, {
    longs: Number,
    enums: String,
    defaults: true,
  }) as {
    type?: string | number;
    feeds?: Record<string, Record<string, unknown>>;
    currentTs?: number;
    marketInfo?: { segmentStatus?: Record<string, string | number> };
  };

  const type =
    typeof decoded.type === "string"
      ? decoded.type
      : decoded.type === 2
        ? "market_info"
        : decoded.type === 0
          ? "initial_feed"
          : "live_feed";

  const ticks: LiveTick[] = [];
  const feeds = decoded.feeds || {};
  for (const [instrumentKey, feed] of Object.entries(feeds)) {
    if (!feed || typeof feed !== "object") continue;
    const ltpc = extractLtpc(feed);
    if (!ltpc || !(ltpc.ltp > 0)) continue;
    ticks.push({
      instrumentKey,
      ltp: ltpc.ltp,
      ltt: ltpc.ltt,
      ltq: ltpc.ltq,
      cp: ltpc.cp,
    });
  }

  return {
    type,
    ticks,
    currentTs: Number(decoded.currentTs || 0),
    marketInfo: decoded.marketInfo?.segmentStatus,
  };
}

/** Build binary subscription message (JSON as ArrayBuffer). */
export function buildSubscribeBinary(
  instrumentKeys: string[],
  mode: "ltpc" | "full" = "ltpc"
): ArrayBuffer {
  const payload = {
    guid: Math.random().toString(36).slice(2, 12),
    method: "sub",
    data: {
      mode,
      instrumentKeys,
    },
  };
  const json = JSON.stringify(payload);
  const enc = new TextEncoder();
  return enc.encode(json).buffer as ArrayBuffer;
}
