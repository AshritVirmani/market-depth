// --- CONFIGURATION ---
export const SCRAPE_INTERVAL_MS = 500; // Faster for tape reading
export const DISCOVERY_MINS = 15; // First 15 mins for zone building
export const ZONE_TOLERANCE = 0.001; // 0.1% distance to consider "in zone"
export const VWAP_TOLERANCE = 0.001; // 0.1% distance from VWAP

// --- API CREDENTIALS ---
export const DHAN_CLIENT_ID = "1109130648";
export const DHAN_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzY0NjIwNzA0LCJpYXQiOjE3NjQ1MzQzMDQsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTA5MTMwNjQ4In0.-QNLYXhmgIbe6dc2ZywzRlHVN-W-pDIuj16PukF2Jc3-8nHX4mnUTJsYytaAm3pVD5SRBCVmS_7nBaRsqHgRUg";

// --- DOM SELECTORS ---
export const SELECTORS = {
    // Market Depth (Try multiple variations)
    buyRows: '.BuyOrdersDepth tbody tr, .market-depth-bid tr, [data-type="bid"] tr',
    sellRows: '.SellOrdersDepth tbody tr, .market-depth-ask tr, [data-type="ask"] tr',
    depthQty: '.depthText, .qty, .quantity, td:nth-child(2), span[class*="quantity"]', // Fallback to 2nd column

    // Trades
    tradesTable: 'table.trades-table, .recent-trades table, table',
    tradeRows: 'tbody tr',

    // Options Chain
    optionChainContainer: '.option-chain-container, [data-id="option-chain"], .option-chain',
    activeTab: '.active-tab, .selected, .active',
    stockPrice: '.stock-price, .ltp, .instrument-price, .indices-price, .header-ltp, .stockLtp',

    // Headers
    stockName: '.stockName, .instrument-name, .header-symbol, .symbol-name',
};

// Adaptive Thresholds
export const WALL_MULTIPLIER = 2.5;
export const SPOOF_MULTIPLIER = 10;
export const PANIC_VELOCITY = 10; // Trades/sec for panic detection
export const AGGRESSOR_THRESHOLD = 0.6; // 60% buy pressure = aggressive buyers

// Strategy Thresholds
export const GAP_THRESHOLD = 0.0005; // 0.05% price gap
export const ABSORPTION_ZONE_TOLERANCE = 0.001; // 0.1% tolerance
export const ZONE_DECAY_MS = 30 * 60 * 1000; // 30 minutes zone lifetime
export const OBI_PANIC_THRESHOLD = -30; // OBI below -30% = Panic
export const TAPE_FLIP_PRESSURE = 0.65; // 65% buy pressure for flip
export const SECTOR_PANIC_SCORE = -5; // Sector score below -5 = Panic
export const SECTOR_FLIP_SCORE = -2; // Sector score above -2 for flip
export const TAPE_COLOR_THRESHOLD = 0.7; // 70% pressure for solid color

// Sector Configuration (Nifty Bank 12)
export const SECTOR_PEERS = [
    'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK',
    'INDUSINDBK', 'BANKBARODA', 'PNB', 'IDFCFIRSTB', 'AUBANK', 'FEDERALBNK', 'BANDHANBNK'
];

export const NORMALIZED_MAPPING = {
    'HDFC Bank': 'HDFCBANK',
    'ICICI Bank': 'ICICIBANK',
    'State Bank of India': 'SBIN',
    'Kotak Mahindra Bank': 'KOTAKBANK',
    'Axis Bank': 'AXISBANK',
    'IndusInd Bank': 'INDUSINDBK',
    'Bank of Baroda': 'BANKBARODA',
    'Punjab National Bank': 'PNB',
    'IDFC First Bank': 'IDFCFIRSTB',
    'AU Small Finance Bank': 'AUBANK',
    'Federal Bank': 'FEDERALBNK',
    'Bandhan Bank': 'BANDHANBNK',
    'Nifty Bank': 'BANKNIFTY',
    'Nifty 50': 'NIFTY'
};

export const BANK_WEIGHTS = {
    'HDFCBANK': 0.30, 'ICICIBANK': 0.23, 'SBIN': 0.15, 'KOTAKBANK': 0.10, 'AXISBANK': 0.08,
    'INDUSINDBK': 0.03, 'BANKBARODA': 0.03, 'PNB': 0.02, 'IDFCFIRSTB': 0.02, 'AUBANK': 0.02, 'FEDERALBNK': 0.01, 'BANDHANBNK': 0.01
};

// Strike Intervals for Option Selection
export const STRIKE_STEPS = {
    'NIFTY': 50,
    'BANKNIFTY': 100,
    'FINNIFTY': 50,
    'HDFCBANK': 10, 'ICICIBANK': 10, 'SBIN': 5, 'KOTAKBANK': 20, 'AXISBANK': 10,
    'INDUSINDBK': 10, 'RELIANCE': 20, 'INFY': 10, 'TCS': 20
};

export const SECTOR_STALE_MS = 15000; // Data older than 15s is stale (increased for background tabs)

// Market Hours
export const MARKET_START_HOUR = 9;
export const MARKET_START_MINUTE = 15;
export const MARKET_END_HOUR = 15;
export const MARKET_END_MINUTE = 30;

export const OPTIONS_HEARTBEAT_MS = 60000; // Force record every 1 min even if no change
export const SIGNAL_COOLDOWN_MS = 300000; // 5 minutes (was 10s)
export const LOSS_COOLDOWN_MS = 900000; // 15 minutes
export const DAILY_LOSS_LIMIT = 5; // 5 points max loss per day

// Time Filters
export const NO_TRADE_WINDOW = {
    start: '11:30',
    end: '13:00'
};

// --- Strategy Settings ---
export const STRATEGY = {
    // Risk Management (Refined from HDFC Bank Backtest)
    STOP_LOSS_PCT: 0.7,      // Increased from 0.3% to give trades room to breathe
    TAKE_PROFIT_PCT: 1.0,    // Optimal take profit level
    TRAILING_STOP_PCT: 1.5,  // Trailing stop to lock in gains (1.5% from high)

    // Entry Filters
    VWAP_TOLERANCE: 0.001,   // Stricter 0.1% tolerance (was 0.2%) for better R:R
    MIN_CONFIDENCE: 60,      // Minimum confidence score to trigger signal
    COOLDOWN_CANDLES: 20,    // Snapshots to wait between trades

    // Trend Filters
    SMA_PERIOD: 50,          // Period for trend determination
    RSI_PERIOD: 14,          // RSI period
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30
};

// --- STATE MACHINE ---
export const STATES = {
    IDLE: 'IDLE',
    DISCOVERY: 'DISCOVERY',       // First 15 mins - building zones
    MONITORING: 'MONITORING',     // Watching for setups
    ZONE_ALERT: 'ZONE_ALERT',     // Price entered a zone
    ENTRY_SIGNAL: 'ENTRY_SIGNAL'  // Tape confirmed - trade signal
};

