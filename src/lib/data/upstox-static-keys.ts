/**
 * Common NSE equity instrument keys (Upstox) — refreshed from instrument master.
 * Used only as fallback when the live master cannot be downloaded.
 * Prefer live master resolve for accuracy (ISINs change after corp actions).
 */
export const UPSTOX_NSE_EQ_KEYS: Record<
  string,
  { instrumentKey: string; tradingSymbol: string; name: string }
> = {
  RELIANCE: {
    instrumentKey: "NSE_EQ|INE002A01018",
    tradingSymbol: "RELIANCE",
    name: "RELIANCE INDUSTRIES LTD",
  },
  TCS: {
    instrumentKey: "NSE_EQ|INE467B01029",
    tradingSymbol: "TCS",
    name: "TATA CONSULTANCY SERV LT",
  },
  INFY: {
    instrumentKey: "NSE_EQ|INE009A01021",
    tradingSymbol: "INFY",
    name: "INFOSYS LIMITED",
  },
  HDFCBANK: {
    instrumentKey: "NSE_EQ|INE040A01034",
    tradingSymbol: "HDFCBANK",
    name: "HDFC BANK LTD",
  },
  SBIN: {
    instrumentKey: "NSE_EQ|INE062A01020",
    tradingSymbol: "SBIN",
    name: "STATE BANK OF INDIA",
  },
  ICICIBANK: {
    instrumentKey: "NSE_EQ|INE090A01021",
    tradingSymbol: "ICICIBANK",
    name: "ICICI BANK LTD.",
  },
  BHARTIARTL: {
    instrumentKey: "NSE_EQ|INE397D01024",
    tradingSymbol: "BHARTIARTL",
    name: "BHARTI AIRTEL LIMITED",
  },
  ITC: {
    instrumentKey: "NSE_EQ|INE154A01025",
    tradingSymbol: "ITC",
    name: "ITC LTD",
  },
  LT: {
    instrumentKey: "NSE_EQ|INE018A01030",
    tradingSymbol: "LT",
    name: "LARSEN & TOUBRO LTD.",
  },
  AXISBANK: {
    instrumentKey: "NSE_EQ|INE238A01034",
    tradingSymbol: "AXISBANK",
    name: "AXIS BANK LIMITED",
  },
  KOTAKBANK: {
    instrumentKey: "NSE_EQ|INE237A01036",
    tradingSymbol: "KOTAKBANK",
    name: "KOTAK MAHINDRA BANK LTD",
  },
  WIPRO: {
    instrumentKey: "NSE_EQ|INE075A01022",
    tradingSymbol: "WIPRO",
    name: "WIPRO LTD",
  },
  HINDUNILVR: {
    instrumentKey: "NSE_EQ|INE030A01027",
    tradingSymbol: "HINDUNILVR",
    name: "HINDUSTAN UNILEVER LTD.",
  },
  BAJFINANCE: {
    instrumentKey: "NSE_EQ|INE296A01032",
    tradingSymbol: "BAJFINANCE",
    name: "BAJAJ FINANCE LIMITED",
  },
  MARUTI: {
    instrumentKey: "NSE_EQ|INE585B01010",
    tradingSymbol: "MARUTI",
    name: "MARUTI SUZUKI INDIA LTD.",
  },
  SUNPHARMA: {
    instrumentKey: "NSE_EQ|INE044A01036",
    tradingSymbol: "SUNPHARMA",
    name: "SUN PHARMACEUTICAL IND L",
  },
  /** Post demerger commercial vehicles entity (old TATAMOTORS) */
  TMCV: {
    instrumentKey: "NSE_EQ|INE1TAE01010",
    tradingSymbol: "TMCV",
    name: "TATA MOTORS LIMITED",
  },
  /** Passenger vehicles (old TATAMOTORS PV) */
  TMPV: {
    instrumentKey: "NSE_EQ|INE155A01022",
    tradingSymbol: "TMPV",
    name: "TATA MOTORS PASS VEH LTD",
  },
  /** Alias for renamed Tata Motors */
  TATAMOTORS: {
    instrumentKey: "NSE_EQ|INE1TAE01010",
    tradingSymbol: "TMCV",
    name: "TATA MOTORS LIMITED",
  },
  TATASTEEL: {
    instrumentKey: "NSE_EQ|INE081A01020",
    tradingSymbol: "TATASTEEL",
    name: "TATA STEEL LIMITED",
  },
  NTPC: {
    instrumentKey: "NSE_EQ|INE733E01010",
    tradingSymbol: "NTPC",
    name: "NTPC LTD",
  },
  POWERGRID: {
    instrumentKey: "NSE_EQ|INE752E01010",
    tradingSymbol: "POWERGRID",
    name: "POWER GRID CORP. LTD.",
  },
  ULTRACEMCO: {
    instrumentKey: "NSE_EQ|INE481G01011",
    tradingSymbol: "ULTRACEMCO",
    name: "ULTRATECH CEMENT LIMITED",
  },
  TITAN: {
    instrumentKey: "NSE_EQ|INE280A01028",
    tradingSymbol: "TITAN",
    name: "TITAN COMPANY LIMITED",
  },
  ASIANPAINT: {
    instrumentKey: "NSE_EQ|INE021A01026",
    tradingSymbol: "ASIANPAINT",
    name: "ASIAN PAINTS LIMITED",
  },
  NESTLEIND: {
    instrumentKey: "NSE_EQ|INE239A01024",
    tradingSymbol: "NESTLEIND",
    name: "NESTLE INDIA LIMITED",
  },
  "M&M": {
    instrumentKey: "NSE_EQ|INE101A01026",
    tradingSymbol: "M&M",
    name: "MAHINDRA & MAHINDRA LTD",
  },
  ADANIENT: {
    instrumentKey: "NSE_EQ|INE423A01024",
    tradingSymbol: "ADANIENT",
    name: "ADANI ENTERPRISES LIMITED",
  },
  ADANIPORTS: {
    instrumentKey: "NSE_EQ|INE742F01042",
    tradingSymbol: "ADANIPORTS",
    name: "ADANI PORT & SEZ LTD",
  },
  ONGC: {
    instrumentKey: "NSE_EQ|INE213A01029",
    tradingSymbol: "ONGC",
    name: "OIL AND NATURAL GAS CORP.",
  },
  COALINDIA: {
    instrumentKey: "NSE_EQ|INE522F01014",
    tradingSymbol: "COALINDIA",
    name: "COAL INDIA LTD",
  },
  JSWSTEEL: {
    instrumentKey: "NSE_EQ|INE019A01038",
    tradingSymbol: "JSWSTEEL",
    name: "JSW STEEL LIMITED",
  },
  HCLTECH: {
    instrumentKey: "NSE_EQ|INE860A01027",
    tradingSymbol: "HCLTECH",
    name: "HCL TECHNOLOGIES LTD",
  },
  TECHM: {
    instrumentKey: "NSE_EQ|INE669C01036",
    tradingSymbol: "TECHM",
    name: "TECH MAHINDRA LIMITED",
  },
  INDUSINDBK: {
    instrumentKey: "NSE_EQ|INE095A01012",
    tradingSymbol: "INDUSINDBK",
    name: "INDUSIND BANK LIMITED",
  },
  BAJAJFINSV: {
    instrumentKey: "NSE_EQ|INE918I01026",
    tradingSymbol: "BAJAJFINSV",
    name: "BAJAJ FINSERV LTD.",
  },
  CIPLA: {
    instrumentKey: "NSE_EQ|INE059A01026",
    tradingSymbol: "CIPLA",
    name: "CIPLA LTD",
  },
  DRREDDY: {
    instrumentKey: "NSE_EQ|INE089A01031",
    tradingSymbol: "DRREDDY",
    name: "DR. REDDY S LABORATORIES",
  },
  APOLLOHOSP: {
    instrumentKey: "NSE_EQ|INE437A01024",
    tradingSymbol: "APOLLOHOSP",
    name: "APOLLO HOSPITALS ENTER. L",
  },
  DIVISLAB: {
    instrumentKey: "NSE_EQ|INE361B01024",
    tradingSymbol: "DIVISLAB",
    name: "DIVI S LABORATORIES LTD",
  },
  EICHERMOT: {
    instrumentKey: "NSE_EQ|INE066A01021",
    tradingSymbol: "EICHERMOT",
    name: "EICHER MOTORS LTD",
  },
  HEROMOTOCO: {
    instrumentKey: "NSE_EQ|INE158A01026",
    tradingSymbol: "HEROMOTOCO",
    name: "HERO MOTOCORP LIMITED",
  },
  BRITANNIA: {
    instrumentKey: "NSE_EQ|INE216A01030",
    tradingSymbol: "BRITANNIA",
    name: "BRITANNIA INDUSTRIES LTD",
  },
  BPCL: {
    instrumentKey: "NSE_EQ|INE029A01011",
    tradingSymbol: "BPCL",
    name: "BHARAT PETROLEUM CORP  LT",
  },
  HDFCLIFE: {
    instrumentKey: "NSE_EQ|INE795G01014",
    tradingSymbol: "HDFCLIFE",
    name: "HDFC LIFE INS CO LTD",
  },
  SBILIFE: {
    instrumentKey: "NSE_EQ|INE123W01016",
    tradingSymbol: "SBILIFE",
    name: "SBI LIFE INSURANCE CO LTD",
  },
  TRENT: {
    instrumentKey: "NSE_EQ|INE849A01020",
    tradingSymbol: "TRENT",
    name: "TRENT LTD",
  },
  BEL: {
    instrumentKey: "NSE_EQ|INE263A01024",
    tradingSymbol: "BEL",
    name: "BHARAT ELECTRONICS LTD",
  },
  NIFTYBEES: {
    instrumentKey: "NSE_EQ|INF204KB14I2",
    tradingSymbol: "NIFTYBEES",
    name: "NIP IND ETF NIFTY BEES",
  },
};

/** Symbols that were renamed on NSE */
const ALIASES: Record<string, string> = {
  TATAMOTORS: "TMCV",
};

export function lookupStaticUpstoxKey(symbol: string) {
  const key = symbol
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "");
  const mapped = ALIASES[key] || key;
  return UPSTOX_NSE_EQ_KEYS[mapped] || UPSTOX_NSE_EQ_KEYS[key] || null;
}
