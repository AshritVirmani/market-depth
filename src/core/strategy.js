import {
    SELECTORS, STATES, WALL_MULTIPLIER, SPOOF_MULTIPLIER, PANIC_VELOCITY,
    AGGRESSOR_THRESHOLD, DISCOVERY_MINS, ZONE_TOLERANCE, VWAP_TOLERANCE,
    OPTIONS_HEARTBEAT_MS, SCRAPE_INTERVAL_MS, SIGNAL_COOLDOWN_MS,
    GAP_THRESHOLD, ABSORPTION_ZONE_TOLERANCE, ZONE_DECAY_MS, OBI_PANIC_THRESHOLD,
    TAPE_FLIP_PRESSURE, SECTOR_PANIC_SCORE, SECTOR_FLIP_SCORE, TAPE_COLOR_THRESHOLD,
    DAILY_LOSS_LIMIT, STRATEGY, SECTOR_PEERS
} from '../config';
import {
    state, metrics, wallTracker, currentState, discoveryStartTime,
    updateCurrentState, setDiscoveryStartTime
} from './state';
import {
    cleanNumber, getPreciseTimestamp, getStockName, getATMStrike,
    showToast, updateStateBadge, getRealTimeTrades, isOptionsChain,
    processOptionsChain, updateOptionsUI, getReadableTime
} from '../utils/dom';
import { broadcastSectorStatus, getSectorSentiment } from '../utils/sector';
import { recordSnapshot, getRecordedDataLength } from '../utils/logger';
import { broadcastUpdate, listenToMarket, getMarketContext } from '../utils/sync';
import { executePaperTrade } from './paperTrader';
import { saveMemory, loadMemory } from './state';

let lastOptionsSnapshot = null;
let lastMarketSnapshot = null; // Track last recorded state for deduplication

// Helper function to check if current stock is a bank stock
function isBankStock(symbol) {
    if (!symbol) return false;
    const upperSymbol = symbol.toUpperCase();
    return SECTOR_PEERS.some(peer => upperSymbol.includes(peer) || peer.includes(upperSymbol));
}
let velocityHistory = [];
const VELOCITY_WINDOW = 10;
let lastOptionsData = null; // Store last options data to persist across tab switches

// Volume Analysis State
let volumeHistory = []; // Stores { timestamp, volume} for 1-min buckets
let currentMinuteVolume = 0;
let lastMinuteTimestamp = Math.floor(Date.now() / 60000);

// Option Chain Analysis State (15m Lookback)
let pcrHistory = [];
const PCR_LOOKBACK_MINS = 15;

export function resetStrategy() {
    lastOptionsSnapshot = null;
    velocityHistory = [];
    volumeHistory = [];
    currentMinuteVolume = 0;
    lastMinuteTimestamp = Math.floor(Date.now() / 60000);
    pcrHistory = [];
    priceHistory = [];
}

// Price History for RSI
let priceHistory = [];
// Predictive Momentum Tracking
let momentumHistory = []; // Stores { price, time, velocity, obi } for pattern detection
const MOMENTUM_WINDOW = 20; // Last 20 snapshots for momentum analysis

export function updatePriceStats(price) {
    const currentMinute = Math.floor(Date.now() / 60000);

    if (priceHistory.length === 0 || currentMinute> priceHistory[priceHistory.length - 1].timestamp) {
        priceHistory.push({ timestamp: currentMinute, close: price });
        if (priceHistory.length> 100) priceHistory.shift(); // Keep last 100 mins
    } else {
        // Update current minute close
        priceHistory[priceHistory.length - 1].close = price;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 🔮 PREDICTIVE MOMENTUM ANALYSIS
// ─────────────────────────────────────────────────────────────────────────
export function updateMomentumHistory(price, velocity, obi, tape) {
    momentumHistory.push({
        price,
        time: Date.now(),
        velocity,
        obi,
        buyPressure: tape.buyPressure,
        aggressorSide: tape.aggressorSide
    });
    
    if (momentumHistory.length > MOMENTUM_WINDOW) {
        momentumHistory.shift();
    }
}

// Predict continuation vs reversal
export function predictMomentum() {
    if (momentumHistory.length < 5) return { direction: 'NEUTRAL', confidence: 0 };
    
    const recent = momentumHistory.slice(-5);
    const older = momentumHistory.slice(-10, -5);
    
    // Calculate momentum acceleration
    const recentAvgVelocity = recent.reduce((sum, m) => sum + m.velocity, 0) / recent.length;
    const olderAvgVelocity = older.length > 0 ? older.reduce((sum, m) => sum + m.velocity, 0) / older.length : 0;
    
    const recentAvgOBI = recent.reduce((sum, m) => sum + m.obi, 0) / recent.length;
    const priceChange = recent[recent.length - 1].price - recent[0].price;
    const priceChangePct = (priceChange / recent[0].price) * 100;
    
    // Momentum acceleration
    const velocityAccel = recentAvgVelocity - olderAvgVelocity;
    
    // Predictive signals
    let direction = 'NEUTRAL';
    let confidence = 0;
    
    // BULLISH MOMENTUM: Accelerating velocity + Strong OBI + Price rising
    if (velocityAccel > 2 && recentAvgOBI > 15 && priceChangePct > 0.1) {
        direction = 'BULLISH';
        confidence = Math.min(100, (velocityAccel * 10) + (recentAvgOBI * 2) + (priceChangePct * 100));
    }
    // BEARISH MOMENTUM: Decelerating velocity + Weak OBI + Price falling
    else if (velocityAccel < -2 && recentAvgOBI < -15 && priceChangePct < -0.1) {
        direction = 'BEARISH';
        confidence = Math.min(100, Math.abs(velocityAccel * 10) + Math.abs(recentAvgOBI * 2) + Math.abs(priceChangePct * 100));
    }
    // REVERSAL SIGNAL: Strong momentum but price not following (divergence)
    else if (Math.abs(velocityAccel) > 5 && Math.abs(priceChangePct) < 0.05) {
        direction = velocityAccel > 0 ? 'BEARISH_REVERSAL' : 'BULLISH_REVERSAL';
        confidence = Math.min(80, Math.abs(velocityAccel * 8));
    }
    
    return { direction, confidence: Math.round(confidence) };
}

export function calculateRSI(period = 14) {
    if (priceHistory.length < period + 1) return 50; // Not enough data

    let gains = 0;
    let losses = 0;

    // Calculate initial average
    for (let i = 1; i <= period; i++) {
        const change = priceHistory[i].close - priceHistory[i - 1].close;
        if (change> 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smooth subsequent values
    for (let i = period + 1; i < priceHistory.length; i++) {
        const change = priceHistory[i].close - priceHistory[i - 1].close;
        const gain = change> 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

export function updatePCRStats(pcr) {
    const now = Date.now();
    pcrHistory.push({ timestamp: now, value: pcr });

    // Remove old data (> 15 mins)
    const cutoff = now - (PCR_LOOKBACK_MINS * 60 * 1000);
    pcrHistory = pcrHistory.filter(p => p.timestamp> cutoff);
}

export function getPCRTrend() {
    if (pcrHistory.length < 2) return 0;

    const currentPCR = pcrHistory[pcrHistory.length - 1].value;
    const oldPCR = pcrHistory[0].value; // Oldest in the 15m window

    if (oldPCR === 0) return 0;
    return (currentPCR - oldPCR) / oldPCR; // Percentage change
}

export function updateVolumeStats(volume) {
    const currentMinute = Math.floor(Date.now() / 60000);

    if (currentMinute> lastMinuteTimestamp) {
        // Finalize previous minute
        volumeHistory.push({ timestamp: lastMinuteTimestamp, volume: currentMinuteVolume });
        if (volumeHistory.length> 20) volumeHistory.shift(); // Keep last 20 mins

        currentMinuteVolume = 0;
        lastMinuteTimestamp = currentMinute;
    }

    currentMinuteVolume += volume;
}

export function getRVOL() {
    if (volumeHistory.length < 5) return 1.0; // Not enough data yet

    const avgVol = volumeHistory.reduce((sum, v) => sum + v.volume, 0) / volumeHistory.length;
    if (avgVol === 0) return 1.0;

    // Project current minute volume based on seconds elapsed
    const secondsElapsed = (Date.now() % 60000) / 1000;
    const projectedVol = secondsElapsed> 10
        ? (currentMinuteVolume / secondsElapsed) * 60
        : currentMinuteVolume; // Don't project if < 10s elapsed

    return projectedVol / avgVol;
}

export function updateVWAP(price, volume) {
    if (!price || !volume || volume === 0) return;

    const typicalPrice = price;
    state.vwapData.cumTypicalVol += typicalPrice * volume;
    state.vwapData.cumVol += volume;

    if (state.vwapData.cumVol> 0) {
        state.vwap = state.vwapData.cumTypicalVol / state.vwapData.cumVol;
    }

    const vwapEl = document.getElementById('vwapValue');
    if (vwapEl && state.vwap> 0) {
        vwapEl.innerText = state.vwap.toFixed(2);
    }
}

export function identifyZones(bids, asks, trades, bestBid, bestAsk) {
    const avgQty = metrics.rowCount> 0 ? metrics.totalRowQty / metrics.rowCount : 0;
    const strongThreshold = avgQty * 3;

    bids.forEach(bid => {
        if (bid.qty> strongThreshold) {
            const existingZone = state.zones.demand.find(z => Math.abs(z.price - bid.price) < bid.price * GAP_THRESHOLD);

            if (existingZone) {
                existingZone.strength = Math.max(existingZone.strength, bid.qty);
                existingZone.lastSeen = Date.now();
            } else {
                state.zones.demand.push({
                    price: bid.price,
                    type: 'WALL_SUPPORT',
                    strength: bid.qty,
                    timestamp: Date.now(),
                    lastSeen: Date.now()
                });
            }
        }
    });

    asks.forEach(ask => {
        if (ask.qty> strongThreshold) {
            const existingZone = state.zones.supply.find(z => Math.abs(z.price - ask.price) < ask.price * GAP_THRESHOLD);

            if (existingZone) {
                existingZone.strength = Math.max(existingZone.strength, ask.qty);
                existingZone.lastSeen = Date.now();
            } else {
                state.zones.supply.push({
                    price: ask.price,
                    type: 'WALL_RESISTANCE',
                    strength: ask.qty,
                    timestamp: Date.now(),
                    lastSeen: Date.now()
                });
            }
        }
    });

    if (trades.length> 0 && metrics.tradeVelocity> PANIC_VELOCITY) {
        const lowestTrade = Math.min(...trades.map(t => t.price));
        if (lowestTrade < bestBid) {
            const existingZone = state.zones.demand.find(z => Math.abs(z.price - lowestTrade) < lowestTrade * ABSORPTION_ZONE_TOLERANCE);

            if (!existingZone) {
                state.zones.demand.push({
                    price: lowestTrade,
                    type: 'ABSORPTION_WICK',
                    strength: trades.reduce((acc, t) => acc + t.quantity, 0),
                    timestamp: Date.now(),
                    lastSeen: Date.now()
                });
            }
        }
    }

    const decayThreshold = Date.now() - ZONE_DECAY_MS;
    state.zones.demand = state.zones.demand.filter(z => z.lastSeen> decayThreshold);
    state.zones.supply = state.zones.supply.filter(z => z.lastSeen> decayThreshold);

    state.zones.demand.sort((a, b) => b.strength - a.strength);
    state.zones.supply.sort((a, b) => b.strength - a.strength);
    state.zones.demand = state.zones.demand.slice(0, 5);
    state.zones.supply = state.zones.supply.slice(0, 5);

    const zoneCountEl = document.getElementById('zoneCount');
    if (zoneCountEl) {
        zoneCountEl.innerHTML = `<span style="color:#00c853">D:${state.zones.demand.length}</span> <span style="color:#ff4444">S:${state.zones.supply.length}</span>`;
    }
}

export function isInDemandZone(price) {
    return state.zones.demand.some(z => Math.abs(price - z.price) < price * ZONE_TOLERANCE);
}

export function isInSupplyZone(price) {
    return state.zones.supply.some(z => Math.abs(price - z.price) < price * ZONE_TOLERANCE);
}

export function isNearVWAP(price) {
    if (state.vwap === 0) return false;
    return Math.abs(price - state.vwap) < price * VWAP_TOLERANCE;
}

export function analyzeTape(trades, bestBid, bestAsk, hasNewTrades = true, newCount = 0) {
    if (trades.length === 0) {
        return {
            velocity: 'LOW',
            velocityNum: 0,
            buyPressure: 0.5,
            sellPressure: 0.5,
            isHighVelocity: false,
            aggressorSide: 'NEUTRAL',
            tapeColor: 'MIXED',
            newTradesDetected: false
        };
    }

    const now = Date.now();
    const elapsed = (now - metrics.lastTradeTime) / 1000;

    let instantVelocity = 0;
    if (hasNewTrades && elapsed> 0) {
        instantVelocity = newCount / elapsed;

        velocityHistory.push(instantVelocity);
        if (velocityHistory.length> VELOCITY_WINDOW) {
            velocityHistory.shift();
        }
    }

    const smoothedVelocity = velocityHistory.length> 0
        ? velocityHistory.reduce((a, b) => a + b, 0) / velocityHistory.length
        : 0;

    metrics.tradeVelocity = smoothedVelocity;
    metrics.lastTradeCount = trades.length;
    metrics.lastTradeTime = now;

    let redVolume = 0, greenVolume = 0;

    trades.forEach(trade => {
        if (trade.price <= bestBid) {
            redVolume += trade.quantity;
        } else if (trade.price>= bestAsk) {
            greenVolume += trade.quantity;
        } else {
            const midpoint = (bestBid + bestAsk) / 2;
            if (trade.price < midpoint) {
                redVolume += trade.quantity;
            } else {
                greenVolume += trade.quantity;
            }
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🐟 RETAIL vs WHALE ANALYSIS
    // ─────────────────────────────────────────────────────────────────────────
    let retailBuyVol = 0, retailSellVol = 0;
    let whaleBuyVol = 0, whaleSellVol = 0;

    trades.forEach(trade => {
        const isRetail = trade.quantity < 50; // Small Lot
        const isWhale = trade.quantity> 1000; // Big Lot

        if (trade.price>= bestAsk) { // Buy
            if (isRetail) retailBuyVol += trade.quantity;
            if (isWhale) whaleBuyVol += trade.quantity;
        } else if (trade.price <= bestBid) { // Sell
            if (isRetail) retailSellVol += trade.quantity;
            if (isWhale) whaleSellVol += trade.quantity;
        }
    });

    const totalRetail = retailBuyVol + retailSellVol;
    const retailSentiment = totalRetail> 0 ? (retailBuyVol / totalRetail) : 0.5; //> 0.5 = Bullish Retail

    const totalVolume = redVolume + greenVolume;
    const buyPressure = totalVolume> 0 ? greenVolume / totalVolume : 0.5;
    const sellPressure = totalVolume> 0 ? redVolume / totalVolume : 0.5;

    let velocity = 'LOW';
    if (smoothedVelocity> PANIC_VELOCITY * 2) velocity = 'EXTREME';
    else if (smoothedVelocity> PANIC_VELOCITY) velocity = 'HIGH';
    else if (smoothedVelocity> PANIC_VELOCITY / 2) velocity = 'NORMAL';

    let aggressorSide = 'NEUTRAL';
    if (buyPressure> AGGRESSOR_THRESHOLD) aggressorSide = 'BUYERS';
    else if (sellPressure> AGGRESSOR_THRESHOLD) aggressorSide = 'SELLERS';

    let tapeColor = 'MIXED';
    if (buyPressure> TAPE_COLOR_THRESHOLD) tapeColor = 'GREEN';
    else if (sellPressure> TAPE_COLOR_THRESHOLD) tapeColor = 'RED';

    return {
        velocity,
        velocityNum: smoothedVelocity,
        buyPressure,
        sellPressure,
        isHighVelocity: velocity === 'HIGH' || velocity === 'EXTREME',
        aggressorSide,
        tapeColor,
        greenVolume,
        redVolume,
        newTradesDetected: hasNewTrades,
        tradeCount: trades.length,
        retailSentiment, // 0.0 - 1.0 (High = Retail Bullish)
        whaleBuyVol,
        whaleSellVol
    };
}

export function isBookGappy(bids, asks) {
    if (bids.length < 2 || asks.length < 2) return false;

    for (let i = 0; i < bids.length - 1; i++) {
        const gap = bids[i].price - bids[i + 1].price;
        const avgGap = bids[0].price * GAP_THRESHOLD;
        if (gap> avgGap * 3) return true;
    }

    for (let i = 0; i < asks.length - 1; i++) {
        const gap = asks[i + 1].price - asks[i].price;
        const avgGap = asks[0].price * GAP_THRESHOLD;
        if (gap> avgGap * 3) return true;
    }

    return false;
}

// Helper to check if signal should be logged (Deduplication)
function shouldLogSignal(type, price) {
    const now = Date.now();
    const key = `${type}_${price}`;

    // Ensure lastSignalTime is initialized
    if (!state.lastSignalTime) state.lastSignalTime = {};

    const lastTime = state.lastSignalTime[key] || 0;

    if (now - lastTime> SIGNAL_COOLDOWN_MS) {
        state.lastSignalTime[key] = now;
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────
// 🧠 THE GENERAL (Market Context Analysis)
// ─────────────────────────────────────────────────────────────────────────
function analyzeMarketContext(sector, pcrTrend, tape) {
    let score = 0;

    // 1. Sector Alignment (The Tide)
    if (sector.netScore> 2) score += 2;
    else if (sector.netScore < -2) score -= 2;

    // 2. PCR Trend (The Smart Money)
    if (pcrTrend> 0.05) score += 1;
    else if (pcrTrend < -0.05) score -= 1;

    // 3. Tape Aggression (The Crowd)
    if (tape.aggressorSide === 'BUYERS') score += 1;
    else if (tape.aggressorSide === 'SELLERS') score -= 1;

    // Determine Bias
    if (score>= 3) return 'BULLISH';
    if (score <= -3) return 'BEARISH';
    return 'NEUTRAL';
}

// ─────────────────────────────────────────────────────────────────────────
// ⚙️ THE GEARBOX (Regime Detection)
// ─────────────────────────────────────────────────────────────────────────
function detectMarketRegime(market, tape, rvol, symbol) {
    // 1. WHALE REGIME (Institutional Dominance)
    // High Options OI + Clear PCR Trend
    if (market && market.options && market.options[symbol]) {
        const opt = market.options[symbol];
        const totalOI = opt.callOI + opt.putOI;
        if (totalOI> 5000000 && Math.abs(opt.pcrTrend)> 0.02) {
            return 'WHALE';
        }
    }

    // 2. RETAIL REGIME (Crowd Dominance)
    // Extreme Retail Sentiment + Low Institutional Activity
    if (Math.abs(tape.retailSentiment - 0.5)> 0.3) { // < 0.2 or> 0.8
        return 'RETAIL';
    }

    // 3. SCALP REGIME (Volatility Dominance)
    // High RVOL + High Velocity
    if (rvol> 2.0 || tape.isHighVelocity) {
        return 'SCALP';
    }

    return 'NEUTRAL';
}

// ─────────────────────────────────────────────────────────────────────────
// 📊 CONFIDENCE SCORING SYSTEM
// ─────────────────────────────────────────────────────────────────────────
function calculateConfidenceScores(context) {
    const { pcrTrend = 0, tape = {}, rsi = 50 } = context;

    // 1. WHALE SCORE (PCR Trend Strength)
    // 0.05 trend = 100% confidence
    const whaleScore = Math.min(100, Math.abs(pcrTrend || 0) * 2000);

    // 2. BEAST SCORE (Momentum Strength)
    // High Velocity = 80%, Aggressor Side = +20%, Base = 20%
    let beastScore = (tape.isHighVelocity) ? 80 : 20;
    if (tape.aggressorSide && tape.aggressorSide !== 'NEUTRAL') beastScore += 20;

    // 3. TRAP SCORE (Reversion Probability)
    // RSI 70/30 = 40%, RSI 80/20 = 60%, RSI 90/10 = 80%
    const distFrom50 = Math.abs((rsi || 50) - 50);
    const trapScore = Math.min(100, Math.max(0, (distFrom50 - 20) * 3.33)); // Starts at RSI 70/30, min 0

    // 4. RETAIL SCORE (Sentiment Extremity)
    // 0.5 = 0%, 0.8/0.2 = 60%, 1.0/0.0 = 100%
    const retailSentiment = tape.retailSentiment || 0.5;
    const retailScore = Math.min(100, Math.abs(retailSentiment - 0.5) * 200);

    return {
        WHALE: Math.max(0, whaleScore),
        BEAST: Math.max(0, beastScore),
        TRAP: Math.max(0, trapScore),
        RETAIL: Math.max(0, retailScore)
    };
}

function updateStrategyUI(scores, bias, regime, context) {
    // Update Bias
    const biasEl = document.getElementById('marketBias');
    if (biasEl) {
        biasEl.innerText = `${bias} (${regime})`;
        const biasColor = bias === 'BULLISH' ? '#00c853' : bias === 'BEARISH' ? '#ff4444' : '#888';
        biasEl.style.color = biasColor;
    }

    // 🔧 FIX: Get market context directly from sync (not from context parameter)
    const market = getMarketContext();
    
    // Update Global Context (VIX, Sector, Peers)
    const vixEl = document.getElementById('vixDisplay');
    const secEl = document.getElementById('sectorDisplay');
    const bnEl = document.getElementById('bankNiftyDisplay');

    // 🔧 FIX: Use market state directly for VIX
    if (vixEl) {
        const vixValue = market.vixValue || 0;
        const vixRegime = market.vixRegime || 'NORMAL';
        vixEl.innerText = `VIX: ${vixValue > 0 ? vixValue.toFixed(1) : '--'}`;
        vixEl.style.color = vixRegime === 'HIGH' ? '#ff4444' : vixRegime === 'LOW' ? '#00c853' : '#888';
    }
    
    // 🔧 FIX: Use market state directly for Bank Nifty
    if (bnEl) {
        const bnTrend = market.sectorTrend || 'FLAT';
        const bnLTP = market.sectorLTP || 0;
        if (bnTrend !== 'FLAT' && bnLTP > 0) {
            bnEl.innerText = `BN: ${bnTrend}`;
            bnEl.style.color = bnTrend === 'BULLISH' ? '#00c853' : '#ff4444';
        } else {
            bnEl.innerText = `BN: --`;
            bnEl.style.color = '#888';
        }
    }
    
    // Sector score from context or market
    if (secEl) {
        const currentSymbol = state.symbol || "";
        if (isBankStock(currentSymbol)) {
            const sectorScore = context?.sector?.netScore || market?.sector?.netScore || 0;
            secEl.innerText = `SEC: ${sectorScore.toFixed(1)}`;
            secEl.style.color = sectorScore > 0 ? '#00c853' : sectorScore < 0 ? '#ff4444' : '#888';
        } else {
            secEl.innerText = `SEC: --`;
            secEl.style.color = '#888';
        }
    }
    
    // 🔧 FIX: Update all four regime cards (WHALE, BEAST, TRAP, RETAIL)
    if (scores) {
        updateStratCard('strat-whale', scores.WHALE || 0);
        updateStratCard('strat-beast', scores.BEAST || 0);
        updateStratCard('strat-trap', scores.TRAP || 0);
        updateStratCard('strat-retail', scores.RETAIL || 0);
    }
}

function updateStratCard(id, score) {
    const el = document.getElementById(id);
    if (!el) return;

    const scoreEl = el.querySelector('.strat-score');
    const fillEl = el.querySelector('.progress-fill');

    if (scoreEl) scoreEl.innerText = `${score.toFixed(0)}%`;
    if (fillEl) {
        fillEl.style.width = `${score}%`;
        // Color coding based on intensity
        if (score> 80) fillEl.style.background = '#00ff88'; // High Confidence
        else if (score> 50) fillEl.style.background = '#00d4ff'; // Medium
        else fillEl.style.background = '#444'; // Low
    }

    // Dim disabled strategies
    const stratName = id.replace('strat-', '').toUpperCase();
    const isActive = state.strategyPerformance[stratName]?.status === 'ACTIVE';
    el.style.opacity = isActive ? '1' : '0.4';
}

// --- NEW SIGNAL EVALUATION FUNCTION (TRIAD STRATEGY + CONTEXT) ---
function evaluateSignals(context) {
    const {
        sector, tape, bestBid, bestAsk, inDemandZone, inSupplyZone,
        nearVWAP, bookGappy, isPanic, pcrTrend, market,
        bids: contextBids, asks: contextAsks,
        momentumPrediction = { direction: 'NEUTRAL', confidence: 0 }, // Default if not provided
        obi: contextObi // OBI calculated from totalBidQty/totalAskQty (all rows)
    } = context;

    const bids = contextBids || [];
    const asks = contextAsks || [];

    const currentSymbol = state.symbol || "";

    // 🧠 ASK THE GENERAL: What is the Plan?
    const marketBias = analyzeMarketContext(sector, pcrTrend, tape);

    // ⚙️ SHIFT GEARS: What is the Regime?
    const rvol = getRVOL();
    const marketRegime = detectMarketRegime(market, tape, rvol, currentSymbol);

    // 📊 CALCULATE CONFIDENCE SCORES
    const rsi = calculateRSI(14); // Need RSI for scoring
    const scores = calculateConfidenceScores({ ...context, rsi });

    // 🖥️ UPDATE UI
    updateStrategyUI(scores, marketBias, marketRegime, context);

    // 📡 BROADCAST TO CENTRAL BRAIN (Multi-Tab Orchestration)
    // We send the highest score among all strategies
    const maxScore = Math.max(scores.WHALE, scores.BEAST, scores.TRAP, scores.RETAIL);
    
    // 🔧 FIX: Initialize signals arrays FIRST before any code uses them
    const signals = [];
    const loggedSignals = [];
    
    // 🔧 FIX: Boost score will be calculated AFTER signals are generated
    // For now, just use maxScore (will be updated at end of function)
    let hasActiveSignals = false;
    let boostedScore = maxScore;

    // ─────────────────────────────────────────────────────────────────────────
    // 🌍 GLOBAL FILTERS (The "God Mode" Checks)
    // ─────────────────────────────────────────────────────────────────────────
    // Default to safe values if market context is missing
    const vixRegime = market ? market.vixRegime : 'NORMAL';
    const sectorTrend = market ? market.sectorTrend : 'FLAT';

    const isVixHigh = vixRegime === 'HIGH'; //> 16

    // If VIX is High, we show a warning
    if (isVixHigh) {
        // We don't block trades, but we warn the user
        // signals.push(`<div style='color:#ffaa00; font-size:10px'>⚠️ HIGH VIX (${market.vixValue}) - REDUCE SIZE</div>`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STOCK PERSONALITY DETECTION
    // ─────────────────────────────────────────────────────────────────────────
    const isHDFC = currentSymbol.includes('HDFC');
    const isSBIN = currentSymbol.includes('SBIN');
    const isICICI = currentSymbol.includes('ICICI');

    // ─────────────────────────────────────────────────────────────────────────
    // 🧱 COMPLETE OPTION CHAIN ANALYSIS (Enhanced Decision Making)
    // ─────────────────────────────────────────────────────────────────────────
    if (market && market.options && market.options[currentSymbol]) {
        const opt = market.options[currentSymbol];
        
        // ─────────────────────────────────────────────────────────────────────
        // 1. MAX PAIN TARGET (Where price wants to go)
        // ─────────────────────────────────────────────────────────────────────
        if (opt.maxPainStrike && opt.maxPainStrike > 0) {
            const distToMaxPain = Math.abs(bestBid - opt.maxPainStrike);
            const maxPainPct = (distToMaxPain / bestBid) * 100;
            
            if (maxPainPct < 1.0) { // Within 1% of Max Pain
                if (shouldLogSignal('MAX_PAIN_ALERT', opt.maxPainStrike)) {
                    signals.push(`<div style='color:#ffaa00; font-weight:bold'>🎯 MAX PAIN: ${opt.maxPainStrike}</div>`);
                    signals.push(`<div style='color:#ffdd99; font-size:10px'>Price likely to gravitate here (${maxPainPct.toFixed(2)}% away)</div>`);
                    loggedSignals.push({ type: 'MAX_PAIN_ALERT', strike: opt.maxPainStrike, distance: maxPainPct, time: getReadableTime() });
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // 2. OI WALLS (Support/Resistance from High OI Strikes)
        // ─────────────────────────────────────────────────────────────────────
        // Check Call Walls (Resistance above current price)
        if (opt.callWalls && opt.callWalls.length > 0) {
            opt.callWalls.forEach(wall => {
                const distToWall = ((wall.strike - bestBid) / bestBid) * 100;
                if (distToWall < 2.0 && distToWall > 0) { // Within 2% above
                    if (shouldLogSignal(`CALL_WALL_${wall.strike}`, wall.strike)) {
                        signals.push(`<div style='color:#ff4444; font-weight:bold'>🧱 CALL WALL: ${wall.strike}</div>`);
                        signals.push(`<div style='color:#ffcccc; font-size:10px'>OI: ${(wall.oi / 100000).toFixed(1)}L | ${distToWall.toFixed(2)}% above</div>`);
                        loggedSignals.push({ type: 'CALL_WALL', strike: wall.strike, oi: wall.oi, distance: distToWall, time: getReadableTime() });
                        showToast(`🧱 CALL WALL @ ${wall.strike}`, '#ff4444', '');
                    }
                }
            });
        }

        // Check Put Walls (Support below current price)
        if (opt.putWalls && opt.putWalls.length > 0) {
            opt.putWalls.forEach(wall => {
                const distToWall = ((bestBid - wall.strike) / bestBid) * 100;
                if (distToWall < 2.0 && distToWall > 0) { // Within 2% below
                    if (shouldLogSignal(`PUT_WALL_${wall.strike}`, wall.strike)) {
                        signals.push(`<div style='color:#00ff88; font-weight:bold'>🧱 PUT WALL: ${wall.strike}</div>`);
                        signals.push(`<div style='color:#ccffdd; font-size:10px'>OI: ${(wall.oi / 100000).toFixed(1)}L | ${distToWall.toFixed(2)}% below</div>`);
                        loggedSignals.push({ type: 'PUT_WALL', strike: wall.strike, oi: wall.oi, distance: distToWall, time: getReadableTime() });
                        showToast(`🧱 PUT WALL @ ${wall.strike}`, '#00ff88', '');
                    }
                }
            });
        }

        // ─────────────────────────────────────────────────────────────────────
        // 3. EXTREME PCR STRIKES (Reversal Zones)
        // ─────────────────────────────────────────────────────────────────────
        // High PCR Strikes (Put Heavy = Potential Support)
        if (opt.highPCRStrikes && opt.highPCRStrikes.length > 0) {
            opt.highPCRStrikes.forEach(pcrData => {
                const distToStrike = Math.abs(bestBid - pcrData.strike);
                const distPct = (distToStrike / bestBid) * 100;
                if (distPct < 1.5 && pcrData.strike < bestBid) { // Below current price
                    if (shouldLogSignal(`HIGH_PCR_${pcrData.strike}`, pcrData.strike)) {
                        signals.push(`<div style='color:#00c853; font-weight:600'>📊 PUT HEAVY: ${pcrData.strike}</div>`);
                        signals.push(`<div style='color:#ccffcc; font-size:10px'>PCR: ${pcrData.pcr.toFixed(2)} | OI: ${(pcrData.putOI / 100000).toFixed(1)}L</div>`);
                        loggedSignals.push({ type: 'HIGH_PCR_SUPPORT', strike: pcrData.strike, pcr: pcrData.pcr, time: getReadableTime() });
                    }
                }
            });
        }

        // Low PCR Strikes (Call Heavy = Potential Resistance)
        if (opt.lowPCRStrikes && opt.lowPCRStrikes.length > 0) {
            opt.lowPCRStrikes.forEach(pcrData => {
                const distToStrike = Math.abs(bestBid - pcrData.strike);
                const distPct = (distToStrike / bestBid) * 100;
                if (distPct < 1.5 && pcrData.strike > bestBid) { // Above current price
                    if (shouldLogSignal(`LOW_PCR_${pcrData.strike}`, pcrData.strike)) {
                        signals.push(`<div style='color:#ff4444; font-weight:600'>📊 CALL HEAVY: ${pcrData.strike}</div>`);
                        signals.push(`<div style='color:#ffcccc; font-size:10px'>PCR: ${pcrData.pcr.toFixed(2)} | OI: ${(pcrData.callOI / 100000).toFixed(1)}L</div>`);
                        loggedSignals.push({ type: 'LOW_PCR_RESISTANCE', strike: pcrData.strike, pcr: pcrData.pcr, time: getReadableTime() });
                    }
                }
            });
        }

        // ─────────────────────────────────────────────────────────────────────
        // 4. VOLUME ANALYSIS (Momentum Indicator)
        // ─────────────────────────────────────────────────────────────────────
        if (opt.totalCallVolume > 0 && opt.totalPutVolume > 0) {
            const volumePCR = opt.totalPutVolume / opt.totalCallVolume;
            const volumeBias = volumePCR > 1.5 ? 'PUTS' : volumePCR < 0.67 ? 'CALLS' : 'NEUTRAL';
            
            if (volumeBias !== 'NEUTRAL' && Math.abs(volumePCR - 1.0) > 0.3) {
                if (shouldLogSignal('VOLUME_BIAS', 0)) {
                    const biasColor = volumeBias === 'PUTS' ? '#00c853' : '#ff4444';
                    signals.push(`<div style='color:${biasColor}; font-weight:600'>📈 VOLUME BIAS: ${volumeBias}</div>`);
                    signals.push(`<div style='color:#ccc; font-size:10px'>Vol PCR: ${volumePCR.toFixed(2)} | Call: ${(opt.totalCallVolume / 1000).toFixed(0)}K | Put: ${(opt.totalPutVolume / 1000).toFixed(0)}K</div>`);
                    loggedSignals.push({ type: 'VOLUME_BIAS', bias: volumeBias, volPCR: volumePCR, time: getReadableTime() });
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 💥 WALL BREAK STRATEGY (BREAKOUTS)
    // ─────────────────────────────────────────────────────────────────────────
    // Dynamic Threshold: 10x Average Row Size (or min 500)
    const BREAKOUT_THRESHOLD = Math.max(metrics.avgRowQty * 10, 500);

    // Check for Resistance Break (Bullish)
    const recentResistance = state.zones.supply.find(z =>
        bestBid> z.price && // Price is ABOVE the wall
        z.strength> BREAKOUT_THRESHOLD && // It was a BIG wall
        (Date.now() - z.lastSeen < 60000) // Seen in last 1 minute
    );

    if (recentResistance) {
        if (shouldLogSignal('BREAKOUT_BUY', recentResistance.price)) {
            signals.push(`<div style='color:#00ff00; font-weight:900; font-size:14px'>🚀 WALL BREAKOUT</div>`);
            signals.push(`<div style='color:#ccffcc; font-size:11px'>Broken ${recentResistance.strength} @ ${recentResistance.price}</div>`);
            loggedSignals.push({ type: 'BREAKOUT_BUY', price: recentResistance.price, strength: recentResistance.strength, time: getReadableTime() });
            showToast(`🚀 BREAKOUT: ${recentResistance.price}`, '#00ff00', '');

            // Mark as 'broken' to avoid spamming? 
            // shouldLogSignal handles cooldown, so it's fine.
        }
    }

    // Check for Support Break (Bearish)
    const recentSupport = state.zones.demand.find(z =>
        bestAsk < z.price && // Price is BELOW the wall
        z.strength> BREAKOUT_THRESHOLD && // It was a BIG wall
        (Date.now() - z.lastSeen < 60000) // Seen in last 1 minute
    );

    if (recentSupport) {
        if (shouldLogSignal('BREAKDOWN_SELL', recentSupport.price)) {
            signals.push(`<div style='color:#ff0000; font-weight:900; font-size:14px'>📉 WALL BREAKDOWN</div>`);
            signals.push(`<div style='color:#ffcccc; font-size:11px'>Broken ${recentSupport.strength} @ ${recentSupport.price}</div>`);
            loggedSignals.push({ type: 'BREAKDOWN_SELL', price: recentSupport.price, strength: recentSupport.strength, time: getReadableTime() });
            showToast(`📉 BREAKDOWN: ${recentSupport.price}`, '#ff0000', '');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🧠 UNIVERSAL INSTITUTIONAL LOGIC (The Sniper)
    // ─────────────────────────────────────────────────────────────────────────
    // Applies to ALL Stocks (HDFC, SBIN, ICICI, KOTAK, etc.)

    // 🔧 FIX: Use OBI passed from processMarketData() instead of recalculating
    // This ensures consistency between display and signal evaluation
    // OBI is already calculated from totalBidQty and totalAskQty (all parsed rows)
    const obi = context.obi !== undefined ? context.obi : (() => {
        // Fallback: Calculate from bids/asks arrays if OBI not provided
        const totalBid = bids.reduce((a, b) => a + b.qty, 0);
        const totalAsk = asks.reduce((a, b) => a + b.qty, 0);
        return totalBid + totalAsk > 0 ? ((totalBid - totalAsk) / (totalBid + totalAsk)) * 100 : 0;
    })();

    // ─────────────────────────────────────────────────────────────────────────
    // 🎯 SMART ORDER EXECUTION CALCULATOR (Profitability After All Costs)
    // ─────────────────────────────────────────────────────────────────────────
    function calculateSmartEntry(bestBid, bestAsk, obi, spread) {
        const BROKERAGE_PCT = 0.06; // 0.06% round trip (0.03% entry + 0.03% exit)
        const SLIPPAGE_PCT = 0.05; // 0.05% slippage (conservative)
        const MIN_PROFIT_AFTER_COSTS = 0.4; // 🔧 BALANCED: 0.4% for quality signals (was 0.15%, 0.5% too strict)
        
        // Calculate realistic entry price (with slippage)
        let entryPrice = bestBid;
        let entryType = 'LIMIT';
        let fillProbability = 0.5; // Default 50% fill probability
        
        // Determine entry strategy based on OBI and spread
        if (obi > 20) {
            // High demand: Front-run to ensure fill
            entryPrice = bestBid + (spread * 0.3); // Pay 30% of spread
            entryType = 'AGGRESSIVE';
            fillProbability = 0.95; // High fill probability
        } else if (obi > 10) {
            // Moderate demand: Pay small premium
            entryPrice = bestBid + (spread * 0.15); // Pay 15% of spread
            entryType = 'MODERATE';
            fillProbability = 0.75;
        } else {
            // Low demand: Join bid (limit order)
            entryPrice = bestBid;
            entryType = 'LIMIT';
            fillProbability = 0.4; // Lower fill probability
        }
        
        // 🔧 FIX: For LONG trades, exit price should be ABOVE entry (target price)
        // Use TAKE_PROFIT_PCT from config to calculate realistic target
        const targetPrice = entryPrice * (1 + STRATEGY.TAKE_PROFIT_PCT / 100);
        // Exit at target price, but account for slippage (we might get slightly less)
        const exitPrice = targetPrice * (1 - SLIPPAGE_PCT / 100);
        
        // Calculate total costs
        const entryCost = entryPrice * (BROKERAGE_PCT / 2 / 100); // Entry brokerage
        const exitCost = exitPrice * (BROKERAGE_PCT / 2 / 100); // Exit brokerage
        const totalCosts = entryCost + exitCost;
        
        // Calculate net profit percentage
        const grossProfit = exitPrice - entryPrice;
        const netProfit = grossProfit - totalCosts;
        const netProfitPct = (netProfit / entryPrice) * 100;
        
        // 🔧 FIX: Use STOP_LOSS_PCT from config (0.7% instead of hardcoded 0.5%)
        const stopLossPrice = entryPrice * (1 - STRATEGY.STOP_LOSS_PCT / 100);
        // Exit at stop loss with slippage (we might get slightly less)
        const stopLossExitPrice = stopLossPrice * (1 - SLIPPAGE_PCT / 100);
        const stopLossCost = stopLossExitPrice * (BROKERAGE_PCT / 2 / 100);
        const stopLossNet = (stopLossExitPrice - entryPrice) - entryCost - stopLossCost;
        const stopLossPct = (stopLossNet / entryPrice) * 100;
        
        // Only signal if:
        // 1. Net profit after costs > minimum threshold
        // 2. Fill probability is acceptable (> 40%)
        // 3. Risk:Reward is favorable (at least 1:2)
        const riskReward = Math.abs(netProfitPct / stopLossPct);
        const isProfitable = netProfitPct > MIN_PROFIT_AFTER_COSTS;
        const hasGoodRR = riskReward >= 1.5; // 🔧 FIX: Realistic 1.5:1 R:R (was 2.0)
        const willFill = fillProbability > 0.4;
        
        return {
            entryPrice: parseFloat(entryPrice.toFixed(2)),
            entryType,
            exitPrice: parseFloat(exitPrice.toFixed(2)),
            stopLossPrice: parseFloat(stopLossPrice.toFixed(2)),
            netProfitPct: parseFloat(netProfitPct.toFixed(2)),
            stopLossPct: parseFloat(stopLossPct.toFixed(2)),
            riskReward: parseFloat(riskReward.toFixed(2)),
            fillProbability: parseFloat((fillProbability * 100).toFixed(0)),
            totalCosts: parseFloat(totalCosts.toFixed(2)),
            isProfitable,
            hasGoodRR,
            willFill,
            shouldSignal: isProfitable && hasGoodRR && willFill
        };
    }
    
    const spread = bestAsk - bestBid;
    const smartOrder = calculateSmartEntry(bestBid, bestAsk, obi, spread);
    
    // 🔧 SHORT TRADE CALCULATOR (For Sell Signals)
    function calculateSmartEntryShort(bestBid, bestAsk, obi, spread) {
        const BROKERAGE_PCT = 0.06; // 0.06% round trip
        const SLIPPAGE_PCT = 0.05; // 0.05% slippage
        const MIN_PROFIT_AFTER_COSTS = 0.4; // 🔧 BALANCED: 0.4% for quality signals (was 0.15%, 0.5% too strict)
        
        // Calculate realistic entry price for SHORT (sell at ask)
        let entryPrice = bestAsk;
        let entryType = 'LIMIT';
        let fillProbability = 0.5;
        
        // Determine entry strategy based on OBI (negative OBI = supply pressure)
        if (obi < -20) {
            // High supply: Front-run to ensure fill
            entryPrice = bestAsk - (spread * 0.3); // Pay 30% of spread
            entryType = 'AGGRESSIVE';
            fillProbability = 0.95;
        } else if (obi < -10) {
            // Moderate supply: Pay small premium
            entryPrice = bestAsk - (spread * 0.15); // Pay 15% of spread
            entryType = 'MODERATE';
            fillProbability = 0.75;
        } else {
            // Low supply: Join ask (limit order)
            entryPrice = bestAsk;
            entryType = 'LIMIT';
            fillProbability = 0.4;
        }
        
        // 🔧 For SHORT trades, exit price should be BELOW entry (target price)
        const targetPrice = entryPrice * (1 - STRATEGY.TAKE_PROFIT_PCT / 100);
        // Exit at target price, but account for slippage (we might get slightly more)
        const exitPrice = targetPrice * (1 + SLIPPAGE_PCT / 100);
        
        // Calculate total costs
        const entryCost = entryPrice * (BROKERAGE_PCT / 2 / 100);
        const exitCost = exitPrice * (BROKERAGE_PCT / 2 / 100);
        const totalCosts = entryCost + exitCost;
        
        // Calculate net profit percentage (for SHORT: entry - exit)
        const grossProfit = entryPrice - exitPrice;
        const netProfit = grossProfit - totalCosts;
        const netProfitPct = (netProfit / entryPrice) * 100;
        
        // 🔧 Stop loss for SHORT: price goes UP (above entry)
        const stopLossPrice = entryPrice * (1 + STRATEGY.STOP_LOSS_PCT / 100);
        // Exit at stop loss with slippage (we might get slightly more)
        const stopLossExitPrice = stopLossPrice * (1 + SLIPPAGE_PCT / 100);
        const stopLossCost = stopLossExitPrice * (BROKERAGE_PCT / 2 / 100);
        const stopLossNet = (entryPrice - stopLossExitPrice) - entryCost - stopLossCost;
        const stopLossPct = (stopLossNet / entryPrice) * 100;
        
        // Only signal if profitable and has good risk:reward
        const riskReward = Math.abs(netProfitPct / stopLossPct);
        const isProfitable = netProfitPct > MIN_PROFIT_AFTER_COSTS;
        const hasGoodRR = riskReward >= 1.5; // 🔧 FIX: Realistic 1.5:1 R:R (was 2.0)
        const willFill = fillProbability > 0.4;
        
        return {
            entryPrice: parseFloat(entryPrice.toFixed(2)),
            entryType,
            exitPrice: parseFloat(exitPrice.toFixed(2)),
            stopLossPrice: parseFloat(stopLossPrice.toFixed(2)),
            netProfitPct: parseFloat(netProfitPct.toFixed(2)),
            stopLossPct: parseFloat(stopLossPct.toFixed(2)),
            riskReward: parseFloat(riskReward.toFixed(2)),
            fillProbability: parseFloat((fillProbability * 100).toFixed(0)),
            totalCosts: parseFloat(totalCosts.toFixed(2)),
            isProfitable,
            hasGoodRR,
            willFill,
            shouldSignal: isProfitable && hasGoodRR && willFill
        };
    }
    
    const smartOrderShort = calculateSmartEntryShort(bestBid, bestAsk, obi, spread);
    
    // Use smart order prices for LONG trades
    let entryPrice = smartOrder.entryPrice;
    let entryType = smartOrder.entryType;
    const scalpTarget = smartOrder.exitPrice; // Realistic exit price
    const scalpStop = smartOrder.stopLossPrice;

    // ─────────────────────────────────────────────────────────────────────────
    // 1. WHALE SETUP (PCR + SECTOR)
    // If we have Options Data, we look for the "Hedge" (Whale Footprint)
    // REGIME FILTER: Only active in WHALE or NEUTRAL regime
    if ((marketRegime === 'WHALE' || marketRegime === 'NEUTRAL') && Math.abs(pcrTrend)> 0.05 && state.strategyPerformance['WHALE'].status === 'ACTIVE') {
        const isBullishWhale = pcrTrend> 0.05;
        const isBearishWhale = pcrTrend < -0.05;

        // SECTOR SYNC: Never fight the tide
        if (isBullishWhale && sectorTrend !== 'BEARISH') {
            // 🎯 SMART ORDER CHECK: Only signal if profitable after all costs
            if (smartOrder.shouldSignal && shouldLogSignal('WHALE_BUY', bestBid)) {
                const atm = getATMStrike(bestBid, currentSymbol);
                const momentumHint = momentumPrediction.direction === 'BULLISH' ? `🔮 ${momentumPrediction.confidence}% Momentum` : '';
                
                signals.push(`<div style='color:#00ff88; font-weight:800'>🐳 WHALE BUY ${momentumHint}</div>`);
                signals.push(`<div style='color:#ccffdd; font-size:11px'>PCR Rising (${(pcrTrend * 100).toFixed(1)}%) | Sector Aligned</div>`);
                signals.push(`<div style='color:#ccffdd; font-size:11px'>Entry: ${entryPrice.toFixed(2)} (${entryType}) | Fill: ${smartOrder.fillProbability}%</div>`);
                signals.push(`<div style='color:#ccffdd; font-size:10px'>Net Profit: ${smartOrder.netProfitPct.toFixed(2)}% | R:R ${smartOrder.riskReward.toFixed(1)}</div>`);
                signals.push(`<div style='color:#ccffdd; font-size:10px'>Target: ${scalpTarget.toFixed(2)} | Stop: ${scalpStop.toFixed(2)}</div>`);
                loggedSignals.push({ 
                    type: 'WHALE_BUY', 
                    pcr: pcrTrend, 
                    rec: `${atm} CE`, 
                    price: entryPrice, 
                    netProfit: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProb: smartOrder.fillProbability,
                    momentum: momentumPrediction,
                    time: getReadableTime() 
                });
                updateStateBadge(STATES.ENTRY_SIGNAL);
                showToast(`🐳 WHALE BUY: ${currentSymbol} @ ${entryPrice} | Net: ${smartOrder.netProfitPct.toFixed(2)}%`, '#00ff88', '');
            } else if (!smartOrder.shouldSignal && shouldLogSignal('WHALE_BUY_REJECTED', bestBid)) {
                // Log why signal was rejected (for debugging)
                const reasons = [];
                if (!smartOrder.isProfitable) reasons.push(`Net profit ${smartOrder.netProfitPct.toFixed(2)}% < 0.15%`);
                if (!smartOrder.hasGoodRR) reasons.push(`R:R ${smartOrder.riskReward.toFixed(1)} < 2.0`);
                if (!smartOrder.willFill) reasons.push(`Fill prob ${smartOrder.fillProbability}% < 40%`);
                // Don't show rejected signals to user, just log for analysis
            }
        }
        else if (isBearishWhale && (sectorTrend !== 'BULLISH' || sector.netScore < 15)) {
            // 🔧 FIX: Sector advisory, not hard block - allow if sector < 15
            // 🎯 SMART ORDER CHECK: Only signal if profitable after all costs
            if (smartOrderShort.shouldSignal && shouldLogSignal('WHALE_SELL', bestAsk)) {
                const atm = getATMStrike(bestAsk, currentSymbol);
                const momentumHint = momentumPrediction.direction === 'BEARISH' ? `🔮 ${momentumPrediction.confidence}% Momentum` : '';
                signals.push(`<div style='color:#ff4444; font-weight:800'>🐻 WHALE SELL ${momentumHint}</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>PCR Dumping (${(pcrTrend * 100).toFixed(1)}%) | Sector Aligned</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>Entry: ${smartOrderShort.entryPrice.toFixed(2)} (${smartOrderShort.entryType}) | Fill: ${smartOrderShort.fillProbability}%</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:10px'>Net Profit: ${smartOrderShort.netProfitPct.toFixed(2)}% | R:R ${smartOrderShort.riskReward.toFixed(1)}</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:10px'>Target: ${smartOrderShort.exitPrice.toFixed(2)} | Stop: ${smartOrderShort.stopLossPrice.toFixed(2)}</div>`);
                loggedSignals.push({ 
                    type: 'WHALE_SELL', 
                    pcr: pcrTrend, 
                    rec: `${atm} PE`, 
                    price: smartOrderShort.entryPrice,
                    netProfit: smartOrderShort.netProfitPct,
                    riskReward: smartOrderShort.riskReward,
                    fillProb: smartOrderShort.fillProbability,
                    momentum: momentumPrediction,
                    time: getReadableTime() 
                });
                updateStateBadge(STATES.ENTRY_SIGNAL);
                showToast(`🐻 WHALE SELL: ${currentSymbol} @ ${smartOrderShort.entryPrice} | Net: ${smartOrderShort.netProfitPct.toFixed(2)}%`, '#ff4444', '');
            }
        }
    }

    // 2. BEAST SETUP (TAPE + ZONES)
    // If Tape is screaming (Panic/Greed), we look for the "Breakout"
    // REGIME FILTER: Active in SCALP, NEUTRAL, or WHALE (if aligned)
    const isScalpRegime = marketRegime === 'SCALP' || marketRegime === 'NEUTRAL';

    // 🔧 FIX: Allow NORMAL velocity too (not just HIGH) - Most markets are NORMAL velocity
    const hasVelocity = tape.isHighVelocity || tape.velocity === 'NORMAL' || tape.velocityNum > 0.3;
    
    if (isScalpRegime && hasVelocity && !isPanic && state.strategyPerformance['BEAST'].status === 'ACTIVE') {
        // FILTER: Price must be aligned with VWAP (Trend Following) OR momentum is strong
        const isTrendAligned = bestBid> state.vwap;
        const isMomentumBullish = momentumPrediction.direction === 'BULLISH' && momentumPrediction.confidence > 50;
        const isEarlySignal = momentumPrediction.direction === 'BULLISH_REVERSAL' && momentumPrediction.confidence > 60;
        const hasStrongMomentum = isMomentumBullish || isEarlySignal;
        
        // 🔧 FIX: Allow trend alignment OR strong momentum
        const trendOK = isTrendAligned || hasStrongMomentum;

        // BUY SETUP: Demand Zone Hold + Aggressive Buyers + Sector Support
        // 🔧 FIX: Lower OBI threshold from 10% to -20% (allow slightly negative OBI)
        // 🔧 FIX: Make zone optional if momentum is strong OR OBI is very positive
        // 🔧 FIX: Make sector filter advisory (allow if sector > -15)
        const obiOK = obi > -20; // Was: obi > 10
        // Zone is optional if: strong momentum OR very positive OBI (>15%) OR near VWAP
        const zoneOK = inDemandZone || hasStrongMomentum || obi > 15 || nearVWAP;
        const sectorOK = sectorTrend !== 'BEARISH' || sector.netScore > -15; // Sector advisory, not hard block
        
        if (zoneOK && tape.aggressorSide === 'BUYERS' && sectorOK && trendOK && obiOK) {
            // 🎯 SMART ORDER CHECK: Only signal if profitable after all costs
            if (smartOrder.shouldSignal && shouldLogSignal('BEAST_BUY', bestBid)) {
                const momentumLabel = isEarlySignal ? '🔮 EARLY' : isMomentumBullish ? '🔮 CONFIRMED' : '';
                signals.push(`<div style='color:#00c853; font-weight:800'>🐂 BEAST BUY ${momentumLabel}</div>`);
                signals.push(`<div style='color:#ccffcc; font-size:11px'>Zone Hold + Aggressive Buyers</div>`);
                signals.push(`<div style='color:#ccffcc; font-size:11px'>Entry: ${entryPrice.toFixed(2)} (${entryType}) | Fill: ${smartOrder.fillProbability}%</div>`);
                signals.push(`<div style='color:#ccffcc; font-size:10px'>Net Profit: ${smartOrder.netProfitPct.toFixed(2)}% | R:R ${smartOrder.riskReward.toFixed(1)}</div>`);
                signals.push(`<div style='color:#ccffcc; font-size:10px'>Target: ${scalpTarget.toFixed(2)} | Stop: ${scalpStop.toFixed(2)}</div>`);
                loggedSignals.push({ 
                    type: 'BEAST_BUY', 
                    price: entryPrice, 
                    netProfit: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProb: smartOrder.fillProbability,
                    momentum: momentumPrediction,
                    time: getReadableTime() 
                });
                updateStateBadge(STATES.ENTRY_SIGNAL);
                showToast(`🐂 BEAST BUY: ${currentSymbol} @ ${entryPrice} | Net: ${smartOrder.netProfitPct.toFixed(2)}%`, '#00c853', '');
            }
        }
    }

    // 🐻 BEAST SHORT (TAPE + ZONES)
    // 🔧 FIX: Allow NORMAL velocity too (not just HIGH) - Most markets are NORMAL velocity
    const hasVelocityShort = tape.isHighVelocity || tape.velocity === 'NORMAL' || tape.velocityNum > 0.3;
    
    if (isScalpRegime && hasVelocityShort && !isPanic && state.strategyPerformance['BEAST'].status === 'ACTIVE') {
        // FILTER: Price must be BELOW VWAP (Trend Following) OR momentum is bearish OR OBI is very negative
        const isTrendBearish = bestAsk < state.vwap;
        const isMomentumBearish = momentumPrediction.direction === 'BEARISH' && momentumPrediction.confidence > 50;
        const isEarlySignal = momentumPrediction.direction === 'BEARISH_REVERSAL' && momentumPrediction.confidence > 60;
        const hasStrongMomentum = isMomentumBearish || isEarlySignal;
        // 🔧 FIX: Allow trend alignment OR strong momentum OR very negative OBI
        const trendOK = isTrendBearish || hasStrongMomentum || obi < -15 || nearVWAP;

        // SELL SETUP: Supply Zone Hold + Aggressive Sellers + Sector Resistance
        // 🔧 FIX: Relaxed filters - Make zone optional if momentum is strong OR OBI is very negative
        const obiOK = obi < 20; // Was: obi < -10 (relaxed to allow more signals)
        const zoneOK = inSupplyZone || hasStrongMomentum || obi < -15 || nearVWAP;
        // 🔧 FIX: Sector advisory, not hard block - allow if sector > -15 (was < 15)
        const sectorOK = sectorTrend !== 'BULLISH' || sector.netScore < 15;
        
        // 🔧 FIX: Allow MODERATE_SELLING as fallback (not just SELLERS)
        const aggressorOK = tape.aggressorSide === 'SELLERS' || (tape.sellPressure > 0.55 && obi < -10);
        
        if (zoneOK && aggressorOK && sectorOK && trendOK && obiOK) {
            // 🎯 SMART ORDER CHECK: Only signal if profitable after all costs
            if (smartOrderShort.shouldSignal && shouldLogSignal('BEAST_SELL', bestAsk)) {
                const momentumLabel = isEarlySignal ? '🔮 EARLY' : isMomentumBearish ? '🔮 CONFIRMED' : '';
                signals.push(`<div style='color:#ff4444; font-weight:800'>🐻 BEAST SELL ${momentumLabel}</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>Zone Hold + Aggressive Sellers</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>Entry: ${smartOrderShort.entryPrice.toFixed(2)} (${smartOrderShort.entryType}) | Fill: ${smartOrderShort.fillProbability}%</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:10px'>Net Profit: ${smartOrderShort.netProfitPct.toFixed(2)}% | R:R ${smartOrderShort.riskReward.toFixed(1)}</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:10px'>Target: ${smartOrderShort.exitPrice.toFixed(2)} | Stop: ${smartOrderShort.stopLossPrice.toFixed(2)}</div>`);
                loggedSignals.push({ 
                    type: 'BEAST_SELL', 
                    price: smartOrderShort.entryPrice,
                    netProfit: smartOrderShort.netProfitPct,
                    riskReward: smartOrderShort.riskReward,
                    fillProb: smartOrderShort.fillProbability,
                    momentum: momentumPrediction,
                    time: getReadableTime() 
                });
                updateStateBadge(STATES.ENTRY_SIGNAL);
                showToast(`🐻 BEAST SELL: ${currentSymbol} @ ${smartOrderShort.entryPrice} | Net: ${smartOrderShort.netProfitPct.toFixed(2)}%`, '#ff4444', '');
            }
        }
    }

    // 3. SECTOR PANIC (The Flush)
    // If the whole sector is crashing, we warn the user (or signal shorts)
    // 🔧 FIX: Add smart order check for profitable short signals during sector panic
    if (sector.panicCount>= 2 || sector.netScore < SECTOR_PANIC_SCORE) {
        const hasVelocity = tape.isHighVelocity || tape.velocity === 'NORMAL' || tape.velocityNum > 0.3;
        const hasSelling = tape.aggressorSide === 'SELLERS' || tape.sellPressure > 0.55;
        if (hasVelocity && hasSelling) {
            // 🎯 SMART ORDER CHECK: Only signal if profitable
            if (smartOrderShort.shouldSignal && shouldLogSignal('SECTOR_PANIC_SELL', bestAsk)) {
                signals.push(`<div style='color:#ff4444; font-weight:800'>⛔ SECTOR PANIC SELL</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>Sector Crashing (${sector.netScore.toFixed(1)}) | Aggressive Sellers</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:11px'>Entry: ${smartOrderShort.entryPrice.toFixed(2)} (${smartOrderShort.entryType}) | Fill: ${smartOrderShort.fillProbability}%</div>`);
                signals.push(`<div style='color:#ffcccc; font-size:10px'>Net Profit: ${smartOrderShort.netProfitPct.toFixed(2)}% | R:R ${smartOrderShort.riskReward.toFixed(1)}</div>`);
                loggedSignals.push({ 
                    type: 'SECTOR_PANIC_SELL', 
                    score: sector.netScore, 
                    price: smartOrderShort.entryPrice,
                    netProfit: smartOrderShort.netProfitPct,
                    riskReward: smartOrderShort.riskReward,
                    time: getReadableTime() 
                });
                updateStateBadge(STATES.ENTRY_SIGNAL);
                showToast(`⛔ SECTOR PANIC SELL: ${currentSymbol} @ ${smartOrderShort.entryPrice} | Net: ${smartOrderShort.netProfitPct.toFixed(2)}%`, '#ff4444', '');
            } else if (shouldLogSignal('SECTOR_PANIC', 0)) {
                // Warning only (not profitable enough)
                signals.push(`<div style='color:#ff4444; font-weight:600'>⛔ SECTOR PANIC (Warning)</div>`);
                loggedSignals.push({ type: 'SECTOR_PANIC', score: sector.netScore, time: getReadableTime() });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🪤 TRAP DETECTION (The Squeeze)
    // ─────────────────────────────────────────────────────────────────────────
    // Target: Mean Reversion Bots that short RSI> 70


    // 1. TRAP BUY (Squeeze Shorts)
    if (state.strategyPerformance['TRAP'].status === 'ACTIVE') {
        if (rsi> 70 && !isPanic) {
            // Condition: Overbought BUT Holding Support (Zone)
            if (inDemandZone && bestBid> state.vwap) {
                if (shouldLogSignal('TRAP_BUY', bestBid)) {
                    signals.push(`<div style='color:#00e5ff; font-weight:800'>🪤 TRAP BUY (SQUEEZE)</div>`);
                    signals.push(`<div style='color:#ccf9ff; font-size:11px'>RSI ${rsi.toFixed(1)} + Zone Hold</div>`);
                    signals.push(`<div style='color:#ccf9ff; font-size:10px'>Squeezing Shorts...</div>`);

                    loggedSignals.push({ type: 'TRAP_BUY', price: bestBid, rsi: rsi, time: getReadableTime() });
                    updateStateBadge(STATES.ENTRY_SIGNAL);
                    showToast(`🪤 TRAP BUY: Squeeze @ ${bestBid}`, '#00e5ff', '');
                }
            }
        }

        // 2. TRAP SHORT (Crush Longs)
        // Target: Mean Reversion Bots that buy RSI < 30
        // 🔧 FIX: Relax RSI threshold and zone requirement for more signals
        if (rsi < 35 && !isPanic) {
            // Condition: Oversold BUT Holding Resistance (Zone) OR strong bearish momentum OR negative OBI
            const hasBearishMomentum = momentumPrediction.direction === 'BEARISH' && momentumPrediction.confidence > 50;
            // 🔧 FIX: Allow if zone OR momentum OR negative OBI OR near VWAP
            const zoneOrMomentumOK = inSupplyZone || hasBearishMomentum || obi < -15 || nearVWAP;
            if (zoneOrMomentumOK && (bestAsk < state.vwap || hasBearishMomentum || obi < -15)) {
                // 🎯 SMART ORDER CHECK: Only signal if profitable
                if (smartOrderShort.shouldSignal && shouldLogSignal('TRAP_SELL', bestAsk)) {
                    signals.push(`<div style='color:#ff00ff; font-weight:800'>🪤 TRAP SELL (SQUEEZE)</div>`);
                    signals.push(`<div style='color:#ffccff; font-size:11px'>RSI ${rsi.toFixed(1)} + Zone Hold</div>`);
                    signals.push(`<div style='color:#ffccff; font-size:11px'>Entry: ${smartOrderShort.entryPrice.toFixed(2)} (${smartOrderShort.entryType}) | Fill: ${smartOrderShort.fillProbability}%</div>`);
                    signals.push(`<div style='color:#ffccff; font-size:10px'>Net Profit: ${smartOrderShort.netProfitPct.toFixed(2)}% | R:R ${smartOrderShort.riskReward.toFixed(1)}</div>`);
                    signals.push(`<div style='color:#ffccff; font-size:10px'>Crushing Longs...</div>`);
                    loggedSignals.push({ 
                        type: 'TRAP_SELL', 
                        price: smartOrderShort.entryPrice, 
                        rsi: rsi,
                        netProfit: smartOrderShort.netProfitPct,
                        riskReward: smartOrderShort.riskReward,
                        time: getReadableTime() 
                    });
                    updateStateBadge(STATES.ENTRY_SIGNAL);
                    showToast(`🪤 TRAP SELL: Squeeze @ ${smartOrderShort.entryPrice}`, '#ff00ff', '');
                }
            }
        }
    }



    // ─────────────────────────────────────────────────────────────────────────
    // 🤡 CONTRA-RETAIL STRATEGY (Fade The Crowd)
    // ─────────────────────────────────────────────────────────────────────────
    // REGIME FILTER: Priority in RETAIL regime
    const isRetailRegime = marketRegime === 'RETAIL' || marketRegime === 'NEUTRAL';

    // 1. RETAIL EUPHORIA (Short Setup)
    // Retail is Buying (> 70%) BUT Smart Money is Selling (OBI < -20%)
    // 🔧 FIX: Relax OBI threshold and retail sentiment threshold for more signals
    if (isRetailRegime && tape.retailSentiment> 0.65 && obi < -10 && state.strategyPerformance['WHALE'].status === 'ACTIVE') {
        // 🎯 SMART ORDER CHECK: Only signal if profitable
        if (smartOrderShort.shouldSignal && shouldLogSignal('RETAIL_EUPHORIA', bestAsk)) {
            signals.push(`<div style='color:#ff4444; font-weight:800'>🤡 RETAIL EUPHORIA</div>`);
            signals.push(`<div style='color:#ffcccc; font-size:11px'>Retail Buying into Supply</div>`);
            signals.push(`<div style='color:#ffcccc; font-size:11px'>Entry: ${smartOrderShort.entryPrice.toFixed(2)} (${smartOrderShort.entryType}) | Fill: ${smartOrderShort.fillProbability}%</div>`);
            signals.push(`<div style='color:#ffcccc; font-size:10px'>Net Profit: ${smartOrderShort.netProfitPct.toFixed(2)}% | R:R ${smartOrderShort.riskReward.toFixed(1)}</div>`);
            signals.push(`<div style='color:#ffcccc; font-size:10px'>Smart Money Selling (OBI ${obi.toFixed(0)}%)</div>`);
            loggedSignals.push({ 
                type: 'RETAIL_EUPHORIA', 
                price: smartOrderShort.entryPrice, 
                sentiment: tape.retailSentiment,
                netProfit: smartOrderShort.netProfitPct,
                riskReward: smartOrderShort.riskReward,
                time: getReadableTime() 
            });
            updateStateBadge(STATES.ENTRY_SIGNAL);
            showToast(`🤡 RETAIL TRAP: Shorting Euphoria @ ${smartOrderShort.entryPrice} | Net: ${smartOrderShort.netProfitPct.toFixed(2)}%`, '#ff4444', '');
        }
    }

    // 2. RETAIL PANIC (Buy Setup)
    // Retail is Selling (> 70%) BUT Smart Money is Buying (OBI> 20%)
    if (isRetailRegime && tape.retailSentiment < 0.3 && obi> 20 && state.strategyPerformance['WHALE'].status === 'ACTIVE') {
        // 🎯 SMART ORDER CHECK: Only signal if profitable (for LONG trades)
        if (smartOrder.shouldSignal && shouldLogSignal('RETAIL_PANIC', bestBid)) {
            signals.push(`<div style='color:#00ff88; font-weight:800'>🤡 RETAIL PANIC</div>`);
            signals.push(`<div style='color:#ccffdd; font-size:11px'>Retail Dumping into Demand</div>`);
            signals.push(`<div style='color:#ccffdd; font-size:11px'>Entry: ${smartOrder.entryPrice.toFixed(2)} (${smartOrder.entryType}) | Fill: ${smartOrder.fillProbability}%</div>`);
            signals.push(`<div style='color:#ccffdd; font-size:10px'>Net Profit: ${smartOrder.netProfitPct.toFixed(2)}% | R:R ${smartOrder.riskReward.toFixed(1)}</div>`);
            signals.push(`<div style='color:#ccffdd; font-size:10px'>Smart Money Buying (OBI ${obi.toFixed(0)}%)</div>`);

            loggedSignals.push({ 
                type: 'RETAIL_PANIC', 
                price: smartOrder.entryPrice, 
                sentiment: tape.retailSentiment,
                netProfit: smartOrder.netProfitPct,
                riskReward: smartOrder.riskReward,
                fillProb: smartOrder.fillProbability,
                obi: obi,
                time: getReadableTime() 
            });
            updateStateBadge(STATES.ENTRY_SIGNAL);
            showToast(`🤡 RETAIL FLUSH: Buying Panic @ ${smartOrder.entryPrice} | Net: ${smartOrder.netProfitPct.toFixed(2)}%`, '#00ff88', '');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 🔧 POWERFUL FALLBACK SIGNALS (Strict Quality Filters)
    // ─────────────────────────────────────────────────────────────────────────
    // Only fire HIGH-QUALITY signals with multiple confirmations
    
    // Calculate quality score (0-100) for signal filtering
    function calculateSignalQuality(signalType, obi, tape, price, vwap, momentum, rsi) {
        let quality = 0;
        
        // OBI Strength (40 points max)
        if (signalType === 'LONG') {
            if (obi > 30) quality += 40;
            else if (obi > 20) quality += 30;
            else if (obi > 15) quality += 20;
            else if (obi > 10) quality += 10;
        } else if (signalType === 'SHORT') {
            if (obi < -30) quality += 40;
            else if (obi < -20) quality += 30;
            else if (obi < -15) quality += 20;
            else if (obi < -10) quality += 10;
        }
        
        // Tape Confirmation (20 points max)
        if (signalType === 'LONG' && tape.buyPressure > 0.7) quality += 20;
        else if (signalType === 'LONG' && tape.buyPressure > 0.6) quality += 15;
        else if (signalType === 'SHORT' && tape.sellPressure > 0.7) quality += 20;
        else if (signalType === 'SHORT' && tape.sellPressure > 0.6) quality += 15;
        
        // Price Trend Confirmation (20 points max)
        const priceVsVwap = ((price - vwap) / vwap) * 100;
        if (signalType === 'LONG' && priceVsVwap < -0.5) quality += 20; // Below VWAP = good entry
        else if (signalType === 'LONG' && priceVsVwap < -0.3) quality += 15;
        else if (signalType === 'SHORT' && priceVsVwap > 0.5) quality += 20; // Above VWAP = good entry
        else if (signalType === 'SHORT' && priceVsVwap > 0.3) quality += 15;
        
        // Momentum Confirmation (20 points max)
        if (signalType === 'LONG' && momentum.direction === 'BULLISH' && momentum.confidence > 60) quality += 20;
        else if (signalType === 'LONG' && momentum.direction === 'BULLISH' && momentum.confidence > 50) quality += 15;
        else if (signalType === 'SHORT' && momentum.direction === 'BEARISH' && momentum.confidence > 60) quality += 20;
        else if (signalType === 'SHORT' && momentum.direction === 'BEARISH' && momentum.confidence > 50) quality += 15;
        
        // RSI Confirmation (bonus points)
        if (signalType === 'LONG' && rsi < 50 && rsi > 30) quality += 10; // Not overbought
        else if (signalType === 'SHORT' && rsi > 50 && rsi < 70) quality += 10; // Not oversold
        
        return Math.min(100, quality);
    }
    
    // Only check fallback if no primary signals fired
    if (signals.length === 0 && loggedSignals.length === 0) {
        const rsi = calculateRSI(14);
        const currentPrice = bestBid;
        
        // FALLBACK 1: STRONG OBI + Multiple Confirmations (LONG)
        // 🔧 BALANCED: OBI > 20% (stricter than 10%, but not too extreme like 25%)
        // Also allow if OBI > 15% with very high quality (>80)
        const obiThreshold = obi > 20 || (obi > 15 && tape.buyPressure > 0.7);
        if (obiThreshold && tape.buyPressure > 0.6 && !isPanic) {
            const quality = calculateSignalQuality('LONG', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
            
            // Only trade if quality score > 65 (balanced - was 70, too strict)
            if (quality > 65) {
                const fallbackSmartOrder = calculateSmartEntry(bestBid, bestAsk, 'LONG');
                // Additional profitability check: require net profit > 0.4% and R:R > 1.3 (balanced)
                if (fallbackSmartOrder.shouldSignal && fallbackSmartOrder.netProfitPct > 0.4 && fallbackSmartOrder.riskReward > 1.3 && shouldLogSignal('FALLBACK_LONG', bestBid)) {
                    signals.push(`<div style='color:#88ff88; font-weight:700'>📈 PREMIUM LONG (Quality: ${quality}%)</div>`);
                    signals.push(`<div style='color:#ccffcc; font-size:10px'>OBI: ${obi.toFixed(1)}% | Buy: ${(tape.buyPressure * 100).toFixed(0)}% | RSI: ${rsi.toFixed(1)}</div>`);
                    signals.push(`<div style='color:#ccffcc; font-size:10px'>Entry: ${fallbackSmartOrder.entryPrice.toFixed(2)} | Net: ${fallbackSmartOrder.netProfitPct.toFixed(2)}% | R:R ${fallbackSmartOrder.riskReward.toFixed(1)}</div>`);
                    loggedSignals.push({ 
                        type: 'BUY', 
                        price: fallbackSmartOrder.entryPrice,
                        netProfit: fallbackSmartOrder.netProfitPct,
                        riskReward: fallbackSmartOrder.riskReward,
                        fillProb: fallbackSmartOrder.fillProbability,
                        quality: quality,
                        obi: obi,
                        rsi: rsi,
                        time: getReadableTime() 
                    });
                }
            }
        }
        
        // FALLBACK 2: STRONG Negative OBI + Multiple Confirmations (SHORT)
        // 🔧 BALANCED: OBI < -20% (stricter than -10%, but not too extreme like -25%)
        // Also allow if OBI < -15% with very high quality (>80)
        const obiThresholdShort = obi < -20 || (obi < -15 && tape.sellPressure > 0.7);
        if (obiThresholdShort && tape.sellPressure > 0.6 && !isPanic) {
            const quality = calculateSignalQuality('SHORT', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
            
            // Only trade if quality score > 65 (balanced - was 70, too strict)
            if (quality > 65) {
                const fallbackSmartOrder = calculateSmartEntryShort(bestBid, bestAsk, 'SHORT');
                // Additional profitability check: require net profit > 0.4% and R:R > 1.3 (balanced)
                if (fallbackSmartOrder.shouldSignal && fallbackSmartOrder.netProfitPct > 0.4 && fallbackSmartOrder.riskReward > 1.3 && shouldLogSignal('FALLBACK_SHORT', bestAsk)) {
                    signals.push(`<div style='color:#ff8888; font-weight:700'>📉 PREMIUM SHORT (Quality: ${quality}%)</div>`);
                    signals.push(`<div style='color:#ffcccc; font-size:10px'>OBI: ${obi.toFixed(1)}% | Sell: ${(tape.sellPressure * 100).toFixed(0)}% | RSI: ${rsi.toFixed(1)}</div>`);
                    signals.push(`<div style='color:#ffcccc; font-size:10px'>Entry: ${fallbackSmartOrder.entryPrice.toFixed(2)} | Net: ${fallbackSmartOrder.netProfitPct.toFixed(2)}% | R:R ${fallbackSmartOrder.riskReward.toFixed(1)}</div>`);
                    loggedSignals.push({ 
                        type: 'SHORT', 
                        price: fallbackSmartOrder.entryPrice,
                        netProfit: fallbackSmartOrder.netProfitPct,
                        riskReward: fallbackSmartOrder.riskReward,
                        fillProb: fallbackSmartOrder.fillProbability,
                        quality: quality,
                        obi: obi,
                        rsi: rsi,
                        time: getReadableTime() 
                    });
                }
            }
        }
        
        // FALLBACK 3: VWAP Reversion with STRONG Confirmation
        // 🔧 BALANCED: Require moderate deviation (>0.3%) and good OBI
        if (nearVWAP || Math.abs((currentPrice - state.vwap) / state.vwap) < 0.01) {
            const vwapDist = ((bestBid - state.vwap) / state.vwap) * 100;
            
            // LONG: Price below VWAP + Good buying
            if (vwapDist < -0.3 && obi > 15 && tape.buyPressure > 0.6) {
                const quality = calculateSignalQuality('LONG', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
                if (quality > 70) {
                    const vwapSmartOrder = calculateSmartEntry(bestBid, bestAsk, 'LONG');
                    if (vwapSmartOrder.shouldSignal && vwapSmartOrder.netProfitPct > 0.4 && vwapSmartOrder.riskReward > 1.3 && shouldLogSignal('VWAP_REVERSION_LONG', bestBid)) {
                        signals.push(`<div style='color:#88ff88; font-weight:700'>📈 VWAP REVERSION LONG (Quality: ${quality}%)</div>`);
                        signals.push(`<div style='color:#ccffcc; font-size:10px'>Price ${Math.abs(vwapDist).toFixed(2)}% below VWAP | OBI: ${obi.toFixed(1)}%</div>`);
                        loggedSignals.push({ 
                            type: 'BUY', 
                            price: vwapSmartOrder.entryPrice,
                            netProfit: vwapSmartOrder.netProfitPct,
                            quality: quality,
                            time: getReadableTime() 
                        });
                    }
                }
            }
            
            // SHORT: Price above VWAP + Good selling
            else if (vwapDist > 0.3 && obi < -15 && tape.sellPressure > 0.6) {
                const quality = calculateSignalQuality('SHORT', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
                if (quality > 70) {
                    const vwapSmartOrder = calculateSmartEntryShort(bestBid, bestAsk, 'SHORT');
                    if (vwapSmartOrder.shouldSignal && vwapSmartOrder.netProfitPct > 0.4 && vwapSmartOrder.riskReward > 1.3 && shouldLogSignal('VWAP_REVERSION_SHORT', bestAsk)) {
                        signals.push(`<div style='color:#ff8888; font-weight:700'>📉 VWAP REVERSION SHORT (Quality: ${quality}%)</div>`);
                        signals.push(`<div style='color:#ffcccc; font-size:10px'>Price ${vwapDist.toFixed(2)}% above VWAP | OBI: ${obi.toFixed(1)}%</div>`);
                        loggedSignals.push({ 
                            type: 'SHORT', 
                            price: vwapSmartOrder.entryPrice,
                            netProfit: vwapSmartOrder.netProfitPct,
                            quality: quality,
                            time: getReadableTime() 
                        });
                    }
                }
            }
        }
        
        // FALLBACK 4: STRONG Momentum with Multiple Confirmations
        // 🔧 BALANCED: Require good confidence (>55%) and good OBI alignment
        if (momentumPrediction.confidence > 55) {
            if (momentumPrediction.direction === 'BULLISH' && obi > 15 && tape.buyPressure > 0.6) {
                const quality = calculateSignalQuality('LONG', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
                if (quality > 70) {
                    const momentumSmartOrder = calculateSmartEntry(bestBid, bestAsk, 'LONG');
                    if (momentumSmartOrder.shouldSignal && momentumSmartOrder.netProfitPct > 0.4 && momentumSmartOrder.riskReward > 1.3 && shouldLogSignal('MOMENTUM_LONG', bestBid)) {
                        signals.push(`<div style='color:#88ff88; font-weight:700'>📈 MOMENTUM LONG (Quality: ${quality}%)</div>`);
                        signals.push(`<div style='color:#ccffcc; font-size:10px'>Momentum: ${momentumPrediction.confidence.toFixed(0)}% bullish | OBI: ${obi.toFixed(1)}%</div>`);
                        loggedSignals.push({ 
                            type: 'BUY', 
                            price: momentumSmartOrder.entryPrice,
                            netProfit: momentumSmartOrder.netProfitPct,
                            quality: quality,
                            time: getReadableTime() 
                        });
                    }
                }
            } else if (momentumPrediction.direction === 'BEARISH' && obi < -15 && tape.sellPressure > 0.6) {
                const quality = calculateSignalQuality('SHORT', obi, tape, currentPrice, state.vwap, momentumPrediction, rsi);
                if (quality > 70) {
                    const momentumSmartOrder = calculateSmartEntryShort(bestBid, bestAsk, 'SHORT');
                    if (momentumSmartOrder.shouldSignal && momentumSmartOrder.netProfitPct > 0.4 && momentumSmartOrder.riskReward > 1.3 && shouldLogSignal('MOMENTUM_SHORT', bestAsk)) {
                        signals.push(`<div style='color:#ff8888; font-weight:700'>📉 MOMENTUM SHORT (Quality: ${quality}%)</div>`);
                        signals.push(`<div style='color:#ffcccc; font-size:10px'>Momentum: ${momentumPrediction.confidence.toFixed(0)}% bearish | OBI: ${obi.toFixed(1)}%</div>`);
                        loggedSignals.push({ 
                            type: 'SHORT', 
                            price: momentumSmartOrder.entryPrice,
                            netProfit: momentumSmartOrder.netProfitPct,
                            quality: quality,
                            time: getReadableTime() 
                        });
                    }
                }
            }
        }
    }
    
    // 🔧 FIX: Update hasActiveSignals and boostedScore AFTER all signals are generated
    hasActiveSignals = loggedSignals.length > 0;
    boostedScore = hasActiveSignals ? Math.min(100, maxScore + 20) : maxScore;
    
    // 🔧 FIX: Broadcast to Central Brain AFTER signals are generated (with correct data)
    if (chrome && chrome.runtime) {
        try {
            chrome.runtime.sendMessage({
                type: 'OPPORTUNITY_UPDATE',
                symbol: currentSymbol,
                score: boostedScore,
                details: { 
                    scores, 
                    bias: marketBias, 
                    regime: marketRegime,
                    hasSignals: hasActiveSignals,
                    signalCount: loggedSignals.length,
                    originalScore: maxScore
                }
            }).catch(() => { /* Ignore if background not ready */ });
        } catch (err) {
            // Silently fail if background script not ready
        }
    }

    return { signals, loggedSignals };
}

// Imports moved to top


// Initialize Sync Listener
listenToMarket();

export async function processMarketData() {
    // 🔧 FIX: Wrap entire function in try-catch to prevent stopping on errors
    try {
        const currentSymbol = getStockName();
        if (state.symbol !== currentSymbol) {
            // console.log(`Symbol changed from ${state.symbol} to ${currentSymbol}`);
            state.symbol = currentSymbol;

            // Try to load memory for this new symbol
            const loaded = await loadMemory(currentSymbol);
            if (loaded) {
                updateStateBadge(STATES.MONITORING);
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // 📡 BROADCASTER ROLE (If I am the Index/VIX)
        // ─────────────────────────────────────────────────────────────────────
        // ─────────────────────────────────────────────────────────────────────
        // 📡 BROADCASTER ROLE (Indices have no Market Depth)
        // ─────────────────────────────────────────────────────────────────────
        const isIndex = currentSymbol.includes('NIFTY') ||
            currentSymbol.includes('VIX') ||
            window.location.href.includes('/index/indices');

        if (isIndex) {
            // Scrape LTP for Index
            const ltpEl = document.querySelector(SELECTORS.stockPrice);
            const ltpText = ltpEl ? ltpEl.innerText : "0";
            const ltp = cleanNumber(ltpText);

            if (ltp> 0) {
                if (currentSymbol.includes('BANKNIFTY') || currentSymbol.includes('NIFTY') || currentSymbol.includes('BANK')) {
                    // 🔧 FIX: Better trend detection for Bank Nifty
                    // Look for change percentage or color indicators
                    const parent = ltpEl ? ltpEl.parentElement : document.body;
                    const changeEl = parent.innerText.includes('(') ? parent : parent.parentElement;
                    const fullText = changeEl ? changeEl.innerText : "";
                    
                    // Try multiple methods to detect trend
                    const isGreen = fullText.includes('+') || 
                                   fullText.includes('▲') || 
                                   (ltpEl && getComputedStyle(ltpEl).color.includes('200, 83')) ||
                                   (ltpEl && getComputedStyle(ltpEl).color.includes('0, 200'));
                    
                    // Also check for percentage change
                    const changeMatch = fullText.match(/[+-]?(\d+\.?\d*)%/);
                    const changePct = changeMatch ? parseFloat(changeMatch[1]) : 0;
                    
                    const trend = (isGreen || changePct > 0) ? 'BULLISH' : (changePct < 0) ? 'BEARISH' : 'FLAT';

                    broadcastUpdate('BANKNIFTY_UPDATE', {
                        ltp: ltp,
                        trend: trend,
                        changePct: changePct
                    });

                    // Update UI for Index Tab
                    const sectorStatus = document.getElementById('sectorStatus');
                    if (sectorStatus) sectorStatus.innerText = `BROADCASTING: ${trend} (${ltp.toFixed(0)})`;
                }

                if (currentSymbol.includes('VIX')) {
                    // 🔧 FIX: Broadcast VIX with regime calculation
                    const vixRegime = ltp < 12 ? 'LOW' : (ltp > 16 ? 'HIGH' : 'NORMAL');
                    broadcastUpdate('VIX_UPDATE', { 
                        ltp: ltp,
                        regime: vixRegime
                    });

                    // Update UI for VIX Tab
                    const sectorStatus = document.getElementById('sectorStatus');
                    if (sectorStatus) sectorStatus.innerText = `BROADCASTING: ${ltp.toFixed(1)} (${vixRegime})`;
                }
            }

            // Indices don't have Depth, so we stop here to avoid errors
            return;
        }

        if (isOptionsChain()) {
            // 🔧 FIX: Only use sector sentiment for bank stocks
            const sector = isBankStock(currentSymbol) ? getSectorSentiment() : { netScore: 0, panicCount: 0, bullishCount: 0, activeCount: 0, connectedPeers: [] };
            const ocData = processOptionsChain(sector.netScore);

            if (ocData && ocData.pcr > 0) {
                // Ensure all required fields exist
                const safeOcData = {
                    ...ocData,
                    pcr: ocData.pcr || 0,
                    totalCallOI: ocData.totalCallOI || 0,
                    totalPutOI: ocData.totalPutOI || 0,
                    atmStrike: ocData.atmStrike || 0,
                    atmCallLTP: ocData.atmCallLTP || 0,
                    atmPutLTP: ocData.atmPutLTP || 0,
                    ltp: ocData.ltp || currentSymbol.includes('HDFC') ? 1007 : (currentSymbol.includes('SBIN') ? 984 : 0),
                    maxPainStrike: ocData.maxPainStrike || 0,
                    callWalls: ocData.callWalls || [],
                    putWalls: ocData.putWalls || [],
                    pcrTrend: state.pcrTrend || 0
                };
                
                // Store options data globally so it persists when switching tabs
                lastOptionsData = {
                    ...safeOcData,
                    symbol: currentSymbol,
                    timestamp: Date.now()
                };
                
                updateOptionsUI(safeOcData);
                updatePCRStats(safeOcData.pcr); // Track PCR Trend
                state.pcrTrend = getPCRTrend(); // Store in global state

                // 📡 BROADCAST COMPLETE OPTIONS DATA TO SPOT CHART
                broadcastUpdate('OPTIONS_UPDATE', {
                    symbol: currentSymbol,
                    pcr: safeOcData.pcr,
                    pcrTrend: state.pcrTrend,
                    callOI: safeOcData.totalCallOI,
                    putOI: safeOcData.totalPutOI,
                    atmStrike: safeOcData.atmStrike,
                    // Enhanced Complete Data
                    maxPainStrike: safeOcData.maxPainStrike,
                    maxCallOIStrike: safeOcData.maxCallOIStrike || 0,
                    maxPutOIStrike: safeOcData.maxPutOIStrike || 0,
                    callWalls: safeOcData.callWalls,
                    putWalls: safeOcData.putWalls,
                    highPCRStrikes: safeOcData.highPCRStrikes || [],
                    lowPCRStrikes: safeOcData.lowPCRStrikes || [],
                    totalCallVolume: safeOcData.totalCallVolume || 0,
                    totalPutVolume: safeOcData.totalPutVolume || 0,
                    strikeCount: safeOcData.strikeCount || 0,
                    ltp: safeOcData.ltp
                });

                // 🔧 FIX: Evaluate signals even in OPTIONS_MODE (for options-based signals)
                // Get market context for signal evaluation
                let market = getMarketContext();
                
                // 🔧 CRITICAL FIX: Get actual stock price, not index value
                // safeOcData.ltp is the index (e.g., 1007), not the stock price (e.g., 1272)
                // We need the actual stock price for distance calculations to work correctly
                let actualStockPrice = 0;
                const ltpEl = document.querySelector(SELECTORS.stockPrice);
                if (ltpEl) {
                    actualStockPrice = cleanNumber(ltpEl.innerText);
                }
                
                // Fallback: Try to get from spot price element
                if (actualStockPrice === 0) {
                    const spotPill = Array.from(document.querySelectorAll('.spot-price, .current-price, .ltp-badge')).find(el => {
                        return el.offsetParent !== null && /[0-9]/.test(el.innerText);
                    });
                    if (spotPill) actualStockPrice = cleanNumber(spotPill.innerText);
                }
                
                // Final fallback: Use ATM strike as proxy (close to actual price)
                if (actualStockPrice === 0 && safeOcData.atmStrike > 0) {
                    actualStockPrice = safeOcData.atmStrike;
                }
                
                // Use actual stock price for signal evaluation
                const bestBid = actualStockPrice || safeOcData.ltp || 0;
                const bestAsk = actualStockPrice || safeOcData.ltp || 0;
                
                // Create minimal context for options-based signal evaluation
                // We can still evaluate options-specific signals (Max Pain, OI Walls, PCR signals)
                const optionsContext = {
                    sector,
                    tape: { aggressorSide: 'NEUTRAL', buyPressure: 0.5, velocity: 'LOW', velocityNum: 0, retailSentiment: 0.5 },
                    bestBid,
                    bestAsk,
                    inDemandZone: false,
                    inSupplyZone: false,
                    nearVWAP: false,
                    bookGappy: false,
                    isPanic: false,
                    pcrTrend: state.pcrTrend || 0,
                    market,
                    bids: [],
                    asks: [],
                    momentumPrediction: { direction: 'NEUTRAL', confidence: 0 },
                    obi: 0
                };
                
                // Evaluate signals (will capture options-specific signals like Max Pain, OI Walls, etc.)
                const { signals, loggedSignals } = evaluateSignals(optionsContext);
                
                // Update UI with signals if any
                const signalBox = document.getElementById('signalBox');
                if (signalBox && signals.length > 0) {
                    signalBox.innerHTML = signals.slice(0, 4).join('');
                }

                // Smart Recording: Deduplicate Options Data
                // Only record if OI/PCR/Volume/Walls change OR heartbeat time elapsed OR signals detected
                const isDataChanged = !lastOptionsSnapshot ||
                    safeOcData.totalCallOI !== lastOptionsSnapshot.totalCallOI ||
                    safeOcData.totalPutOI !== lastOptionsSnapshot.totalPutOI ||
                    safeOcData.pcr !== lastOptionsSnapshot.pcr ||
                    (safeOcData.totalCallVolume || 0) !== (lastOptionsSnapshot.totalCallVolume || 0) ||
                    (safeOcData.totalPutVolume || 0) !== (lastOptionsSnapshot.totalPutVolume || 0) ||
                    JSON.stringify(safeOcData.callWalls || []) !== JSON.stringify(lastOptionsSnapshot.callWalls || []) ||
                    JSON.stringify(safeOcData.putWalls || []) !== JSON.stringify(lastOptionsSnapshot.putWalls || []);

                // 🔧 FIX: Force recording at least every 3 seconds in options mode
                // Ensure continuous recording even if options data doesn't change
                const isHeartbeat = !lastOptionsSnapshot || (Date.now() - (lastOptionsSnapshot.timestamp || 0) > 3000);
                const hasSignal = loggedSignals.length > 0; // Always record if there's a signal
                
                // Always record on first snapshot or if heartbeat elapsed
                const mustRecord = !lastOptionsSnapshot || isHeartbeat;

                const shouldRecord = isDataChanged || mustRecord || hasSignal;

                if (shouldRecord) {
                    const ts = getPreciseTimestamp();

                    // 🔧 FIX: Record ALL options chain data + signals for complete analysis
                    recordSnapshot({
                        timestamp: ts.unix,
                        time: ts.readable,
                        state: 'OPTIONS_MODE',
                        // Basic Metrics
                        pcr: safeOcData.pcr,
                        totalCallOI: safeOcData.totalCallOI,
                        totalPutOI: safeOcData.totalPutOI,
                        totalCallVolume: safeOcData.totalCallVolume || 0,
                        totalPutVolume: safeOcData.totalPutVolume || 0,
                        atmStrike: safeOcData.atmStrike,
                        atmCallLTP: safeOcData.atmCallLTP,
                        atmPutLTP: safeOcData.atmPutLTP,
                        sectorScore: safeOcData.sectorScore,
                        ltp: actualStockPrice || safeOcData.ltp, // Use actual stock price, not index value
                        // Advanced Analysis
                        maxPainStrike: safeOcData.maxPainStrike,
                        maxCallOIStrike: safeOcData.maxCallOIStrike || 0,
                        maxPutOIStrike: safeOcData.maxPutOIStrike || 0,
                        callWalls: safeOcData.callWalls || [], // Top 3 Call Resistance Levels
                        putWalls: safeOcData.putWalls || [], // Top 3 Put Support Levels
                        highPCRStrikes: safeOcData.highPCRStrikes || [], // Strikes with PCR > 2.0
                        lowPCRStrikes: safeOcData.lowPCRStrikes || [], // Strikes with PCR < 0.5
                        strikeCount: safeOcData.strikeCount || 0,
                        pcrTrend: safeOcData.pcrTrend || 0,
                        // 🔧 FIX: Record signals for post-market analysis
                        signals: loggedSignals
                    });

                    lastOptionsSnapshot = {
                        totalCallOI: safeOcData.totalCallOI,
                        totalPutOI: safeOcData.totalPutOI,
                        totalCallVolume: safeOcData.totalCallVolume || 0,
                        totalPutVolume: safeOcData.totalPutVolume || 0,
                        pcr: safeOcData.pcr,
                        callWalls: safeOcData.callWalls || [],
                        putWalls: safeOcData.putWalls || [],
                        timestamp: Date.now()
                    };

                    const recDisplay = document.getElementById('recDisplay');
                    if (recDisplay) {
                        const count = getRecordedDataLength();
                        recDisplay.innerText = `REC: ${count}`;
                        // Show warning if recording seems stuck
                        if (lastOptionsSnapshot && (Date.now() - (lastOptionsSnapshot.timestamp || 0) > 10000)) {
                            recDisplay.style.color = '#ff4444';
                            recDisplay.title = '⚠️ Recording may be stuck';
                        } else {
                            recDisplay.style.color = '';
                            recDisplay.title = '';
                        }
                    }
                }

                // 🔧 FIX: Only broadcast sector status if this is a bank stock
                if (isBankStock(currentSymbol)) {
                    broadcastSectorStatus(0, false, safeOcData.ltp || state.vwap || 0, 'OPTIONS');
                }
            } else {
                // 🔧 FIX: Only warn if we're actually on options page
                // If not on options page, it's normal to not get data (we use cached data)
                if (isOptionsChain()) {
                    console.warn('⚠️ Options Chain Data is null or invalid (on options page):', {
                        isOptionsChain: isOptionsChain(),
                        ocData: ocData,
                        hasPCR: ocData?.pcr > 0
                    });
                }
                // Otherwise, silently use cached data (expected behavior when on Market tab)
            }
            return;
        }

        let buyRows = Array.from(document.querySelectorAll(SELECTORS.buyRows));
        let sellRows = Array.from(document.querySelectorAll(SELECTORS.sellRows));

        // Fallback: If primary selectors fail, try to find depth tables by content
        if (buyRows.length === 0 || sellRows.length === 0) {
            // Look for tables that might contain market depth
            const allTables = Array.from(document.querySelectorAll('table'));
            for (const table of allTables) {
                const tableText = (table.innerText || '').toLowerCase();
                const hasBid = tableText.includes('bid') || tableText.includes('buy');
                const hasAsk = tableText.includes('ask') || tableText.includes('sell');

                if (hasBid && buyRows.length === 0) {
                    const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
                    if (rows.length> 0) {
                        buyRows = rows;
                    }
                }
                if (hasAsk && sellRows.length === 0) {
                    const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
                    if (rows.length> 0) {
                        sellRows = rows;
                    }
                }
            }

            // If still not found, try to find two adjacent tables (common pattern)
            if ((buyRows.length === 0 || sellRows.length === 0) && allTables.length>= 2) {
                // Usually first table is bids, second is asks (or vice versa)
                const firstTableRows = Array.from(allTables[0].querySelectorAll('tbody tr, tr'));
                const secondTableRows = Array.from(allTables[1].querySelectorAll('tbody tr, tr'));

                if (firstTableRows.length> 0 && secondTableRows.length> 0) {
                    // Try both combinations
                    if (buyRows.length === 0) buyRows = firstTableRows;
                    if (sellRows.length === 0) sellRows = secondTableRows;
                }
            }
        }

        let bids = [], asks = [], quantities = [];
        let totalBidQty = 0, totalAskQty = 0;

        buyRows.forEach(row => row.classList.remove('wall-support', 'wall-melt', 'zone-demand'));
        sellRows.forEach(row => row.classList.remove('wall-resistance', 'wall-melt', 'zone-supply'));

        // Helper function to extract quantity from a column (tries multiple methods)
        const extractQty = (col) => {
            if (!col) return 0;
            // Method 1: Try nested element first (if exists)
            const nested = col.querySelector(SELECTORS.depthQty);
            if (nested && nested.innerText) {
                const val = cleanNumber(nested.innerText);
                if (val> 0) return val;
            }
            // Method 2: Direct text from column
            const direct = cleanNumber(col.innerText);
            if (direct> 0) return direct;
            // Method 3: Try any child text nodes
            const allText = col.textContent || col.innerText || '';
            return cleanNumber(allText);
        };

        // Helper function to extract price from a column
        const extractPrice = (col) => {
            if (!col) return 0;
            return cleanNumber(col.innerText || col.textContent || '');
        };

        // Parse buy rows (bids) - Try multiple column combinations
        buyRows.forEach(row => {
            const cols = Array.from(row.querySelectorAll('td'));
            if (cols.length < 2) return;

            let price = 0, qty = 0;

            // Common patterns for bid rows:
            // Pattern 1: [Qty, Price] (cols[0] = qty, cols[1] = price)
            // Pattern 2: [Price, Qty] (cols[0] = price, cols[1] = qty) 
            // Pattern 3: [Index, Qty, Price] (cols[1] = qty, cols[2] = price)
            // Pattern 4: [Qty, Price, ...] (cols[0] = qty, cols[1] = price)

            // Try Pattern 3 first (most common in Dhan)
            if (cols.length>= 3) {
                qty = extractQty(cols[1]);
                price = extractPrice(cols[2]);
                if (qty> 0 && price> 0) {
                    bids.push({ row, price, qty });
                    totalBidQty += qty;
                    quantities.push(qty);
                    return;
                }
            }

            // Try Pattern 1: [Qty, Price]
            qty = extractQty(cols[0]);
            price = extractPrice(cols[1]);
            if (qty> 0 && price> 0) {
                bids.push({ row, price, qty });
                totalBidQty += qty;
                quantities.push(qty);
                return;
            }

            // Try Pattern 2: [Price, Qty]
            price = extractPrice(cols[0]);
            qty = extractQty(cols[1]);
            if (qty> 0 && price> 0) {
                bids.push({ row, price, qty });
                totalBidQty += qty;
                quantities.push(qty);
            }
        });

        // Parse sell rows (asks) - Try multiple column combinations
        sellRows.forEach(row => {
            const cols = Array.from(row.querySelectorAll('td'));
            if (cols.length < 2) return;

            let price = 0, qty = 0;

            // Common patterns for ask rows:
            // Pattern 1: [Price, Qty] (cols[0] = price, cols[1] = qty) - Most common
            // Pattern 2: [Qty, Price] (cols[0] = qty, cols[1] = price)
            // Pattern 3: [Price, Qty, ...] (cols[0] = price, cols[1] = qty)

            // Try Pattern 1 first (most common)
            price = extractPrice(cols[0]);
            qty = extractQty(cols[1]);
            if (qty> 0 && price> 0) {
                asks.push({ row, price, qty });
                totalAskQty += qty;
                quantities.push(qty);
                return;
            }

            // Try Pattern 2: [Qty, Price]
            qty = extractQty(cols[0]);
            price = extractPrice(cols[1]);
            if (qty> 0 && price> 0) {
                asks.push({ row, price, qty });
                totalAskQty += qty;
                quantities.push(qty);
            }
        });

        if (bids.length === 0 || asks.length === 0) {
            // 🕵️ DESPERATE SEARCH: Find tables by content if selectors failed
            // This handles cases where class names changed or are dynamic
            const allTables = Array.from(document.querySelectorAll('table'));
            for (const table of allTables) {
                const text = (table.innerText || '').toLowerCase();
                const rows = Array.from(table.querySelectorAll('tr'));

                // Skip header row usually
                const dataRows = rows.filter(r => r.querySelectorAll('td').length>= 2);

                if (text.includes('bid') && text.includes('qty') && bids.length === 0) {
                    dataRows.forEach(row => {
                        const cols = Array.from(row.querySelectorAll('td'));
                        // Try standard [Qty, Price] or [Price, Qty]
                        let q = extractQty(cols[0]);
                        let p = extractPrice(cols[1]);
                        if (q> 0 && p> 0) { bids.push({ row, price: p, qty: q }); totalBidQty += q; return; }

                        // Try reverse
                        p = extractPrice(cols[0]);
                        q = extractQty(cols[1]);
                        if (q> 0 && p> 0) { bids.push({ row, price: p, qty: q }); totalBidQty += q; }
                    });
                }

                if ((text.includes('ask') || text.includes('sell')) && text.includes('qty') && asks.length === 0) {
                    dataRows.forEach(row => {
                        const cols = Array.from(row.querySelectorAll('td'));
                        let p = extractPrice(cols[0]);
                        let q = extractQty(cols[1]);
                        if (q> 0 && p> 0) { asks.push({ row, price: p, qty: q }); totalAskQty += q; return; }

                        q = extractQty(cols[0]);
                        p = extractPrice(cols[1]);
                        if (q> 0 && p> 0) { asks.push({ row, price: p, qty: q }); totalAskQty += q; }
                    });
                }
            }
        }

        if (bids.length === 0 || asks.length === 0) {
            console.warn('⚠️ No Market Depth Found. Check Selectors.');
            console.warn(`Found ${buyRows.length} buy rows, ${sellRows.length} sell rows`);
            if (buyRows.length> 0) {
                const sampleRow = buyRows[0];
                const sampleCols = Array.from(sampleRow.querySelectorAll('td'));
                console.warn('Sample buy row:', {
                    cols: sampleCols.length,
                    texts: sampleCols.map(c => c.innerText?.trim()).slice(0, 3)
                });
            }
            if (sellRows.length> 0) {
                const sampleRow = sellRows[0];
                const sampleCols = Array.from(sampleRow.querySelectorAll('td'));
                console.warn('Sample sell row:', {
                    cols: sampleCols.length,
                    texts: sampleCols.map(c => c.innerText?.trim()).slice(0, 3)
                });
            }

            return;
        }

        const bestBid = bids[0].price;
        const bestAsk = asks[0].price;
        const ltp = (bestBid + bestAsk) / 2;

        quantities.forEach(q => {
            metrics.totalRowQty += q;
            metrics.rowCount++;
        });

        const avgQty = metrics.rowCount > 0 ? metrics.totalRowQty / metrics.rowCount : 0;
        metrics.avgRowValue = avgQty * bestBid;

        const { trades, hasNewTrades, newCount, scrapeTime } = getRealTimeTrades();
        const tape = analyzeTape(trades, bestBid, bestAsk, hasNewTrades, newCount);

        // 🛑 STALE DATA DETECTION
        if (hasNewTrades) {
            state.lastDataTime = Date.now();
        } else if (state.lastDataTime && (Date.now() - state.lastDataTime > 15000)) {
            // No trades for 15 seconds? Suspicious.
            if (shouldLogSignal('STALE_WARNING', 0)) {
                showToast('⚠️ DATA FROZEN? No trades for 15s', '#ffaa00', '');
            }
        }

        // Update Volume Stats
        const volumeThisTick = trades.reduce((acc, t) => acc + t.quantity, 0);
        updateVolumeStats(volumeThisTick);
        updatePriceStats(ltp); // Track Price for RSI
        updateVWAP(ltp, volumeThisTick);

        const rvol = getRVOL();

        // 🔧 FIX: Calculate OBI from TOP 5 LEVELS ONLY (as per tooltip)
        // This focuses on immediate liquidity and matches what's displayed
        const top5BidQty = bids.slice(0, 5).reduce((sum, b) => sum + b.qty, 0);
        const top5AskQty = asks.slice(0, 5).reduce((sum, a) => sum + a.qty, 0);
        const obi = top5BidQty + top5AskQty > 0 
            ? ((top5BidQty - top5AskQty) / (top5BidQty + top5AskQty)) * 100 
            : 0;
        const isPanic = tape.isHighVelocity && obi < OBI_PANIC_THRESHOLD;

        // 🔮 Update predictive momentum tracking
        updateMomentumHistory(ltp, tape.velocityNum, obi, tape);
        const momentumPrediction = predictMomentum();

        // 🔧 FIX: Only broadcast sector status if this is a bank stock
        if (isBankStock(currentSymbol)) {
            broadcastSectorStatus(obi, isPanic, bestBid, tape.velocity);
        }

        // 🔧 FIX: Only get sector sentiment for bank stocks, otherwise use neutral
        const sector = isBankStock(currentSymbol) ? getSectorSentiment() : { netScore: 0, panicCount: 0, bullishCount: 0, activeCount: 0, connectedPeers: [] };

        // 📡 CHECK FOR REMOTE OPTIONS DATA (TELEPATHY)
        // Optimization: UI is now updated via listenToMarket callback (Event Driven)
        // We just need to ensure 'market' is available for signals.
        let market = getMarketContext();

        const now = Date.now();
        if (discoveryStartTime && now - discoveryStartTime < DISCOVERY_MINS * 60 * 1000) {
            updateStateBadge(STATES.DISCOVERY);
        } else if (currentState === STATES.DISCOVERY) {
            updateStateBadge(STATES.MONITORING);
        }

        // Always run analysis (zones, signals, etc.)
        identifyZones(bids, asks, trades, bestBid, bestAsk);

        const WALL_THRESHOLD = avgQty * WALL_MULTIPLIER;
        const SPOOF_THRESHOLD_VALUE = metrics.avgRowValue * SPOOF_MULTIPLIER;

        const inDemandZone = isInDemandZone(bestBid);
        const inSupplyZone = isInSupplyZone(bestAsk);
        const nearVWAP = isNearVWAP(ltp);
        const bookGappy = isBookGappy(bids, asks);

        if (currentState === STATES.MONITORING && (inDemandZone || inSupplyZone)) {
            updateStateBadge(STATES.ZONE_ALERT);
        } else if (currentState === STATES.ZONE_ALERT && !inDemandZone && !inSupplyZone) {
            updateStateBadge(STATES.MONITORING);
        }

        // --- EVALUATE SIGNALS ---
        // Get Global Context (VIX, Sector)
        market = getMarketContext(); // Already defined above

        const { signals, loggedSignals } = evaluateSignals({
            sector, tape, bestBid, bestAsk, inDemandZone, inSupplyZone,
            nearVWAP, bookGappy, isPanic,
            pcrTrend: state.pcrTrend || (market && market.options && market.options[state.symbol] ? market.options[state.symbol].pcrTrend : 0),
            market, // Pass Market Context
            bids, asks, // Pass Order Book
            momentumPrediction, // Pass predictive momentum
            obi // Pass pre-calculated OBI (from totalBidQty/totalAskQty - all rows)
        });
        
        // 🔧 NEW: Store tradable signals for Central Brain execution
        // Only store tradable signals (BUY/SELL/LONG/SHORT)
        const tradableSignals = signals.filter(s => 
            s.type === 'BUY' || s.type === 'SELL' || 
            s.type === 'LONG' || s.type === 'SHORT'
        );
        if (tradableSignals.length > 0) {
            lastSignalsForExecution = tradableSignals;
            // If Central Brain is active, execute immediately
            if (centralBrainActive) {
                executeCentralBrainTrades(tradableSignals);
            }
        }

        const currentPrices = new Set([...bids.map(b => b.price), ...asks.map(a => a.price)]);
        Object.keys(wallTracker).forEach(price => {
            if (!currentPrices.has(parseFloat(price))) delete wallTracker[price];
        });

        bids.forEach(bid => {
            if (isInDemandZone(bid.price)) {
                bid.row.classList.add('zone-demand');
            }

            if (bid.qty > WALL_THRESHOLD) {
                bid.row.classList.add('wall-support');

                if (wallTracker[bid.price]) {
                    const prevQty = wallTracker[bid.price];
                    const dropQty = prevQty - bid.qty;
                    const dropValue = dropQty * bid.price;

                    if (dropQty > 0) {
                        const tradedAtPrice = trades.filter(t => t.price === bid.price)
                            .reduce((acc, t) => acc + t.quantity, 0);

                        if (dropValue > SPOOF_THRESHOLD_VALUE && tradedAtPrice < dropQty * 0.1) {
                            if (shouldLogSignal('SPOOF_SUPPORT', bid.price)) {
                                const valLakhs = (dropValue / 100000).toFixed(1);
                                signals.push('SPOOF');
                                loggedSignals.push({ type: 'SPOOF_SUPPORT', price: bid.price, val: valLakhs, time: getReadableTime() });
                                showToast(`SPOOF: ${valLakhs}L pulled`, '#ff9800', '');
                            }
                        } else if (dropQty > prevQty * 0.3) {
                            bid.row.classList.add('wall-melt');
                            signals.push(`<div style='color:#ff4444'>⚠️ Support melting @ ${bid.price}</div>`);
                        }
                    }
                }
                wallTracker[bid.price] = bid.qty;
            }
        });

        asks.forEach(ask => {
            if (isInSupplyZone(ask.price)) {
                ask.row.classList.add('zone-supply');
            }

            if (ask.qty > WALL_THRESHOLD) {
                ask.row.classList.add('wall-resistance');

                if (wallTracker[ask.price]) {
                    const prevQty = wallTracker[ask.price];
                    const dropQty = prevQty - ask.qty;
                    const dropValue = dropQty * ask.price;

                    if (dropQty > 0) {
                        const tradedAtPrice = trades.filter(t => t.price === ask.price)
                            .reduce((acc, t) => acc + t.quantity, 0);

                        if (dropValue > SPOOF_THRESHOLD_VALUE && tradedAtPrice < dropQty * 0.1) {
                            if (shouldLogSignal('SPOOF_RESISTANCE', ask.price)) {
                                const valLakhs = (dropValue / 100000).toFixed(1);
                                signals.push(`<div style='color:#ff9800'>SPOOF: ${valLakhs}L @ ${ask.price}</div>`);
                                loggedSignals.push({ type: 'SPOOF_RESISTANCE', price: ask.price, val: valLakhs, time: getReadableTime() });
                            }
                        } else if (dropQty > prevQty * 0.3) {
                            ask.row.classList.add('wall-melt');
                        }
                    }
                }
                wallTracker[ask.price] = ask.qty;
            }
        });

        // ─────────────────────────────────────────────────────────────────────────
        // 💾 SMART RECORDING (Optimized for Size & Utility)
        // ─────────────────────────────────────────────────────────────────────────
        const ts = getPreciseTimestamp();

        // 1. DEDUPLICATION: Has anything significant changed?
        const isPriceChanged = !lastMarketSnapshot ||
            ltp !== lastMarketSnapshot.ltp ||
            bestBid !== lastMarketSnapshot.bestBid ||
            bestAsk !== lastMarketSnapshot.bestAsk;

        const shouldRecordTrades = trades.length > 0 && (!lastMarketSnapshot || trades[0].timeStr !== lastMarketSnapshot.lastTradeTime);
        const hasSignal = loggedSignals.length > 0; // Always record if there's a signal

        // 🔧 FIX: Force recording at least every 2 seconds to ensure continuous data
        // This prevents gaps in recording even if nothing changes
        const isHeartbeat = !lastMarketSnapshot || (Date.now() - lastMarketSnapshot.timestamp > 2000);
        
        // Always record on first snapshot or if heartbeat elapsed
        const mustRecord = !lastMarketSnapshot || isHeartbeat;

        if (isPriceChanged || shouldRecordTrades || hasSignal || mustRecord) {
            recordSnapshot({
                timestamp: ts.unix,
                state: currentState,
                ltp: ltp,
                bestBid: bestBid,
                bestAsk: bestAsk,
                spread: parseFloat((bestAsk - bestBid).toFixed(2)),

                // COMPRESSION: Only Top 5 Levels are critical for most analysis
                marketDepth: {
                    bids: bids.slice(0, 5).map(b => [b.price, b.qty]),
                    asks: asks.slice(0, 5).map(a => [a.price, a.qty])
                },

                // DELTA: Only record top 10 recent trades to save space
                recentTrades: trades.slice(0, 10).map(t => [t.timeStr, t.price, t.quantity]),

                analysis: {
                    obi: parseFloat(obi.toFixed(1)),
                    vwap: parseFloat(state.vwap.toFixed(2)),
                    tape: {
                        vel: tape.velocity, // String is fine
                        buyP: parseFloat(tape.buyPressure.toFixed(2)),
                    },
                    rvol: parseFloat(rvol.toFixed(2)),
                    zoneCount: { d: state.zones.demand.length, s: state.zones.supply.length },
                    sector: sector.netScore
                },
                signals: loggedSignals
            });

            // Update Last Snapshot State
            lastMarketSnapshot = {
                ltp, bestBid, bestAsk,
                lastTradeTime: trades.length > 0 ? trades[0].timeStr : null,
                timestamp: Date.now()
            };
        }

        // Update UI
        const obiDisplay = document.getElementById('obiDisplay');
        if (obiDisplay) {
            const obiColor = obi > 0 ? '#00c853' : '#ff4444';
            // Show warning if tape and OBI diverge significantly
            const tapeObiDiverge = (tape.buyPressure > 0.7 && obi < -20) || (tape.buyPressure < 0.3 && obi > 20);
            const warningIcon = tapeObiDiverge ? '⚠️' : '';
            obiDisplay.innerHTML = `<span style="color:${obiColor}">${warningIcon}OBI: ${obi.toFixed(0)}%</span>`;
            obiDisplay.title = tapeObiDiverge ? 'Warning: Tape and Order Book diverging!' : `Order Book Imbalance (Top 5 levels)`;
        }

        const velocityDisplay = document.getElementById('velocityDisplay');
        if (velocityDisplay) {
            const velColor = tape.isHighVelocity ? '#ff4444' : tape.velocity === 'NORMAL' ? '#ffab00' : '#888';
            const velNum = tape.velocityNum.toFixed(1);
            velocityDisplay.innerHTML = `<span style="color:${velColor}">VEL: ${velNum}/s</span>`;
        }

        const recDisplay = document.getElementById('recDisplay');
        if (recDisplay) {
            const count = getRecordedDataLength();
            recDisplay.innerText = `REC: ${count}`;
            // 🔧 FIX: Show warning if recording seems stuck (no new snapshots in 10 seconds)
            if (lastMarketSnapshot && (Date.now() - lastMarketSnapshot.timestamp > 10000)) {
                recDisplay.style.color = '#ff4444';
                recDisplay.title = '⚠️ Recording may be stuck - check console';
            } else {
                recDisplay.style.color = '';
                recDisplay.title = '';
            }
        }

        const signalBox = document.getElementById('signalBox');
        if (signalBox) {
            if (signals.length > 0) {
                // Show signals (they take priority)
                signalBox.innerHTML = signals.slice(0, 4).join('');
            } else {
                // 🔧 FIX: Preserve options chain data if it exists and is fresh
                // Only show tape info if options chain data is not available or stale
                const hasFreshOptionsData = lastOptionsData && 
                    lastOptionsData.symbol === currentSymbol &&
                    (Date.now() - (lastOptionsData.timestamp || 0)) < 5 * 60 * 1000; // 5 minutes freshness
                
                if (hasFreshOptionsData) {
                    // Don't overwrite - let options chain data stay visible
                    // The polling function will update it in the background
                    // We only update if it's been more than 5 seconds since last options update
                    const timeSinceLastUpdate = Date.now() - (lastOptionsData.lastUIUpdate || lastOptionsData.timestamp || 0);
                    if (timeSinceLastUpdate > 5000) {
                        // Silently refresh options data without flashing
                        updateOptionsUI(lastOptionsData);
                    }
                } else {
                    // No options data - show tape info
                    const tapeInfo = `<span style="color:${tape.tapeColor === 'GREEN' ? '#00c853' : tape.tapeColor === 'RED' ? '#ff4444' : '#888'}">${tape.tapeColor}</span>`;
                    signalBox.innerHTML = `
                        <div style='color:#444; font-size:11px'>
                            <div>Tape: ${tapeInfo} | Buy: ${(tape.buyPressure * 100).toFixed(0)}%</div>
                            <div style="margin-top:4px">LTP: ${ltp.toFixed(2)} | VWAP: ${state.vwap.toFixed(2)}</div>
                        </div>
                    `;
                }
            }
        }
    } catch (e) {
        // 🔧 FIX: Enhanced error handling - log but don't stop recording
        console.error("❌ Hybrid Quant Error in processMarketData:", e);
        console.error("Stack:", e.stack);
        
        // Still try to record a minimal snapshot to prevent gaps
        try {
            const ts = getPreciseTimestamp();
            const currentSymbol = getStockName() || state.symbol || "UNKNOWN";
            recordSnapshot({
                timestamp: ts.unix,
                time: ts.readable,
                state: 'ERROR',
                ltp: 0,
                error: e.message,
                symbol: currentSymbol
            });
        } catch (recordError) {
            console.error("❌ Failed to record error snapshot:", recordError);
        }
    }
}

// Initialize Passive Listener for Option Chain Updates
listenToMarket((type, data) => {
    if (type === 'OPTIONS_UPDATE' && data.symbol === state.symbol) {
        // Store the options data so it persists when switching tabs
        lastOptionsData = {
            ...data,
            symbol: data.symbol,
            timestamp: Date.now(),
            // Map broadcasted fields to UI fields (handle both naming conventions)
            totalCallOI: data.callOI || data.totalCallOI || 0,
            totalPutOI: data.putOI || data.totalPutOI || 0,
            // Ensure all required fields exist
            pcr: data.pcr || 0,
            atmStrike: data.atmStrike || 0,
            atmCallLTP: data.atmCallLTP || 0,
            atmPutLTP: data.atmPutLTP || 0,
            ltp: data.ltp || 0,
            maxPainStrike: data.maxPainStrike || 0,
            callWalls: data.callWalls || [],
            putWalls: data.putWalls || [],
            pcrTrend: data.pcrTrend || 0
        };
        updateOptionsUI(lastOptionsData);
    }
});

// 🔧 CONTINUOUS OPTIONS CHAIN POLLING
// Continuously fetch and update options chain data at intervals, even when on Market tab
let optionsChainPollInterval = null;
let lastSuccessfulOptionsPoll = Date.now(); // Module-level for health check

function startOptionsChainPolling() {
    // Clear any existing interval
    if (optionsChainPollInterval) {
        clearInterval(optionsChainPollInterval);
    }
    
    let consecutiveErrors = 0;
    
    // Poll every 3 seconds for options chain data
    optionsChainPollInterval = setInterval(() => {
        // 🔧 FIX: Add error handling to prevent polling from stopping
        try {
            const currentSymbol = getStockName();
            if (!currentSymbol) {
                consecutiveErrors++;
                // If no symbol for too long, restart polling
                if (consecutiveErrors > 10) {
                    console.warn('⚠️ Options polling: No symbol for too long, restarting...');
                    clearInterval(optionsChainPollInterval);
                    optionsChainPollInterval = null;
                    setTimeout(() => startOptionsChainPolling(), 5000);
                }
                return;
            }
            
            // Reset error counter on successful symbol fetch
            consecutiveErrors = 0;
            
            // 🔧 CONTINUOUS UPDATE: Try to process options chain data
            // This works even if not on options chain page, as long as table exists in DOM
            // Also works if user switches tabs - we keep trying to fetch fresh data
            // 🔧 FIX: Only use sector sentiment for bank stocks
            let sector;
            try {
                sector = isBankStock(currentSymbol) ? getSectorSentiment() : { netScore: 0, panicCount: 0, bullishCount: 0, activeCount: 0, connectedPeers: [] };
            } catch (sectorError) {
                console.error('❌ Error getting sector sentiment:', sectorError);
                sector = { netScore: 0, panicCount: 0, bullishCount: 0, activeCount: 0, connectedPeers: [] };
            }
            
            let ocData = null;
            try {
                ocData = processOptionsChain(sector.netScore);
            } catch (processError) {
                console.error('❌ Error in processOptionsChain:', processError);
                // Continue with cached data if processing fails
                ocData = null;
            }
        
        if (ocData && ocData.pcr > 0) {
            // Ensure all required fields exist
            const safeOcData = {
                ...ocData,
                pcr: ocData.pcr || 0,
                totalCallOI: ocData.totalCallOI || 0,
                totalPutOI: ocData.totalPutOI || 0,
                atmStrike: ocData.atmStrike || 0,
                atmCallLTP: ocData.atmCallLTP || 0,
                atmPutLTP: ocData.atmPutLTP || 0,
                ltp: ocData.ltp || (currentSymbol.includes('HDFC') ? 1007 : (currentSymbol.includes('SBIN') ? 984 : 0)),
                maxPainStrike: ocData.maxPainStrike || 0,
                callWalls: ocData.callWalls || [],
                putWalls: ocData.putWalls || [],
                pcrTrend: state.pcrTrend || 0
            };
            
            // Store options data globally
            lastOptionsData = {
                ...safeOcData,
                symbol: currentSymbol,
                timestamp: Date.now()
            };
            
            // Update UI with fresh data (only if valid)
            try {
                updateOptionsUI(safeOcData);
            } catch (uiError) {
                console.error('❌ Error updating options UI:', uiError);
            }
            
            try {
                updatePCRStats(safeOcData.pcr);
                state.pcrTrend = getPCRTrend();
            } catch (pcrError) {
                console.error('❌ Error updating PCR stats:', pcrError);
            }
            
            // Broadcast to other tabs
            try {
                broadcastUpdate('OPTIONS_UPDATE', {
                symbol: currentSymbol,
                pcr: safeOcData.pcr,
                pcrTrend: state.pcrTrend,
                callOI: safeOcData.totalCallOI,
                putOI: safeOcData.totalPutOI,
                atmStrike: safeOcData.atmStrike,
                maxPainStrike: safeOcData.maxPainStrike,
                maxCallOIStrike: safeOcData.maxCallOIStrike || 0,
                maxPutOIStrike: safeOcData.maxPutOIStrike || 0,
                callWalls: safeOcData.callWalls,
                putWalls: safeOcData.putWalls,
                highPCRStrikes: safeOcData.highPCRStrikes || [],
                lowPCRStrikes: safeOcData.lowPCRStrikes || [],
                totalCallVolume: safeOcData.totalCallVolume || 0,
                totalPutVolume: safeOcData.totalPutVolume || 0,
                strikeCount: safeOcData.strikeCount || 0,
                ltp: safeOcData.ltp
                });
            } catch (broadcastError) {
                console.error('❌ Error broadcasting options update:', broadcastError);
            }
            
            // Track successful poll
            lastSuccessfulOptionsPoll = Date.now();
        } else if (lastOptionsData && lastOptionsData.symbol === currentSymbol) {
            // 🔧 FIX: If options chain not found but we have cached data, keep displaying it
            // Only update if data is fresh (less than 5 minutes old)
            const dataAge = Date.now() - (lastOptionsData.timestamp || 0);
            if (dataAge < 5 * 60 * 1000) { // 5 minutes freshness
                // Only update UI if we haven't updated recently (prevent flashing)
                // Check if last update was more than 2 seconds ago to avoid rapid updates
                const lastUpdateTime = lastOptionsData.lastUIUpdate || 0;
                if (Date.now() - lastUpdateTime > 2000) {
                    lastOptionsData.lastUIUpdate = Date.now();
                    try {
                        updateOptionsUI(lastOptionsData);
                    } catch (uiError) {
                        console.error('❌ Error updating cached options UI:', uiError);
                    }
                }
            }
        }
        
        // 🔧 FIX: Only warn if we're actually on options page but getting no data
        // If not on options page, it's normal to not get data
        const isOnOptionsPage = isOptionsChain();
        if (isOnOptionsPage && Date.now() - lastSuccessfulOptionsPoll > 60000 && !lastOptionsData) {
            console.warn('⚠️ Options polling: On options page but no data for 60s');
        }
        // If we have cached data, don't warn - it's working as intended
        
        // 🔧 FIX: Don't clear UI if no data - let cached data stay visible
        // This prevents flashing when switching tabs
        } catch (pollError) {
            console.error('❌ Error in options chain polling:', pollError);
            consecutiveErrors++;
            
            // If too many errors, restart polling
            if (consecutiveErrors > 5) {
                console.error('❌ Too many polling errors, restarting...');
                clearInterval(optionsChainPollInterval);
                optionsChainPollInterval = null;
                setTimeout(() => {
                    console.log('🔄 Restarting options chain polling...');
                    startOptionsChainPolling();
                }, 5000);
            }
        }
    }, 3000); // Poll every 3 seconds
    
    console.log('✅ Options chain polling started');
}

// Start polling when script loads
startOptionsChainPolling();

// 🔧 FIX: Monitor polling health and restart if needed
let pollingHealthCheck = setInterval(() => {
    if (!optionsChainPollInterval) {
        console.warn('⚠️ Options polling interval is null, restarting...');
        startOptionsChainPolling();
    } else {
        // Check if polling is still active (interval should exist)
        // Only restart if we're on options page but getting no data
        const isOnOptionsPage = isOptionsChain();
        if (isOnOptionsPage && Date.now() - lastSuccessfulOptionsPoll > 120000 && !lastOptionsData) {
            console.warn('⚠️ Options polling appears stuck (on options page but no data in 2 min), restarting...');
            if (optionsChainPollInterval) {
                clearInterval(optionsChainPollInterval);
                optionsChainPollInterval = null;
            }
            startOptionsChainPolling();
        }
    }
}, 30000); // Check every 30 seconds

// ─────────────────────────────────────────────────────────────────────────
// 📡 CENTRAL BRAIN COMMAND LISTENER
// ─────────────────────────────────────────────────────────────────────────
// 🔧 FIX: Central Brain should NOT control Smart Mode (recording)
// Smart Mode is independent and runs based on market hours
// Central Brain controls trading execution and visual indicators
let centralBrainActive = false; // Track if this tab is the active trading tab
let lastSignalsForExecution = []; // Store last signals for execution

if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'EXECUTE_TRADE') {
            console.log('🚀 CENTRAL BRAIN: EXECUTE COMMAND RECEIVED');
            centralBrainActive = true;
            showToast('🚀 BRAIN: GO FOR LAUNCH - TRADING SIGNAL ACTIVE', '#00ff88', '⚡');
            
            // 🔧 FIX: Don't touch Smart Mode checkbox - it's independent
            // Show visual indicator
            const signalBox = document.getElementById('signalBox');
            if (signalBox) {
                const existingIndicator = signalBox.querySelector('.brain-execute-indicator');
                if (!existingIndicator) {
                    const indicator = document.createElement('div');
                    indicator.className = 'brain-execute-indicator';
                    indicator.style.cssText = `
                        background: linear-gradient(135deg, #00ff88 0%, #00d4ff 100%);
                        color: #000;
                        padding: 8px 12px;
                        border-radius: 6px;
                        margin-bottom: 8px;
                        font-weight: bold;
                        text-align: center;
                        font-size: 12px;
                        box-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
                    `;
                    indicator.innerHTML = '🚀 CENTRAL BRAIN: BEST OPPORTUNITY - EXECUTE TRADES';
                    signalBox.insertBefore(indicator, signalBox.firstChild);
                }
            }
            
            // 🔧 NEW: Execute paper trades if we have signals
            if (lastSignalsForExecution.length > 0) {
                executeCentralBrainTrades(lastSignalsForExecution);
            }
        } else if (message.type === 'STANDBY') {
            console.log('⏸️ CENTRAL BRAIN: STANDBY COMMAND RECEIVED');
            centralBrainActive = false;
            showToast('⏸️ BRAIN: STANDBY (Better Opportunity Elsewhere)', '#ffab00', '✋');
            
            // 🔧 FIX: Don't touch Smart Mode checkbox - it's independent
            // Remove the execute indicator if it exists
            const signalBox = document.getElementById('signalBox');
            if (signalBox) {
                const indicator = signalBox.querySelector('.brain-execute-indicator');
                if (indicator) {
                    indicator.remove();
                }
            }
        }
    });
}

// 🔧 NEW: Execute trades when Central Brain says GO
async function executeCentralBrainTrades(signals) {
    if (!signals || signals.length === 0) return;
    
    // Import paper trader dynamically to avoid circular dependencies
    const { executePaperTrade } = await import('../core/paperTrader.js');
    const currentSymbol = state.symbol || '';
    const currentPrice = state.ltp || 0;
    const now = new Date().toISOString();
    
    for (const signal of signals) {
        try {
            // Only execute tradable signals (LONG/SHORT)
            if (signal.type === 'BUY' || signal.type === 'LONG') {
                console.log(`📈 CENTRAL BRAIN: Executing BUY for ${currentSymbol} @ ${signal.price || currentPrice}`);
                await executePaperTrade('BUY', currentSymbol, signal.price || currentPrice, 
                    `Central Brain: ${signal.type}`, now);
            } else if (signal.type === 'SELL' || signal.type === 'SHORT') {
                console.log(`📉 CENTRAL BRAIN: Executing SHORT for ${currentSymbol} @ ${signal.price || currentPrice}`);
                await executePaperTrade('SHORT', currentSymbol, signal.price || currentPrice, 
                    `Central Brain: ${signal.type}`, now);
            }
        } catch (err) {
            console.error('❌ Error executing Central Brain trade:', err);
        }
    }
}
