/**
 * Common NSE equity instrument keys (Upstox).
 * Avoids downloading the full instrument master on every cold start.
 * Format: NSE_EQ|<ISIN> or exchange token keys as published by Upstox.
 */
export const UPSTOX_NSE_EQ_KEYS: Record<
  string,
  { instrumentKey: string; tradingSymbol: string; name: string }
> = {
  RELIANCE: {
    instrumentKey: "NSE_EQ|INE002A01018",
    tradingSymbol: "RELIANCE",
    name: "Reliance Industries",
  },
  TCS: {
    instrumentKey: "NSE_EQ|INE467B01029",
    tradingSymbol: "TCS",
    name: "Tata Consultancy Services",
  },
  INFY: {
    instrumentKey: "NSE_EQ|INE009A01021",
    tradingSymbol: "INFY",
    name: "Infosys",
  },
  HDFCBANK: {
    instrumentKey: "NSE_EQ|INE040A01034",
    tradingSymbol: "HDFCBANK",
    name: "HDFC Bank",
  },
  SBIN: {
    instrumentKey: "NSE_EQ|INE062A01020",
    tradingSymbol: "SBIN",
    name: "State Bank of India",
  },
  ICICIBANK: {
    instrumentKey: "NSE_EQ|INE090A01021",
    tradingSymbol: "ICICIBANK",
    name: "ICICI Bank",
  },
  BHARTIARTL: {
    instrumentKey: "NSE_EQ|INE397D01024",
    tradingSymbol: "BHARTIARTL",
    name: "Bharti Airtel",
  },
  ITC: {
    instrumentKey: "NSE_EQ|INE154A01025",
    tradingSymbol: "ITC",
    name: "ITC",
  },
  LT: {
    instrumentKey: "NSE_EQ|INE018A01030",
    tradingSymbol: "LT",
    name: "Larsen & Toubro",
  },
  AXISBANK: {
    instrumentKey: "NSE_EQ|INE238A01034",
    tradingSymbol: "AXISBANK",
    name: "Axis Bank",
  },
  KOTAKBANK: {
    instrumentKey: "NSE_EQ|INE237A01028",
    tradingSymbol: "KOTAKBANK",
    name: "Kotak Mahindra Bank",
  },
  WIPRO: {
    instrumentKey: "NSE_EQ|INE075A01022",
    tradingSymbol: "WIPRO",
    name: "Wipro",
  },
  HINDUNILVR: {
    instrumentKey: "NSE_EQ|INE030A01027",
    tradingSymbol: "HINDUNILVR",
    name: "Hindustan Unilever",
  },
  BAJFINANCE: {
    instrumentKey: "NSE_EQ|INE296A01024",
    tradingSymbol: "BAJFINANCE",
    name: "Bajaj Finance",
  },
  MARUTI: {
    instrumentKey: "NSE_EQ|INE585B01010",
    tradingSymbol: "MARUTI",
    name: "Maruti Suzuki",
  },
  SUNPHARMA: {
    instrumentKey: "NSE_EQ|INE044A01036",
    tradingSymbol: "SUNPHARMA",
    name: "Sun Pharmaceutical",
  },
  TATAMOTORS: {
    instrumentKey: "NSE_EQ|INE155A01022",
    tradingSymbol: "TATAMOTORS",
    name: "Tata Motors",
  },
  TATASTEEL: {
    instrumentKey: "NSE_EQ|INE081A01020",
    tradingSymbol: "TATASTEEL",
    name: "Tata Steel",
  },
  NTPC: {
    instrumentKey: "NSE_EQ|INE733E01010",
    tradingSymbol: "NTPC",
    name: "NTPC",
  },
  POWERGRID: {
    instrumentKey: "NSE_EQ|INE752E01010",
    tradingSymbol: "POWERGRID",
    name: "Power Grid",
  },
  ULTRACEMCO: {
    instrumentKey: "NSE_EQ|INE481G01011",
    tradingSymbol: "ULTRACEMCO",
    name: "UltraTech Cement",
  },
  TITAN: {
    instrumentKey: "NSE_EQ|INE280A01028",
    tradingSymbol: "TITAN",
    name: "Titan Company",
  },
  ASIANPAINT: {
    instrumentKey: "NSE_EQ|INE021A01026",
    tradingSymbol: "ASIANPAINT",
    name: "Asian Paints",
  },
  NESTLEIND: {
    instrumentKey: "NSE_EQ|INE239A01024",
    tradingSymbol: "NESTLEIND",
    name: "Nestle India",
  },
  "M&M": {
    instrumentKey: "NSE_EQ|INE101A01026",
    tradingSymbol: "M&M",
    name: "Mahindra & Mahindra",
  },
  ADANIENT: {
    instrumentKey: "NSE_EQ|INE423A01024",
    tradingSymbol: "ADANIENT",
    name: "Adani Enterprises",
  },
  ADANIPORTS: {
    instrumentKey: "NSE_EQ|INE742F01042",
    tradingSymbol: "ADANIPORTS",
    name: "Adani Ports",
  },
  ONGC: {
    instrumentKey: "NSE_EQ|INE213A01029",
    tradingSymbol: "ONGC",
    name: "ONGC",
  },
  COALINDIA: {
    instrumentKey: "NSE_EQ|INE522F01014",
    tradingSymbol: "COALINDIA",
    name: "Coal India",
  },
  JSWSTEEL: {
    instrumentKey: "NSE_EQ|INE019A01038",
    tradingSymbol: "JSWSTEEL",
    name: "JSW Steel",
  },
  HCLTECH: {
    instrumentKey: "NSE_EQ|INE860A01027",
    tradingSymbol: "HCLTECH",
    name: "HCL Technologies",
  },
  TECHM: {
    instrumentKey: "NSE_EQ|INE669C01036",
    tradingSymbol: "TECHM",
    name: "Tech Mahindra",
  },
  INDUSINDBK: {
    instrumentKey: "NSE_EQ|INE095A01012",
    tradingSymbol: "INDUSINDBK",
    name: "IndusInd Bank",
  },
  BAJAJFINSV: {
    instrumentKey: "NSE_EQ|INE918I01026",
    tradingSymbol: "BAJAJFINSV",
    name: "Bajaj Finserv",
  },
  CIPLA: {
    instrumentKey: "NSE_EQ|INE059A01026",
    tradingSymbol: "CIPLA",
    name: "Cipla",
  },
  DRREDDY: {
    instrumentKey: "NSE_EQ|INE089A01031",
    tradingSymbol: "DRREDDY",
    name: "Dr Reddy's",
  },
  APOLLOHOSP: {
    instrumentKey: "NSE_EQ|INE437A01024",
    tradingSymbol: "APOLLOHOSP",
    name: "Apollo Hospitals",
  },
  DIVISLAB: {
    instrumentKey: "NSE_EQ|INE361B01024",
    tradingSymbol: "DIVISLAB",
    name: "Divi's Laboratories",
  },
  EICHERMOT: {
    instrumentKey: "NSE_EQ|INE066A01021",
    tradingSymbol: "EICHERMOT",
    name: "Eicher Motors",
  },
  HEROMOTOCO: {
    instrumentKey: "NSE_EQ|INE158A01026",
    tradingSymbol: "HEROMOTOCO",
    name: "Hero MotoCorp",
  },
  BRITANNIA: {
    instrumentKey: "NSE_EQ|INE216A01030",
    tradingSymbol: "BRITANNIA",
    name: "Britannia",
  },
  BPCL: {
    instrumentKey: "NSE_EQ|INE029A01011",
    tradingSymbol: "BPCL",
    name: "Bharat Petroleum",
  },
  HDFCLIFE: {
    instrumentKey: "NSE_EQ|INE795G01014",
    tradingSymbol: "HDFCLIFE",
    name: "HDFC Life",
  },
  SBILIFE: {
    instrumentKey: "NSE_EQ|INE123W01016",
    tradingSymbol: "SBILIFE",
    name: "SBI Life",
  },
  TRENT: {
    instrumentKey: "NSE_EQ|INE849A01020",
    tradingSymbol: "TRENT",
    name: "Trent",
  },
  BEL: {
    instrumentKey: "NSE_EQ|INE263A01024",
    tradingSymbol: "BEL",
    name: "Bharat Electronics",
  },
  NIFTYBEES: {
    instrumentKey: "NSE_EQ|INF204KB14I2",
    tradingSymbol: "NIFTYBEES",
    name: "Nippon India ETF Nifty BeES",
  },
};

export function lookupStaticUpstoxKey(symbol: string) {
  const key = symbol
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "");
  return UPSTOX_NSE_EQ_KEYS[key] || null;
}
