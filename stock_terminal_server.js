#!/usr/bin/env node

/**
 * 🌐 UNIVERSAL STOCK TERMINAL SERVER
 * 
 * Monitors all stocks in real-time for profitable conditions
 * Uses Dhan API for live market data
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { createCompactSnapshot, saveSnapshot, runAfterMarketAnalysis, ANALYSIS_CONFIG } = require('./after_market_analysis');

// Dhan API Configuration
const DHAN_CONFIG = {
    CLIENT_ID: "1109130648",
    ACCESS_TOKEN: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzY0NjgxMDMzLCJpYXQiOjE3NjQ1OTQ2MzMsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTA5MTMwNjQ4In0.3pqvOZostFmXJLNm5RnaIvfaNGK4D_9yypPs9plEBGF87sdWOwAgQV7-zlxRriE6kEZVlZA0ctOOYBQW7gQKcA",
    // WebSocket endpoints
    LIVE_FEED_WS: "wss://api-feed.dhan.co",
    DEPTH_20_WS: "wss://depth-api-feed.dhan.co/twentydepth",
    DEPTH_200_WS: "wss://full-depth-api.dhan.co/twohundreddepth"
};

// Exchange segments (Dhan API format)
const EXCHANGE_SEGMENT = {
    NSE_EQ: "NSE_EQ",
    NSE_INDICES: "NSE_INDICES",
    NSE_FNO: "NSE_FNO",
    BSE_EQ: "BSE_EQ",
    BSE_FNO: "BSE_FNO",
    MCX: "MCX"
};

// Feed response codes
const FEED_RESPONSE_CODE = {
    TICKER: 1,
    QUOTE: 2,
    FULL_PACKET: 3,
    BID_DEPTH: 41,
    ASK_DEPTH: 51,
    DISCONNECT: 50
};

// Trading Strategy Configuration (from strategy.js + profitability analysis)
const STRATEGY_CONFIG = {
    TAKE_PROFIT_PCT: 1.0,  // 1% take profit
    STOP_LOSS_PCT: 0.7,     // 0.7% stop loss
    BROKERAGE_PCT: 0.06,    // 0.06% round trip
    SLIPPAGE_PCT: 0.05,     // 0.05% slippage
    MIN_PROFIT_AFTER_COSTS: 0.4,  // 0.4% minimum net profit
    MIN_RISK_REWARD: 1.5,   // 1.5:1 minimum risk:reward
    ACTIVE_STRATEGIES: {
        WHALE: true,
        BEAST: true,
        TRAP: true,
        RETAIL: true
    }
};

// PROVEN PROFITABLE CONDITIONS (from backtesting analysis)
// Win Rate: 49% | Profit Factor: 1.25 | Based on 308 trades
const PROVEN_CONDITIONS = {
    SHORT: {
        obi: { min: -99, max: -20 },        // OBI < -20% (proven)
        sellPressure: { min: 72, max: 100 }, // Sell Pressure > 72% (proven)
        momentumConf: { min: 88, max: 100 }, // Momentum > 88% (proven)
        spread: { min: 0, max: 0.01 },      // Spread < 0.01% (proven)
        rsi: { min: 50, max: 100 },         // RSI > 50 (proven)
        priceVsVwap: { min: 0, max: 5 },    // Price >= VWAP (proven)
        qualityScore: { min: 65, max: 100 } // Quality > 65% (proven)
    },
    LONG: {
        obi: { min: 20, max: 100 },         // OBI > 20% (proven)
        buyPressure: { min: 65, max: 100 },  // Buy Pressure > 65% (proven)
        momentumConf: { min: 85, max: 100 }, // Momentum > 85% (proven)
        spread: { min: 0, max: 0.01 },      // Spread < 0.01% (proven)
        rsi: { min: 0, max: 50 },           // RSI < 50 (proven)
        priceVsVwap: { min: -5, max: 0 },   // Price < VWAP (proven)
        qualityScore: { min: 65, max: 100 }  // Quality > 65% (proven)
    }
};

// Profitable Conditions (Legacy - will be replaced by strategy evaluation)
const PROFITABLE_CONDITIONS = {
    SHORT: {
        obi: { min: -99, max: -20 },
        sellPressure: { min: 72, max: 100 },
        momentumConf: { min: 88, max: 100 },
        spread: { min: 0, max: 0.01 },
        rsi: { min: 50, max: 100 },
        priceVsVwap: { min: 0, max: 5 },
        qualityScore: { min: 65, max: 100 }
    },
    LONG: {
        obi: { min: 20, max: 100 },
        buyPressure: { min: 65, max: 100 },
        momentumConf: { min: 85, max: 100 },
        spread: { min: 0, max: 0.01 },
        rsi: { min: 0, max: 50 },
        priceVsVwap: { min: -5, max: 0 },
        qualityScore: { min: 65, max: 100 }
    }
};

// Stock universe - will be populated from Dhan API
let STOCK_UNIVERSE = [];
const MAX_INSTRUMENTS_PER_CONNECTION = 5000;
const MAX_CONNECTIONS = 5;
const TOTAL_CAPACITY = MAX_INSTRUMENTS_PER_CONNECTION * MAX_CONNECTIONS; // 25,000 instruments

// State management
const stockData = new Map();
const priceHistory = new Map();
const historicalData = new Map(); // Store yesterday's OHLCV data
const opportunities = [];
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Market hours check (IST timezone)
function isMarketOpen() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hour = istTime.getHours();
    const minute = istTime.getMinutes();
    const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
    
    // Market is closed on weekends
    if (day === 0 || day === 6) return false;
    
    // Market hours: 9:15 AM to 3:30 PM IST
    const marketOpen = hour > 9 || (hour === 9 && minute >= 15);
    const marketClose = hour < 15 || (hour === 15 && minute <= 30);
    
    return marketOpen && marketClose;
}

// Check if market just closed (for after-market analysis)
let lastMarketStatus = false;
function checkMarketClose() {
    const currentlyOpen = isMarketOpen();
    const justClosed = lastMarketStatus && !currentlyOpen;
    lastMarketStatus = currentlyOpen;
    return justClosed;
}

// Broadcast helper function
function broadcastUpdate(type, data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify({ type, data }));
            } catch (error) {
                // Client disconnected, ignore
            }
        }
    });
}

// Dhan WebSocket connections (up to 5 connections)
const liveFeedConnections = [];
const depth20Connections = [];

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());

// Calculate RSI
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }
    
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

// Calculate VWAP (simplified - using recent prices)
function calculateVWAP(prices, volumes) {
    if (prices.length === 0) return 0;
    if (!volumes || volumes.length === 0) {
        // Use equal weights if no volume data
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    }
    
    let totalPV = 0, totalV = 0;
    for (let i = 0; i < prices.length; i++) {
        totalPV += prices[i] * (volumes[i] || 1);
        totalV += volumes[i] || 1;
    }
    return totalV > 0 ? totalPV / totalV : prices[prices.length - 1];
}

// Calculate Order Book Imbalance
function calculateOBI(bids, asks) {
    if (!bids || !asks || bids.length === 0 || asks.length === 0) return 0;
    
    const top5Bids = bids.slice(0, 5);
    const top5Asks = asks.slice(0, 5);
    
    const totalBidQty = top5Bids.reduce((sum, b) => sum + (b.quantity || 0), 0);
    const totalAskQty = top5Asks.reduce((sum, a) => sum + (a.quantity || 0), 0);
    const total = totalBidQty + totalAskQty;
    
    return total > 0 ? ((totalBidQty - totalAskQty) / total) * 100 : 0;
}

// Calculate tape pressure (simplified from recent trades)
function calculateTapePressure(recentTrades) {
    if (!recentTrades || recentTrades.length === 0) return { buyPressure: 0.5, sellPressure: 0.5 };
    
    let buyVol = 0, sellVol = 0;
    // Simplified: assume trades at ask = buy, trades at bid = sell
    recentTrades.forEach(trade => {
        if (trade.side === 'BUY' || trade.type === 'BUY') buyVol += trade.quantity || 1;
        else sellVol += trade.quantity || 1;
    });
    
    const total = buyVol + sellVol;
    if (total === 0) return { buyPressure: 0.5, sellPressure: 0.5 };
    
    return {
        buyPressure: buyVol / total,
        sellPressure: sellVol / total
    };
}

// Calculate quality score
function calculateQualityScore(signalType, obi, tape, price, vwap, momentum, rsi) {
    let quality = 0;
    
    // OBI Strength (40 points)
    if (signalType === 'LONG') {
        if (obi > 30) quality += 40;
        else if (obi > 25) quality += 35;
        else if (obi > 20) quality += 30;
        else if (obi > 15) quality += 20;
    } else {
        if (obi < -30) quality += 40;
        else if (obi < -25) quality += 35;
        else if (obi < -20) quality += 30;
        else if (obi < -15) quality += 20;
    }
    
    // Tape (20 points)
    if (signalType === 'LONG' && tape.buyPressure > 0.7) quality += 20;
    else if (signalType === 'LONG' && tape.buyPressure > 0.6) quality += 15;
    else if (signalType === 'SHORT' && tape.sellPressure > 0.7) quality += 20;
    else if (signalType === 'SHORT' && tape.sellPressure > 0.6) quality += 15;
    
    // Price vs VWAP (20 points)
    const priceVsVwap = ((price - vwap) / vwap) * 100;
    if (signalType === 'LONG' && priceVsVwap < -0.5) quality += 20;
    else if (signalType === 'LONG' && priceVsVwap < -0.3) quality += 15;
    else if (signalType === 'SHORT' && priceVsVwap > 0.5) quality += 20;
    else if (signalType === 'SHORT' && priceVsVwap > 0.3) quality += 15;
    
    // Momentum (20 points)
    if (signalType === 'LONG' && momentum.direction === 'BULLISH' && momentum.confidence > 60) quality += 20;
    else if (signalType === 'LONG' && momentum.direction === 'BULLISH' && momentum.confidence > 50) quality += 15;
    else if (signalType === 'SHORT' && momentum.direction === 'BEARISH' && momentum.confidence > 60) quality += 20;
    else if (signalType === 'SHORT' && momentum.direction === 'BEARISH' && momentum.confidence > 50) quality += 15;
    
    // RSI Bonus (10 points)
    if (signalType === 'LONG' && rsi < 50 && rsi > 30) quality += 10;
    else if (signalType === 'SHORT' && rsi > 50 && rsi < 70) quality += 10;
    
    return Math.min(100, quality);
}

// Advanced Strategy Evaluation (adapted from strategy.js)
function evaluateAdvancedStrategy(symbol, marketData, historicalData) {
    const { ltp, bids, asks, recentTrades, volume, changePercent } = marketData;
    
    if (!ltp || !bids || !asks || bids.length === 0 || asks.length === 0) return null;
    
    const bestBid = bids[0]?.price || ltp;
    const bestAsk = asks[0]?.price || ltp;
    const spread = ((bestAsk - bestBid) / ltp) * 100;
    
    // Get price history
    if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
    const prices = priceHistory.get(symbol);
    prices.push(ltp);
    if (prices.length > 50) prices.shift();
    
    // Calculate indicators
    const obi = calculateOBI(bids, asks);
    const tape = calculateTapePressure(recentTrades);
    const rsi = calculateRSI(prices);
    const vwap = calculateVWAP(prices, prices.map(() => volume || 1));
    const priceVsVwap = ((ltp - vwap) / vwap) * 100;
    
    // Enhanced momentum prediction
    const momentum = {
        direction: obi > 15 ? 'BULLISH' : obi < -15 ? 'BEARISH' : 'NEUTRAL',
        confidence: Math.min(100, Math.abs(obi) * 2)
    };
    
    // Calculate velocity (simplified)
    const velocity = recentTrades && recentTrades.length > 0 ? recentTrades.length / 10 : 0;
    const isHighVelocity = velocity > 0.5;
    
    // Smart order execution calculator
    function calculateSmartOrder(signalType, bestBid, bestAsk, obi, spread) {
        const BROKERAGE_PCT = STRATEGY_CONFIG.BROKERAGE_PCT;
        const SLIPPAGE_PCT = STRATEGY_CONFIG.SLIPPAGE_PCT;
        const MIN_PROFIT = STRATEGY_CONFIG.MIN_PROFIT_AFTER_COSTS;
        
        let entryPrice, entryType, fillProbability;
        
        if (signalType === 'LONG') {
            if (obi > 20) {
                entryPrice = bestBid + (spread * 0.3);
                entryType = 'AGGRESSIVE';
                fillProbability = 0.95;
            } else if (obi > 10) {
                entryPrice = bestBid + (spread * 0.15);
                entryType = 'MODERATE';
                fillProbability = 0.75;
            } else {
                entryPrice = bestBid;
                entryType = 'LIMIT';
                fillProbability = 0.4;
            }
            
            const targetPrice = entryPrice * (1 + STRATEGY_CONFIG.TAKE_PROFIT_PCT / 100);
            const exitPrice = targetPrice * (1 - SLIPPAGE_PCT / 100);
            const stopLossPrice = entryPrice * (1 - STRATEGY_CONFIG.STOP_LOSS_PCT / 100);
            const stopLossExitPrice = stopLossPrice * (1 - SLIPPAGE_PCT / 100);
            
            const entryCost = entryPrice * (BROKERAGE_PCT / 2 / 100);
            const exitCost = exitPrice * (BROKERAGE_PCT / 2 / 100);
            const stopLossCost = stopLossExitPrice * (BROKERAGE_PCT / 2 / 100);
            
            const grossProfit = exitPrice - entryPrice;
            const netProfit = grossProfit - entryCost - exitCost;
            const netProfitPct = (netProfit / entryPrice) * 100;
            
            const stopLossNet = (stopLossExitPrice - entryPrice) - entryCost - stopLossCost;
            const stopLossPct = (stopLossNet / entryPrice) * 100;
            const riskReward = Math.abs(netProfitPct / stopLossPct);
            
            return {
                entryPrice: parseFloat(entryPrice.toFixed(2)),
                entryType,
                exitPrice: parseFloat(exitPrice.toFixed(2)),
                stopLossPrice: parseFloat(stopLossPrice.toFixed(2)),
                netProfitPct: parseFloat(netProfitPct.toFixed(2)),
                stopLossPct: parseFloat(stopLossPct.toFixed(2)),
                riskReward: parseFloat(riskReward.toFixed(2)),
                fillProbability: parseFloat((fillProbability * 100).toFixed(0)),
                isProfitable: netProfitPct > MIN_PROFIT,
                hasGoodRR: riskReward >= STRATEGY_CONFIG.MIN_RISK_REWARD,
                willFill: fillProbability > 0.4,
                shouldSignal: netProfitPct > MIN_PROFIT && riskReward >= STRATEGY_CONFIG.MIN_RISK_REWARD && fillProbability > 0.4
            };
        } else { // SHORT
            if (obi < -20) {
                entryPrice = bestAsk - (spread * 0.3);
                entryType = 'AGGRESSIVE';
                fillProbability = 0.95;
            } else if (obi < -10) {
                entryPrice = bestAsk - (spread * 0.15);
                entryType = 'MODERATE';
                fillProbability = 0.75;
            } else {
                entryPrice = bestAsk;
                entryType = 'LIMIT';
                fillProbability = 0.4;
            }
            
            const targetPrice = entryPrice * (1 - STRATEGY_CONFIG.TAKE_PROFIT_PCT / 100);
            const exitPrice = targetPrice * (1 + SLIPPAGE_PCT / 100);
            const stopLossPrice = entryPrice * (1 + STRATEGY_CONFIG.STOP_LOSS_PCT / 100);
            const stopLossExitPrice = stopLossPrice * (1 + SLIPPAGE_PCT / 100);
            
            const entryCost = entryPrice * (BROKERAGE_PCT / 2 / 100);
            const exitCost = exitPrice * (BROKERAGE_PCT / 2 / 100);
            const stopLossCost = stopLossExitPrice * (BROKERAGE_PCT / 2 / 100);
            
            const grossProfit = entryPrice - exitPrice;
            const netProfit = grossProfit - entryCost - exitCost;
            const netProfitPct = (netProfit / entryPrice) * 100;
            
            const stopLossNet = (entryPrice - stopLossExitPrice) - entryCost - stopLossCost;
            const stopLossPct = (stopLossNet / entryPrice) * 100;
            const riskReward = Math.abs(netProfitPct / stopLossPct);
            
            return {
                entryPrice: parseFloat(entryPrice.toFixed(2)),
                entryType,
                exitPrice: parseFloat(exitPrice.toFixed(2)),
                stopLossPrice: parseFloat(stopLossPrice.toFixed(2)),
                netProfitPct: parseFloat(netProfitPct.toFixed(2)),
                stopLossPct: parseFloat(stopLossPct.toFixed(2)),
                riskReward: parseFloat(riskReward.toFixed(2)),
                fillProbability: parseFloat((fillProbability * 100).toFixed(0)),
                isProfitable: netProfitPct > MIN_PROFIT,
                hasGoodRR: riskReward >= STRATEGY_CONFIG.MIN_RISK_REWARD,
                willFill: fillProbability > 0.4,
                shouldSignal: netProfitPct > MIN_PROFIT && riskReward >= STRATEGY_CONFIG.MIN_RISK_REWARD && fillProbability > 0.4
            };
        }
    }
    
    const opportunities = [];
    
    // ─────────────────────────────────────────────────────────────────────────
    // BEAST STRATEGY (Momentum + Zones) - Using PROVEN profitable conditions
    // ─────────────────────────────────────────────────────────────────────────
    if (STRATEGY_CONFIG.ACTIVE_STRATEGIES.BEAST) {
        const hasVelocity = isHighVelocity || velocity > 0.3;
        const isTrendAligned = ltp > vwap;
        const isMomentumBullish = momentum.direction === 'BULLISH' && momentum.confidence > 50;
        const hasStrongMomentum = isMomentumBullish;
        const trendOK = isTrendAligned || hasStrongMomentum;
        
        // BEAST LONG - Using PROVEN profitable conditions (STRICT MODE)
        const provenLong = PROVEN_CONDITIONS.LONG;
        const obiOKLong = obi > provenLong.obi.min; // OBI > 20% (proven)
        const zoneOKLong = obi > 15 || priceVsVwap < -0.3;
        const tapeOKLong = tape.buyPressure * 100 > provenLong.buyPressure.min; // Buy Pressure > 65% (proven)
        const momentumOKLong = momentum.confidence > provenLong.momentumConf.min; // Momentum > 85% (proven)
        const spreadOKLong = spread < provenLong.spread.max; // Spread < 0.01% (proven)
        const rsiOKLong = rsi < provenLong.rsi.max; // RSI < 50 (proven)
        const vwapOKLong = priceVsVwap < provenLong.priceVsVwap.max; // Price < VWAP (proven)
        
        // ALL proven conditions must be met for BEAST signal (strict)
        if (hasVelocity && trendOK && obiOKLong && zoneOKLong && tapeOKLong && momentumOKLong && spreadOKLong && rsiOKLong && vwapOKLong) {
            const smartOrder = calculateSmartOrder('LONG', bestBid, bestAsk, obi, spread);
            if (smartOrder.shouldSignal) {
                const quality = calculateQualityScore('LONG', obi, tape, ltp, vwap, momentum, rsi);
                opportunities.push({
                    type: 'LONG',
                    strategy: 'BEAST',
                    symbol,
                    entryPrice: smartOrder.entryPrice,
                    exitPrice: smartOrder.exitPrice,
                    stopLoss: smartOrder.stopLossPrice,
                    quality,
                    netProfitPct: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProbability: smartOrder.fillProbability,
                    entryType: smartOrder.entryType,
                    conditions: {
                        obi: obi.toFixed(2),
                        buyPressure: (tape.buyPressure * 100).toFixed(1),
                        momentumConf: momentum.confidence.toFixed(1),
                        rsi: rsi.toFixed(1),
                        priceVsVwap: priceVsVwap.toFixed(2),
                        velocity: velocity.toFixed(2)
                    },
                    changePercent: changePercent || 0,
                    timestamp: Date.now()
                });
            }
        }
        
        // BEAST SHORT - Using PROVEN profitable conditions (STRICT MODE)
        const provenShort = PROVEN_CONDITIONS.SHORT;
        const isTrendBearish = ltp < vwap;
        const isMomentumBearish = momentum.direction === 'BEARISH' && momentum.confidence > 50;
        const trendOKShort = isTrendBearish || isMomentumBearish || obi < -15;
        const obiOKShort = obi < provenShort.obi.max; // OBI < -20% (proven)
        const zoneOKShort = obi < -15 || priceVsVwap > 0.3;
        const tapeOKShort = tape.sellPressure * 100 > provenShort.sellPressure.min; // Sell Pressure > 72% (proven)
        const momentumOKShort = momentum.confidence > provenShort.momentumConf.min; // Momentum > 88% (proven)
        const spreadOKShort = spread < provenShort.spread.max; // Spread < 0.01% (proven)
        const rsiOKShort = rsi > provenShort.rsi.min; // RSI > 50 (proven)
        const vwapOKShort = priceVsVwap >= provenShort.priceVsVwap.min; // Price >= VWAP (proven)
        
        // ALL proven conditions must be met for BEAST signal (strict)
        if (hasVelocity && trendOKShort && obiOKShort && zoneOKShort && tapeOKShort && momentumOKShort && spreadOKShort && rsiOKShort && vwapOKShort) {
            const smartOrder = calculateSmartOrder('SHORT', bestBid, bestAsk, obi, spread);
            if (smartOrder.shouldSignal) {
                const quality = calculateQualityScore('SHORT', obi, tape, ltp, vwap, momentum, rsi);
                opportunities.push({
                    type: 'SHORT',
                    strategy: 'BEAST',
                    symbol,
                    entryPrice: smartOrder.entryPrice,
                    exitPrice: smartOrder.exitPrice,
                    stopLoss: smartOrder.stopLossPrice,
                    quality,
                    netProfitPct: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProbability: smartOrder.fillProbability,
                    entryType: smartOrder.entryType,
                    conditions: {
                        obi: obi.toFixed(2),
                        sellPressure: (tape.sellPressure * 100).toFixed(1),
                        momentumConf: momentum.confidence.toFixed(1),
                        rsi: rsi.toFixed(1),
                        priceVsVwap: priceVsVwap.toFixed(2),
                        velocity: velocity.toFixed(2)
                    },
                    changePercent: changePercent || 0,
                    timestamp: Date.now()
                });
            }
        }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // TRAP STRATEGY (Mean Reversion)
    // ─────────────────────────────────────────────────────────────────────────
    if (STRATEGY_CONFIG.ACTIVE_STRATEGIES.TRAP) {
        // TRAP BUY (Squeeze Shorts)
        if (rsi > 70 && obi > 15 && ltp > vwap && tape.buyPressure > 0.6) {
            const smartOrder = calculateSmartOrder('LONG', bestBid, bestAsk, obi, spread);
            if (smartOrder.shouldSignal) {
                const quality = calculateQualityScore('LONG', obi, tape, ltp, vwap, momentum, rsi);
                opportunities.push({
                    type: 'LONG',
                    strategy: 'TRAP',
                    symbol,
                    entryPrice: smartOrder.entryPrice,
                    exitPrice: smartOrder.exitPrice,
                    stopLoss: smartOrder.stopLossPrice,
                    quality,
                    netProfitPct: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProbability: smartOrder.fillProbability,
                    entryType: smartOrder.entryType,
                    conditions: {
                        obi: obi.toFixed(2),
                        rsi: rsi.toFixed(1),
                        buyPressure: (tape.buyPressure * 100).toFixed(1)
                    },
                    changePercent: changePercent || 0,
                    timestamp: Date.now()
                });
            }
        }
        
        // TRAP SHORT (Crush Longs)
        if (rsi < 35 && obi < -15 && ltp < vwap && tape.sellPressure > 0.6) {
            const smartOrder = calculateSmartOrder('SHORT', bestBid, bestAsk, obi, spread);
            if (smartOrder.shouldSignal) {
                const quality = calculateQualityScore('SHORT', obi, tape, ltp, vwap, momentum, rsi);
                opportunities.push({
                    type: 'SHORT',
                    strategy: 'TRAP',
                    symbol,
                    entryPrice: smartOrder.entryPrice,
                    exitPrice: smartOrder.exitPrice,
                    stopLoss: smartOrder.stopLossPrice,
                    quality,
                    netProfitPct: smartOrder.netProfitPct,
                    riskReward: smartOrder.riskReward,
                    fillProbability: smartOrder.fillProbability,
                    entryType: smartOrder.entryType,
                    conditions: {
                        obi: obi.toFixed(2),
                        rsi: rsi.toFixed(1),
                        sellPressure: (tape.sellPressure * 100).toFixed(1)
                    },
                    changePercent: changePercent || 0,
                    timestamp: Date.now()
                });
            }
        }
    }
    
    // ─────────────────────────────────────────────────────────────────────────
    // PREMIUM FALLBACK (PROVEN Profitable Conditions - Strict Mode)
    // ─────────────────────────────────────────────────────────────────────────
    // Only use if no other strategies fired - ensures we only trade proven setups
    if (opportunities.length === 0) {
        const provenLong = PROVEN_CONDITIONS.LONG;
        const provenShort = PROVEN_CONDITIONS.SHORT;
        
        // STRICT LONG - All proven conditions must be met
        if (obi > provenLong.obi.min &&
            tape.buyPressure * 100 > provenLong.buyPressure.min &&
            momentum.confidence > provenLong.momentumConf.min &&
            spread < provenLong.spread.max &&
            rsi < provenLong.rsi.max &&
            priceVsVwap < provenLong.priceVsVwap.max &&
            !isHighVelocity) {
            
            const quality = calculateQualityScore('LONG', obi, tape, ltp, vwap, momentum, rsi);
            if (quality > provenLong.qualityScore.min) {
                const smartOrder = calculateSmartOrder('LONG', bestBid, bestAsk, obi, spread);
                if (smartOrder.shouldSignal) {
                    opportunities.push({
                        type: 'LONG',
                        strategy: 'PREMIUM',
                        symbol,
                        entryPrice: smartOrder.entryPrice,
                        exitPrice: smartOrder.exitPrice,
                        stopLoss: smartOrder.stopLossPrice,
                        quality,
                        netProfitPct: smartOrder.netProfitPct,
                        riskReward: smartOrder.riskReward,
                        fillProbability: smartOrder.fillProbability,
                        entryType: smartOrder.entryType,
                        conditions: {
                            obi: obi.toFixed(2),
                            buyPressure: (tape.buyPressure * 100).toFixed(1),
                            momentumConf: momentum.confidence.toFixed(1),
                            rsi: rsi.toFixed(1),
                            spread: spread.toFixed(3),
                            priceVsVwap: priceVsVwap.toFixed(2)
                        },
                        changePercent: changePercent || 0,
                        timestamp: Date.now()
                    });
                }
            }
        }
        
        // STRICT SHORT - All proven conditions must be met
        if (obi < provenShort.obi.max &&
            tape.sellPressure * 100 > provenShort.sellPressure.min &&
            momentum.confidence > provenShort.momentumConf.min &&
            spread < provenShort.spread.max &&
            rsi > provenShort.rsi.min &&
            priceVsVwap >= provenShort.priceVsVwap.min &&
            !isHighVelocity) {
            
            const quality = calculateQualityScore('SHORT', obi, tape, ltp, vwap, momentum, rsi);
            if (quality > provenShort.qualityScore.min) {
                const smartOrder = calculateSmartOrder('SHORT', bestBid, bestAsk, obi, spread);
                if (smartOrder.shouldSignal) {
                    opportunities.push({
                        type: 'SHORT',
                        strategy: 'PREMIUM',
                        symbol,
                        entryPrice: smartOrder.entryPrice,
                        exitPrice: smartOrder.exitPrice,
                        stopLoss: smartOrder.stopLossPrice,
                        quality,
                        netProfitPct: smartOrder.netProfitPct,
                        riskReward: smartOrder.riskReward,
                        fillProbability: smartOrder.fillProbability,
                        entryType: smartOrder.entryType,
                        conditions: {
                            obi: obi.toFixed(2),
                            sellPressure: (tape.sellPressure * 100).toFixed(1),
                            momentumConf: momentum.confidence.toFixed(1),
                            rsi: rsi.toFixed(1),
                            spread: spread.toFixed(3),
                            priceVsVwap: priceVsVwap.toFixed(2)
                        },
                        changePercent: changePercent || 0,
                        timestamp: Date.now()
                    });
                }
            }
        }
    }
    
    return opportunities.length > 0 ? opportunities : null;
}

// Check profitable conditions (legacy wrapper - now uses advanced strategy)
function checkProfitableConditions(symbol, marketData) {
    const historical = historicalData.get(symbol);
    return evaluateAdvancedStrategy(symbol, marketData, historical);
}

// Parse binary market data (Live Market Feed)
function parseMarketDataPacket(buffer) {
    if (!buffer || buffer.length < 8) {
        return null;
    }
    
    // Convert Buffer to ArrayBuffer for DataView
    let arrayBuffer;
    if (Buffer.isBuffer(buffer)) {
        // Node.js Buffer - create new ArrayBuffer from buffer data
        const uint8Array = new Uint8Array(buffer);
        arrayBuffer = uint8Array.buffer;
    } else if (buffer instanceof ArrayBuffer) {
        arrayBuffer = buffer;
    } else if (buffer.buffer instanceof ArrayBuffer) {
        // TypedArray (Uint8Array, etc.)
        arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
        return null;
    }
    
    const view = new DataView(arrayBuffer);
    let offset = 0;
    
    // Response Header (8 bytes)
    // According to Dhan docs: Bytes 1 = Response Code, Bytes 2-3 = Message Length, Byte 4 = Exchange Segment, Bytes 5-8 = SecurityId
    const responseCode = view.getUint8(offset); offset += 1;
    const messageLength = view.getInt16(offset, true); offset += 2;
    const exchangeSegment = view.getUint8(offset); offset += 1;
    const securityId = view.getInt32(offset, true); offset += 4;
    
    if (responseCode === FEED_RESPONSE_CODE.FULL_PACKET) {
        // Full Packet (162 bytes)
        const ltp = view.getFloat32(offset, true); offset += 4;
        const lastTradedQty = view.getInt32(offset, true); offset += 4;
        const volume = view.getInt32(offset, true); offset += 4;
        const bidQty = view.getInt32(offset, true); offset += 4;
        const askQty = view.getInt32(offset, true); offset += 4;
        const change = view.getFloat32(offset, true); offset += 4;
        const changePercent = view.getFloat32(offset, true); offset += 4;
        const open = view.getFloat32(offset, true); offset += 4;
        const high = view.getFloat32(offset, true); offset += 4;
        const low = view.getFloat32(offset, true); offset += 4;
        const close = view.getFloat32(offset, true); offset += 4;
        
        // Market Depth (5 levels, 20 bytes each = 100 bytes)
        const bids = [];
        const asks = [];
        
        for (let i = 0; i < 5; i++) {
            const bidQty = view.getInt32(offset, true); offset += 4;
            const askQty = view.getInt32(offset, true); offset += 4;
            const bidOrders = view.getInt16(offset, true); offset += 2;
            const askOrders = view.getInt16(offset, true); offset += 2;
            const bidPrice = view.getFloat32(offset, true); offset += 4;
            const askPrice = view.getFloat32(offset, true); offset += 4;
            
            if (bidPrice > 0) {
                bids.push({ price: bidPrice, quantity: bidQty, orders: bidOrders });
            }
            if (askPrice > 0) {
                asks.push({ price: askPrice, quantity: askQty, orders: askOrders });
            }
        }
        
        return {
            securityId: securityId.toString(),
            exchangeSegment,
            ltp,
            volume,
            bids,
            asks,
            open,
            high,
            low,
            close,
            change,
            changePercent,
            timestamp: Date.now()
        };
    }
    
    return null;
}

// Parse 20-level depth packet
function parseDepth20Packet(buffer) {
    if (!buffer || buffer.length < 12) return null;
    
    // Convert Buffer to ArrayBuffer for DataView
    let arrayBuffer;
    try {
        if (Buffer.isBuffer(buffer)) {
            // Create a new ArrayBuffer from Buffer
            arrayBuffer = buffer.buffer ? 
                buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) :
                new Uint8Array(buffer).buffer;
        } else if (buffer instanceof ArrayBuffer) {
            arrayBuffer = buffer;
        } else if (buffer && buffer.buffer instanceof ArrayBuffer) {
            // TypedArray (Uint8Array, etc.)
            arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        } else {
            return null;
        }
    } catch (error) {
        return null;
    }
    
    if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer)) {
        return null;
    }
    
    const view = new DataView(arrayBuffer);
    let offset = 0;
    
    // Response Header (12 bytes)
    const messageLength = view.getInt16(offset, true); offset += 2;
    const responseCode = view.getUint8(offset); offset += 1;
    const exchangeSegment = view.getUint8(offset); offset += 1;
    const securityId = view.getInt32(offset, true); offset += 4;
    const sequence = view.getUint32(offset, true); offset += 4;
    
    const isBid = responseCode === FEED_RESPONSE_CODE.BID_DEPTH;
    const depth = [];
    
    // 20 levels, 16 bytes each = 320 bytes
    for (let i = 0; i < 20; i++) {
        const price = view.getFloat64(offset, true); offset += 8;
        const quantity = view.getUint32(offset, true); offset += 4;
        const orders = view.getUint32(offset, true); offset += 4;
        
        if (price > 0) {
            depth.push({ price, quantity, orders });
        }
    }
    
    return {
        securityId: securityId.toString(),
        exchangeSegment,
        isBid,
        depth,
        sequence
    };
}

// Parse 200-level depth packet
function parseDepth200Packet(buffer) {
    if (!buffer || buffer.length < 12) return null;
    
    // Convert Buffer to ArrayBuffer for DataView
    let arrayBuffer;
    if (Buffer.isBuffer(buffer)) {
        // Node.js Buffer - convert to ArrayBuffer
        arrayBuffer = buffer.buffer ? 
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) :
            new Uint8Array(buffer).buffer;
    } else if (buffer instanceof ArrayBuffer) {
        arrayBuffer = buffer;
    } else if (buffer.buffer instanceof ArrayBuffer) {
        // TypedArray
        arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
        return null;
    }
    
    const view = new DataView(arrayBuffer);
    let offset = 0;
    
    // Response Header (12 bytes)
    const messageLength = view.getInt16(offset, true); offset += 2;
    const responseCode = view.getUint8(offset); offset += 1;
    const exchangeSegment = view.getUint8(offset); offset += 1;
    const securityId = view.getInt32(offset, true); offset += 4;
    const sequence = view.getUint32(offset, true); offset += 4;
    
    const isBid = responseCode === FEED_RESPONSE_CODE.BID_DEPTH;
    const depth = [];
    
    // 200 levels, 16 bytes each = 3200 bytes
    for (let i = 0; i < 200; i++) {
        const price = view.getFloat64(offset, true); offset += 8;
        const quantity = view.getUint32(offset, true); offset += 4;
        const orders = view.getUint32(offset, true); offset += 4;
        
        if (price > 0) {
            depth.push({ price, quantity, orders });
        }
    }
    
    return {
        securityId: securityId.toString(),
        exchangeSegment,
        isBid,
        depth,
        sequence,
        timestamp: Date.now()
    };
}

// Store 200-level depth data
const depth200Data = new Map(); // symbol -> { bids: [], asks: [], timestamp }

// Analyze 200-level depth for trading advantages
function analyzeDepth200(symbol, depth200) {
    if (!depth200.bids || !depth200.asks) return null;
    
    const bids = depth200.bids;
    const asks = depth200.asks;
    
    // 1. Calculate OBI across all 200 levels
    const totalBidQty = bids.reduce((sum, b) => sum + b.quantity, 0);
    const totalAskQty = asks.reduce((sum, a) => sum + a.quantity, 0);
    const totalQty = totalBidQty + totalAskQty;
    const obi200 = totalQty > 0 ? ((totalBidQty - totalAskQty) / totalQty) * 100 : 0;
    
    // 2. Find support/resistance levels (large order clusters)
    const supportLevels = [];
    const resistanceLevels = [];
    
    // Aggregate by price bands (0.5% bands)
    const priceBands = {};
    bids.forEach(bid => {
        const band = Math.floor(bid.price / (bid.price * 0.005));
        if (!priceBands[band]) priceBands[band] = { price: bid.price, qty: 0 };
        priceBands[band].qty += bid.quantity;
    });
    
    Object.values(priceBands).forEach(band => {
        if (band.qty > 100000) { // Large order threshold
            supportLevels.push({ price: band.price, quantity: band.qty });
        }
    });
    
    // Similar for asks (resistance)
    const askBands = {};
    asks.forEach(ask => {
        const band = Math.floor(ask.price / (ask.price * 0.005));
        if (!askBands[band]) askBands[band] = { price: ask.price, qty: 0 };
        askBands[band].qty += ask.quantity;
    });
    
    Object.values(askBands).forEach(band => {
        if (band.qty > 100000) {
            resistanceLevels.push({ price: band.price, quantity: band.qty });
        }
    });
    
    // 3. Detect whales (very large orders)
    const whales = [];
    bids.forEach(bid => {
        if (bid.quantity > 500000) {
            whales.push({ type: 'BUY_WHALE', price: bid.price, quantity: bid.quantity });
        }
    });
    asks.forEach(ask => {
        if (ask.quantity > 500000) {
            whales.push({ type: 'SELL_WHALE', price: ask.price, quantity: ask.quantity });
        }
    });
    
    // 4. Calculate liquidity for different order sizes
    const liquidity = {
        buy10K: calculateLiquidity(asks, 10000),
        buy50K: calculateLiquidity(asks, 50000),
        buy100K: calculateLiquidity(asks, 100000),
        sell10K: calculateLiquidity(bids, 10000),
        sell50K: calculateLiquidity(bids, 50000),
        sell100K: calculateLiquidity(bids, 100000)
    };
    
    return {
        obi200,
        supportLevels: supportLevels.slice(0, 5), // Top 5 support levels
        resistanceLevels: resistanceLevels.slice(0, 5), // Top 5 resistance levels
        whales,
        liquidity,
        totalBidQty,
        totalAskQty,
        depthRatio: totalBidQty / (totalAskQty || 1)
    };
}

// Calculate liquidity for a given order size
function calculateLiquidity(levels, orderSize) {
    let cumulativeQty = 0;
    let weightedPrice = 0;
    let levelsUsed = 0;
    
    for (const level of levels) {
        const qtyToTake = Math.min(level.quantity, orderSize - cumulativeQty);
        weightedPrice += level.price * qtyToTake;
        cumulativeQty += qtyToTake;
        levelsUsed++;
        
        if (cumulativeQty >= orderSize) {
            break;
        }
    }
    
    if (cumulativeQty === 0) return null;
    
    return {
        avgPrice: weightedPrice / cumulativeQty,
        levelsUsed,
        canExecute: cumulativeQty >= orderSize,
        slippage: levels.length > 0 ? Math.abs((weightedPrice / cumulativeQty) - levels[0].price) / levels[0].price * 100 : 0
    };
}

// Connect to Live Market Feed WebSocket (multiple connections)
function connectLiveFeed(connectionIndex, instruments) {
    const wsUrl = `${DHAN_CONFIG.LIVE_FEED_WS}?version=2&token=${DHAN_CONFIG.ACCESS_TOKEN}&clientId=${DHAN_CONFIG.CLIENT_ID}&authType=2`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        console.log(`✅ Live Feed Connection ${connectionIndex + 1} established`);
        
        if (!isMarketOpen()) {
            console.log(`   ⚠️  Market is closed. Connection established but may not receive data.`);
        }
        
        // Subscribe to instruments (Request Code 1)
        // Can send up to 100 instruments per message
        const batches = [];
        for (let i = 0; i < instruments.length; i += 100) {
            batches.push(instruments.slice(i, i + 100));
        }
        
        batches.forEach((batch, index) => {
            setTimeout(() => {
                // Dhan WebSocket subscription format (Bridge Architecture)
                // Request Code 15 = Ticker, Request Code 17 = Quote
                // Symbols work directly in WebSocket subscriptions
                // Dhan API requires SecurityId (numeric), not symbol names
                // Request Code 15 = Ticker subscription
                const validInstruments = batch.map(inst => ({
                    ExchangeSegment: inst.exchangeSegment,
                    SecurityId: inst.securityId // Must be numeric SecurityId, not symbol
                })).filter(inst => {
                    // Check if SecurityId is numeric
                    const isNumeric = inst.SecurityId && !isNaN(inst.SecurityId) && !isNaN(parseFloat(inst.SecurityId));
                    if (!isNumeric) {
                        console.warn(`   ⚠️  Invalid SecurityId for ${inst.ExchangeSegment}: "${inst.SecurityId}" (not numeric)`);
                    }
                    return isNumeric;
                });
                
                if (validInstruments.length === 0) {
                    console.error(`   ❌ Batch ${index + 1}: No valid SecurityIds found!`);
                    console.error(`   ❌ Sample instruments: ${JSON.stringify(batch.slice(0, 3).map(i => ({symbol: i.symbol, securityId: i.securityId})))}`);
                    return;
                }
                
                const subscribeMsg = {
                    RequestCode: 15, // Ticker subscription (as per Dhan docs)
                    InstrumentCount: validInstruments.length,
                    InstrumentList: validInstruments
                };
                
                ws.send(JSON.stringify(subscribeMsg));
                if (index === 0 || index === batches.length - 1) {
                    console.log(`   📡 Connection ${connectionIndex + 1}: Subscribed to ${validInstruments.length}/${batch.length} instruments (batch ${index + 1}/${batches.length})`);
                    if (validInstruments.length < batch.length) {
                        console.warn(`   ⚠️  ${batch.length - validInstruments.length} instruments filtered out (invalid SecurityIds)`);
                    }
                }
            }, index * 300); // Stagger requests
        });
        
        console.log(`   ✅ Connection ${connectionIndex + 1}: Subscribing to ${instruments.length} instruments in ${batches.length} batches\n`);
    });
    
    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            try {
                const marketData = parseMarketDataPacket(data);
                if (marketData) {
                    const symbol = getSymbolFromSecurityId(marketData.securityId);
                    if (symbol) {
                        stockData.set(symbol, marketData);
                        
                        // Fetch historical data on-demand if not already loaded
                        if (!historicalData.has(symbol)) {
                            // Fetch in background (don't await)
                            fetchHistoricalData(symbol, marketData.securityId, marketData.exchangeSegment || 'NSE_EQ')
                                .then(histData => {
                                    if (histData && histData.close > 0) {
                                        historicalData.set(symbol, histData);
                                    }
                                })
                                .catch(() => {
                                    // Silently fail - will try again later
                                });
                        }
                        
                        // Check for opportunities (only if market is open)
                        if (isMarketOpen()) {
                            try {
                                const opps = checkProfitableConditions(symbol, marketData);
                                if (opps && opps.length > 0) {
                                    opps.forEach(opp => {
                                        // Check if similar opportunity exists (same symbol + type + strategy within 5 seconds)
                                        const exists = opportunities.find(o => 
                                            o.symbol === opp.symbol && 
                                            o.type === opp.type &&
                                            o.strategy === opp.strategy &&
                                            Math.abs(o.timestamp - opp.timestamp) < 5000
                                        );
                                        
                                        if (!exists) {
                                            // Calculate composite score: quality + changePercent weight
                                            const changeWeight = Math.min(30, Math.abs(opp.changePercent || 0) * 2);
                                            opp.compositeScore = opp.quality + changeWeight;
                                            
                                            opportunities.push(opp);
                                            
                                            // Sort opportunities by composite score (best first)
                                            opportunities.sort((a, b) => {
                                                if (b.compositeScore !== a.compositeScore) {
                                                    return b.compositeScore - a.compositeScore;
                                                }
                                                return Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0);
                                            });
                                            
                                            // Keep only top 50 opportunities
                                            if (opportunities.length > 50) {
                                                opportunities.splice(50);
                                            }
                                            
                                            console.log(`🎯 ${opp.strategy || 'SIGNAL'}: ${opp.symbol} ${opp.type} | Quality: ${opp.quality}% | Change: ${(opp.changePercent || 0).toFixed(2)}% | Net: ${opp.netProfitPct}%`);
                                            
                                            // Broadcast to WebSocket clients
                                            broadcastUpdate('OPPORTUNITY', opp);
                                        } else {
                                            // Update existing opportunity with latest data
                                            const index = opportunities.indexOf(exists);
                                            if (index >= 0) {
                                                const changeWeight = Math.min(30, Math.abs(opp.changePercent || 0) * 2);
                                                opp.compositeScore = opp.quality + changeWeight;
                                                opportunities[index] = opp;
                                                
                                                // Re-sort after update
                                                opportunities.sort((a, b) => {
                                                    if (b.compositeScore !== a.compositeScore) {
                                                        return b.compositeScore - a.compositeScore;
                                                    }
                                                    return Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0);
                                                });
                                            }
                                        }
                                    });
                                }
                            } catch (error) {
                                // Don't crash on opportunity check errors
                                if (stockData.size < 10) {
                                    console.warn(`⚠️  Error checking opportunities for ${symbol}: ${error.message}`);
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                // Log parsing errors but don't crash
                if (stockData.size < 10) {
                    console.warn(`⚠️  Error parsing market data: ${error.message}`);
                }
            }
        } else {
            // Non-binary message - log for debugging (but don't spam)
            if (stockData.size < 5) {
                console.log(`   📨 Received non-binary message (length: ${data.length})`);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`❌ Live Feed Connection ${connectionIndex + 1} error:`, error.message);
        // Don't crash - error handler will manage reconnection
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.log(`   ⚠️  Connection refused or timed out. This is normal when market is closed.`);
        }
    });
    
    ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'Unknown';
        console.log(`⚠️ Live Feed Connection ${connectionIndex + 1} closed (code: ${code}, reason: ${reasonStr})`);
        
        // Only reconnect if market is open or if it's a connection error (not market close)
        if (isMarketOpen() || code === 1006) {
            console.log(`   🔄 Reconnecting in 5 seconds...`);
            setTimeout(() => {
                if (isMarketOpen()) {
                    connectLiveFeed(connectionIndex, instruments);
                } else {
                    console.log(`   ⏸️  Market is closed. Will reconnect when market opens.`);
                }
            }, 5000);
        } else {
            console.log(`   ⏸️  Market appears to be closed. Will reconnect when market opens.`);
        }
    });
    
    return ws;
}

// Connect all Live Feed WebSockets
function connectAllLiveFeeds() {
    if (STOCK_UNIVERSE.length === 0) {
        console.log('⚠️  No instruments loaded. Waiting...');
        return;
    }
    
    const perConnection = Math.ceil(STOCK_UNIVERSE.length / MAX_CONNECTIONS);
    
    for (let i = 0; i < MAX_CONNECTIONS; i++) {
        const start = i * perConnection;
        const end = Math.min(start + perConnection, STOCK_UNIVERSE.length);
        const instruments = STOCK_UNIVERSE.slice(start, end);
        
        if (instruments.length > 0) {
            setTimeout(() => {
                const ws = connectLiveFeed(i, instruments);
                liveFeedConnections.push(ws);
            }, i * 1000); // Stagger connections by 1 second
        }
    }
}

// Connect to 20-Level Depth WebSocket (multiple connections)
function connectDepth20(connectionIndex, instruments) {
    const wsUrl = `${DHAN_CONFIG.DEPTH_20_WS}?token=${DHAN_CONFIG.ACCESS_TOKEN}&clientId=${DHAN_CONFIG.CLIENT_ID}&authType=2`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        console.log(`✅ Depth Connection ${connectionIndex + 1} established`);
        
        if (!isMarketOpen()) {
            console.log(`   ⚠️  Market is closed. Connection established but may not receive data.`);
        }
        
        // Subscribe to instruments (Request Code 23)
        // Can send up to 50 instruments per connection
        const batches = [];
        for (let i = 0; i < instruments.length; i += 50) {
            batches.push(instruments.slice(i, i + 50));
        }
        
        batches.forEach((batch, index) => {
            setTimeout(() => {
                // Depth subscription - Request Code 23
                const subscribeMsg = {
                    RequestCode: 23,
                    InstrumentCount: batch.length,
                    InstrumentList: batch.map(inst => ({
                        ExchangeSegment: inst.exchangeSegment,
                        SecurityId: inst.securityId || inst.symbol // Use symbol if SecurityId not available
                    }))
                };
                
                ws.send(JSON.stringify(subscribeMsg));
                if (index === 0 || index === batches.length - 1) {
                    console.log(`   📡 Depth ${connectionIndex + 1}: Subscribed to ${batch.length} instruments (batch ${index + 1}/${batches.length})`);
                }
            }, index * 300);
        });
        
        console.log(`   ✅ Depth ${connectionIndex + 1}: Subscribing to ${instruments.length} instruments in ${batches.length} batches\n`);
    });
    
    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            try {
                const depthData = parseDepth20Packet(data);
                if (depthData) {
                    const symbol = getSymbolFromSecurityId(depthData.securityId);
                    if (symbol) {
                        const existing = stockData.get(symbol) || {};
                        if (depthData.isBid) {
                            existing.bids = depthData.depth;
                        } else {
                            existing.asks = depthData.depth;
                        }
                        stockData.set(symbol, existing);
                    }
                }
            } catch (error) {
                // Log parsing errors but don't crash
                if (stockData.size < 10) {
                    console.warn(`⚠️  Error parsing depth20 data: ${error.message}`);
                }
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`❌ Depth Connection ${connectionIndex + 1} error:`, error.message);
        // Don't crash - error handler will manage reconnection
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.log(`   ⚠️  Connection refused or timed out. This is normal when market is closed.`);
        }
    });
    
    ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'Unknown';
        console.log(`⚠️ Depth Connection ${connectionIndex + 1} closed (code: ${code}, reason: ${reasonStr})`);
        
        // Only reconnect if market is open or if it's a connection error
        if (isMarketOpen() || code === 1006) {
            console.log(`   🔄 Reconnecting in 5 seconds...`);
            setTimeout(() => {
                if (isMarketOpen()) {
                    connectDepth20(connectionIndex, instruments);
                } else {
                    console.log(`   ⏸️  Market is closed. Will reconnect when market opens.`);
                }
            }, 5000);
        } else {
            console.log(`   ⏸️  Market appears to be closed. Will reconnect when market opens.`);
        }
    });
    
    return ws;
}

// Dynamic 200-Level Depth WebSocket (for on-demand subscriptions)
let dynamicDepth200WS = null;
let currentDepthSubscription = null; // Track current subscribed security

// Connect to 200-Level Depth WebSocket (for top opportunities only)
function connectDepth200(instruments) {
    // Only connect to top 10-15 instruments with highest opportunity scores
    const wsUrl = `${DHAN_CONFIG.DEPTH_200_WS}?token=${DHAN_CONFIG.ACCESS_TOKEN}&clientId=${DHAN_CONFIG.CLIENT_ID}&authType=2`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        console.log(`✅ 200-Level Depth Connection established`);
        
        if (!isMarketOpen()) {
            console.log(`   ⚠️  Market is closed. Connection established but may not receive data.`);
        }
        
        // Subscribe to instruments (Request Code 23, same as 20-level)
        const subscribeMsg = {
            RequestCode: 23,
            InstrumentCount: instruments.length,
            InstrumentList: instruments.map(inst => ({
                ExchangeSegment: inst.exchangeSegment,
                SecurityId: inst.securityId
            }))
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        console.log(`   📡 200-Level Depth: Subscribed to ${instruments.length} top instruments\n`);
    });
    
    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            try {
                const depthData = parseDepth200Packet(data);
                if (depthData) {
                    const symbol = getSymbolFromSecurityId(depthData.securityId);
                    if (symbol) {
                        // Store depth data
                        const existing = depth200Data.get(symbol) || { bids: [], asks: [] };
                        if (depthData.isBid) {
                            existing.bids = depthData.depth;
                        } else {
                            existing.asks = depthData.depth;
                        }
                        existing.timestamp = depthData.timestamp;
                        depth200Data.set(symbol, existing);
                        
                        // Analyze depth for trading advantages
                        if (existing.bids.length > 0 && existing.asks.length > 0) {
                            const analysis = analyzeDepth200(symbol, existing);
                            if (analysis) {
                                // Store analysis with stock data
                                const stock = stockData.get(symbol) || {};
                                stock.depth200 = analysis;
                                stockData.set(symbol, stock);
                                
                                // Broadcast depth insights to WebSocket clients
                                wss.clients.forEach(client => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'DEPTH200_UPDATE',
                                            data: {
                                                symbol,
                                                ...analysis
                                            }
                                        }));
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                // Log parsing errors but don't crash
                if (depth200Data.size < 10) {
                    console.warn(`⚠️  Error parsing depth200 data: ${error.message}`);
                }
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`❌ 200-Level Depth Connection error:`, error.message);
        // Don't crash - error handler will manage reconnection
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.log(`   ⚠️  Connection refused or timed out. This is normal when market is closed.`);
        }
    });
    
    ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'Unknown';
        console.log(`⚠️ 200-Level Depth Connection closed (code: ${code}, reason: ${reasonStr})`);
        
        // Only reconnect if market is open or if it's a connection error
        if (isMarketOpen() || code === 1006) {
            console.log(`   🔄 Reconnecting in 5 seconds...`);
            setTimeout(() => {
                if (isMarketOpen()) {
                    // Reconnect with current top opportunities
                    const topInstruments = getTopOpportunityInstruments(15);
                    if (topInstruments.length > 0) {
                        connectDepth200(topInstruments);
                    }
                } else {
                    console.log(`   ⏸️  Market is closed. Will reconnect when market opens.`);
                }
            }, 5000);
        } else {
            console.log(`   ⏸️  Market appears to be closed. Will reconnect when market opens.`);
        }
    });
    
    return ws;
}

// Get top instruments by opportunity score for 200-level depth
function getTopOpportunityInstruments(count) {
    const instruments = Array.from(stockData.entries())
        .map(([symbol, data]) => {
            const inst = STOCK_UNIVERSE.find(i => i.symbol === symbol);
            if (!inst) return null;
            
            const historical = historicalData.get(symbol);
            const score = calculateOpportunityScore(symbol, data, historical);
            return { ...inst, score };
        })
        .filter(i => i !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
    
    return instruments;
}

// Connect all Depth WebSockets
function connectAllDepths() {
    if (STOCK_UNIVERSE.length === 0) {
        return;
    }
    
    // For 20-level depth, we can use fewer connections since it's 50 per connection
    const depthConnections = Math.min(MAX_CONNECTIONS, Math.ceil(STOCK_UNIVERSE.length / 50));
    const perConnection = Math.ceil(STOCK_UNIVERSE.length / depthConnections);
    
    for (let i = 0; i < depthConnections; i++) {
        const start = i * perConnection;
        const end = Math.min(start + perConnection, STOCK_UNIVERSE.length);
        const instruments = STOCK_UNIVERSE.slice(start, end);
        
        if (instruments.length > 0) {
            setTimeout(() => {
                const ws = connectDepth20(i, instruments);
                depth20Connections.push(ws);
            }, i * 1000);
        }
    }
    
    // Connect 200-level depth for top opportunities (after a delay)
    setTimeout(() => {
        const topInstruments = getTopOpportunityInstruments(15);
        if (topInstruments.length > 0) {
            connectDepth200(topInstruments);
            console.log(`\n🎯 200-Level Depth: Monitoring ${topInstruments.length} top opportunities\n`);
        }
    }, 10000); // Wait 10 seconds for initial data
}

// Security ID mapping
const SECURITY_ID_MAP = new Map();
const SECURITY_ID_TO_SYMBOL = new Map();

function getSecurityId(symbol) {
    return SECURITY_ID_MAP.get(symbol?.toUpperCase()) || symbol;
}

function getSymbolFromSecurityId(securityId) {
    return SECURITY_ID_TO_SYMBOL.get(securityId.toString()) || null;
}

// Load instruments from CSV file (like the Python bridge system)
// Dhan doesn't provide REST API for instrument list - use CSV download
async function loadInstrumentsFromCSV() {
    const fs = require('fs');
    const path = require('path');
    
    // Try multiple possible CSV file names
    const csvFiles = [
        'api-scrip-master-detailed.csv',
        'scrip_master.csv',
        'scrip-master.csv',
        'instruments.csv'
    ];
    
    let csvPath = null;
    for (const fileName of csvFiles) {
        const testPath = path.join(__dirname, fileName);
        if (fs.existsSync(testPath)) {
            csvPath = testPath;
            break;
        }
    }
    
    if (csvPath) {
        console.log(`📥 Loading instruments from ${path.basename(csvPath)}...\n`);
        const csv = require('csv-parser');
        const results = [];
        let rowCount = 0;
        
        return new Promise((resolve, reject) => {
            fs.createReadStream(csvPath)
                .pipe(csv())
                .on('data', (row) => {
                    rowCount++;
                    
                    // CSV columns: EXCH_ID, SEGMENT, SECURITY_ID, ISIN, INSTRUMENT, ..., SYMBOL_NAME, ...
                    const exchId = (row.EXCH_ID || row.exch_id || '').toUpperCase().trim();
                    const segment = (row.SEGMENT || row.segment || '').toUpperCase().trim();
                    const securityId = (row.SECURITY_ID || row.security_id || row.SECURITYID || '').toString().trim();
                    const symbol = (row.SYMBOL_NAME || row.symbol_name || row.SYMBOL || row.symbol || '').toUpperCase().trim();
                    const instrumentType = (row.INSTRUMENT_TYPE || row.instrument_type || '').toUpperCase().trim();
                    
                    // Filter for NSE Equity ONLY (EXCH_ID="NSE", SEGMENT="E")
                    // Exclude: Indices (I), F&O (D), Commodities (C), Bonds, ETFs, etc.
                    if (exchId !== 'NSE') {
                        return; // Skip non-NSE instruments
                    }
                    
                    // Only include Equity segment (E)
                    if (segment !== 'E') {
                        return; // Skip Indices (I), F&O (D), commodities (C), etc.
                    }
                    
                    // Skip derivatives, options, futures
                    if (instrumentType && (instrumentType.includes('FUT') || instrumentType.includes('OPT') || instrumentType.includes('CE') || instrumentType.includes('PE'))) {
                        return;
                    }
                    
                    // Skip bonds, debentures, ETFs, and other non-equity instruments
                    const symbolUpper = symbol.toUpperCase();
                    if (symbolUpper.includes('BOND') || 
                        symbolUpper.includes('DEBENTURE') || 
                        symbolUpper.includes('NCD') || 
                        symbolUpper.includes('ETF') ||
                        symbolUpper.includes('SDL') ||
                        symbolUpper.includes('SEC RE') ||
                        symbolUpper.includes('GOVT') ||
                        symbolUpper.includes('TREASURY') ||
                        instrumentType?.includes('BOND') ||
                        instrumentType?.includes('DEBT') ||
                        instrumentType?.includes('ETF')) {
                        return;
                    }
                    
                    if (symbol && securityId) {
                        const sym = symbol.toUpperCase().trim();
                        const secId = securityId.toString().trim();
                        
                        // Validate SecurityId is numeric
                        if (isNaN(secId) || secId === '') {
                            if (rowCount <= 10) {
                                console.warn(`   ⚠️  Row ${rowCount}: Invalid SecurityId "${secId}" for symbol "${sym}"`);
                            }
                            return;
                        }
                        
                        // Map segment to Dhan API format
                        // CSV uses: E = Equity, I = Indices
                        // Dhan API uses: NSE_EQ, NSE_INDICES
                        const exchangeSegment = segment === 'I' ? 'NSE_INDICES' : 'NSE_EQ';
                        
                        results.push({
                            symbol: sym,
                            securityId: secId,
                            exchangeSegment: exchangeSegment
                        });
                        SECURITY_ID_MAP.set(sym, secId);
                        SECURITY_ID_TO_SYMBOL.set(secId, sym);
                    }
                })
                .on('end', () => {
                    console.log(`✅ Loaded ${results.length} instruments from CSV (processed ${rowCount} rows)\n`);
                    if (results.length === 0) {
                        console.error('   ❌ No valid instruments found! Check CSV column names.\n');
                    }
                    resolve(results);
                })
                .on('error', (error) => {
                    console.error(`❌ Error reading CSV: ${error.message}\n`);
                    reject(error);
                });
        });
    }
    return null;
}

// Fetch ALL cash equities and indices from Dhan API
// According to Dhan docs: https://dhanhq.co/docs/v2/live-market-feed/
// SecurityId is required (numeric ID), not symbol names
async function fetchAllInstruments() {
    try {
        console.log('📥 Fetching ALL instruments from Dhan API...\n');
        console.log('   🔍 Attempting to fetch instrument master list...\n');
        
        // Try to load from CSV first (most reliable)
        const csvInstruments = await loadInstrumentsFromCSV();
        
        if (csvInstruments && csvInstruments.length > 0) {
            STOCK_UNIVERSE = csvInstruments;
            console.log(`✅ Loaded ${STOCK_UNIVERSE.length} instruments from CSV file\n`);
            return;
        }
        
        // Try multiple API endpoints to fetch instrument master
        console.log('   🔄 Trying Dhan API endpoints for instrument master...\n');
        
        const endpoints = [
            'https://api.dhan.co/masters/instruments',
            'https://api.dhan.co/v1/masters/instruments',
            'https://api.dhan.co/instruments',
            'https://api.dhan.co/v1/instruments',
            'https://api.dhan.co/masters/instruments.csv',
            'https://api.dhan.co/instruments.csv'
        ];
        
        let instruments = null;
        
        for (const endpoint of endpoints) {
            try {
                console.log(`   🔄 Trying: ${endpoint}`);
                
                const response = await axios.get(endpoint, {
                    headers: {
                        'access-token': DHAN_CONFIG.ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    params: {
                        segment: 'NSE_EQ'
                    },
                    timeout: 15000,
                    validateStatus: (status) => status < 500
                });
                
                console.log(`   📊 Response Status: ${response.status}`);
                
                if (response.status === 200) {
                    // Check if it's CSV or JSON
                    if (typeof response.data === 'string' && response.data.includes(',')) {
                        console.log(`   ✅ Got CSV data from ${endpoint}`);
                        // Parse CSV
                        const lines = response.data.split('\n');
                        const headers = lines[0].split(',');
                        const symbolIdx = headers.findIndex(h => h.toLowerCase().includes('symbol'));
                        const securityIdIdx = headers.findIndex(h => h.toLowerCase().includes('security') || h.toLowerCase().includes('id'));
                        
                        if (symbolIdx >= 0 && securityIdIdx >= 0) {
                            instruments = [];
                            for (let i = 1; i < lines.length; i++) {
                                const cols = lines[i].split(',');
                                if (cols[symbolIdx] && cols[securityIdIdx]) {
                                    instruments.push({
                                        symbol: cols[symbolIdx].trim().toUpperCase(),
                                        securityId: cols[securityIdIdx].trim(),
                                        exchangeSegment: 'NSE_EQ'
                                    });
                                }
                            }
                            console.log(`   ✅ Parsed ${instruments.length} instruments from CSV\n`);
                            break;
                        }
                    } else if (Array.isArray(response.data)) {
                        console.log(`   ✅ Got JSON array from ${endpoint}`);
                        instruments = response.data.map(item => ({
                            symbol: (item.symbol || item.tradingSymbol || item.SYMBOL || '').toUpperCase(),
                            securityId: (item.securityId || item.instrumentId || item.SECURITY_ID || item.SECURITYID || '').toString(),
                            exchangeSegment: (item.exchangeSegment || item.EXCHANGE_SEGMENT || 'NSE_EQ').toUpperCase()
                        })).filter(inst => inst.symbol && inst.securityId);
                        console.log(`   ✅ Parsed ${instruments.length} instruments from JSON\n`);
                        break;
                    } else if (response.data && response.data.data && Array.isArray(response.data.data)) {
                        console.log(`   ✅ Got nested JSON from ${endpoint}`);
                        instruments = response.data.data.map(item => ({
                            symbol: (item.symbol || item.tradingSymbol || item.SYMBOL || '').toUpperCase(),
                            securityId: (item.securityId || item.instrumentId || item.SECURITY_ID || item.SECURITYID || '').toString(),
                            exchangeSegment: (item.exchangeSegment || item.EXCHANGE_SEGMENT || 'NSE_EQ').toUpperCase()
                        })).filter(inst => inst.symbol && inst.securityId);
                        console.log(`   ✅ Parsed ${instruments.length} instruments from nested JSON\n`);
                        break;
                    }
                } else if (response.status === 404) {
                    console.log(`   ⚠️  404 Not Found: ${endpoint}`);
                } else if (response.status === 401) {
                    console.log(`   ❌ 401 Unauthorized: Check your access token`);
                } else {
                    console.log(`   ⚠️  Status ${response.status}: ${JSON.stringify(response.data).substring(0, 100)}`);
                }
            } catch (error) {
                if (error.response) {
                    console.log(`   ❌ Error ${error.response.status}: ${error.response.statusText}`);
                } else {
                    console.log(`   ❌ Network error: ${error.message}`);
                }
                continue;
            }
        }
        
        if (instruments && instruments.length > 0) {
            STOCK_UNIVERSE = instruments;
            STOCK_UNIVERSE.forEach(inst => {
                SECURITY_ID_MAP.set(inst.symbol, inst.securityId);
                SECURITY_ID_TO_SYMBOL.set(inst.securityId, inst.symbol);
            });
            console.log(`✅ Successfully loaded ${STOCK_UNIVERSE.length} instruments from Dhan API!\n`);
            return;
        }
        
        // If all API calls fail, show error and instructions
        console.error('\n❌ FAILED TO FETCH INSTRUMENTS FROM DHAN API');
        console.error('   All API endpoints returned errors or 404\n');
        console.error('🚨 CRITICAL: Without proper SecurityIds, WebSocket subscriptions will FAIL!');
        console.error('   Current fallback uses symbol names as SecurityIds, which are INVALID.\n');
        console.error('📋 REQUIRED SOLUTION: Download Instrument Master CSV from Dhan');
        console.error('   1. Go to: https://dhanhq.co/docs/v2/instruments/');
        console.error('   2. Download the instrument master CSV file');
        console.error('   3. Save it as: scrip_master.csv in the project root');
        console.error('   4. The CSV must contain columns: SYMBOL, SECURITY_ID, EXCHANGE_SEGMENT');
        console.error('   5. Restart the server\n');
        console.error('   Without this CSV file, NO DATA will be received from Dhan WebSocket!\n');
        
        // Don't throw - use fallback manual list instead
        console.log('   ⚠️  Using fallback manual stock list...\n');
        
        if (STOCK_UNIVERSE.length > TOTAL_CAPACITY) {
            console.log(`\n⚠️  WARNING: ${STOCK_UNIVERSE.length} instruments exceed capacity of ${TOTAL_CAPACITY}`);
            console.log(`   Will monitor first ${TOTAL_CAPACITY} instruments\n`);
            STOCK_UNIVERSE = STOCK_UNIVERSE.slice(0, TOTAL_CAPACITY);
        }
        
        console.log(`\n📊 Distribution across ${MAX_CONNECTIONS} connections:`);
        const perConnection = Math.ceil(STOCK_UNIVERSE.length / MAX_CONNECTIONS);
        for (let i = 0; i < MAX_CONNECTIONS; i++) {
            const start = i * perConnection;
            const end = Math.min(start + perConnection, STOCK_UNIVERSE.length);
            const count = end - start;
            if (count > 0) {
                console.log(`   Connection ${i + 1}: ${count} instruments (${start + 1}-${end})`);
            }
        }
        console.log('');
        
        // Fetch historical OHLCV data for all stocks (only if we have stocks)
        // NOTE: For large universes (>1000 stocks), skip historical data to avoid crashes
        // Historical data will be fetched on-demand or in background
        if (STOCK_UNIVERSE.length > 0) {
            if (STOCK_UNIVERSE.length > 1000) {
                console.log('📊 Large universe detected. Skipping bulk historical data fetch to prevent crashes.\n');
                console.log('   💡 Historical data will be fetched on-demand as stocks receive live data.\n');
            } else {
                console.log('📥 Fetching historical OHLCV data (yesterday)...\n');
                // Don't await - let it run in background
                fetchAllHistoricalData().catch(err => {
                    console.error('⚠️  Historical data fetch error (non-critical):', err.message);
                });
            }
        } else {
            console.log('⚠️  No stocks in universe, skipping historical data fetch\n');
        }
        
    } catch (error) {
        console.error('\n❌ ERROR LOADING INSTRUMENTS');
        console.error(`   Error: ${error.message}`);
        if (error.stack) {
            console.error(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
        }
        console.error('\n💡 SOLUTION:');
        console.error('   1. Download scrip_master.csv from Dhan documentation');
        console.error('   2. Place it in the project root directory');
        console.error('   3. Or use the manual stock list (already loaded)\n');
        
        // Fallback: use manual list
        const manualStocks = [
            'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'INDUSINDBK', 'BANDHANBNK',
            'TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM', 'MPHASIS',
            'RELIANCE', 'ONGC', 'IOC', 'BPCL', 'HINDPETRO',
            'HDFC', 'HDFCLIFE', 'ICICIPRULI', 'SBILIFE',
            'BHARTIARTL', 'TATACOMM',
            'ITC', 'NESTLEIND', 'MARICO', 'DABUR',
            'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO',
            'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'
        ];
        
        STOCK_UNIVERSE = manualStocks.map(symbol => ({
            symbol,
            securityId: symbol,
            exchangeSegment: symbol.includes('NIFTY') ? 'NSE_INDICES' : 'NSE_EQ'
        }));
        
        STOCK_UNIVERSE.forEach(inst => {
            SECURITY_ID_MAP.set(inst.symbol, inst.securityId);
            SECURITY_ID_TO_SYMBOL.set(inst.securityId, inst.symbol);
        });
        
        console.log(`   ✅ Using manual stock list: ${STOCK_UNIVERSE.length} stocks\n`);
        console.log('   ⚠️  WARNING: Manual list uses symbol names as SecurityIds, which may not work with Dhan API.');
        console.log('   💡 For proper functionality, download the CSV file with numeric SecurityIds.\n');
    }
}

// Real-time opportunity monitoring (runs every second)
setInterval(() => {
    if (!isMarketOpen()) return; // Only monitor during market hours
    
    // Re-evaluate all stocks with live data
    let evaluated = 0;
    let newOpportunities = 0;
    
    stockData.forEach((marketData, symbol) => {
        if (!marketData.ltp || !marketData.bids || !marketData.asks) return;
        
        evaluated++;
        try {
            const opps = checkProfitableConditions(symbol, marketData);
            
            if (opps && opps.length > 0) {
                opps.forEach(opp => {
                    const exists = opportunities.find(o => 
                        o.symbol === opp.symbol && 
                        o.type === opp.type &&
                        o.strategy === opp.strategy &&
                        Math.abs(o.timestamp - opp.timestamp) < 2000 // 2 second window
                    );
                    
                    if (!exists) {
                        const changeWeight = Math.min(30, Math.abs(opp.changePercent || 0) * 2);
                        opp.compositeScore = opp.quality + changeWeight;
                        opportunities.push(opp);
                        newOpportunities++;
                    } else {
                        // Update existing
                        const index = opportunities.indexOf(exists);
                        if (index >= 0) {
                            const changeWeight = Math.min(30, Math.abs(opp.changePercent || 0) * 2);
                            opp.compositeScore = opp.quality + changeWeight;
                            opportunities[index] = opp;
                        }
                    }
                });
            }
        } catch (error) {
            // Silently handle errors
        }
    });
    
    // Sort by composite score (best opportunities first)
    opportunities.sort((a, b) => {
        if (b.compositeScore !== a.compositeScore) {
            return b.compositeScore - a.compositeScore;
        }
        // Secondary sort by absolute changePercent (momentum)
        return Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0);
    });
    
    // Keep only top 50 opportunities
    if (opportunities.length > 50) {
        opportunities.splice(50);
    }
    
    // Clean up old opportunities (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentOpps = opportunities.filter(o => o.timestamp > fiveMinutesAgo);
    opportunities.length = 0;
    opportunities.push(...recentOpps);
    
    if (newOpportunities > 0 && evaluated > 0 && evaluated % 100 === 0) {
        console.log(`📊 Real-time scan: ${evaluated} stocks | ${newOpportunities} new opportunities | Total: ${opportunities.length}`);
    }
}, 1000); // Every second

// Fetch historical OHLCV data for a stock
async function fetchHistoricalData(symbol, securityId, exchangeSegment) {
    try {
        // Get yesterday's date (format: YYYY-MM-DD)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];
        
        // Fetch historical data from Dhan API
        // Reference: https://dhanhq.co/docs/v2/historical-data/
        // Try POST method (v2 API format)
        try {
            const response = await axios.post(
                `https://api.dhan.co/historical`,
                {
                    symbol: symbol,
                    exchangeSegment: exchangeSegment,
                    instrumentType: exchangeSegment === 'NSE_INDICES' ? 'INDEX' : 'EQUITY',
                    expiryCode: 0,
                    fromDate: dateStr,
                    toDate: dateStr,
                    interval: '1_DAY'
                },
                {
                    headers: {
                        'access-token': DHAN_CONFIG.ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.data && response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
                const candle = response.data.data[response.data.data.length - 1];
                return {
                    open: parseFloat(candle.open || candle.Open || 0),
                    high: parseFloat(candle.high || candle.High || 0),
                    low: parseFloat(candle.low || candle.Low || 0),
                    close: parseFloat(candle.close || candle.Close || 0),
                    volume: parseInt(candle.volume || candle.Volume || 0),
                    date: candle.date || candle.Date || dateStr
                };
            }
        } catch (postError) {
            // Try GET method as fallback
            const response = await axios.get(
                `https://api.dhan.co/historical`,
                {
                    headers: {
                        'access-token': DHAN_CONFIG.ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    params: {
                        symbol: symbol,
                        exchangeSegment: exchangeSegment,
                        instrumentType: exchangeSegment === 'NSE_INDICES' ? 'INDEX' : 'EQUITY',
                        expiryCode: 0,
                        fromDate: dateStr,
                        toDate: dateStr,
                        interval: '1_DAY'
                    }
                }
            );
            
            if (response.data && response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
                const candle = response.data.data[response.data.data.length - 1];
                return {
                    open: parseFloat(candle.open || candle.Open || 0),
                    high: parseFloat(candle.high || candle.High || 0),
                    low: parseFloat(candle.low || candle.Low || 0),
                    close: parseFloat(candle.close || candle.Close || 0),
                    volume: parseInt(candle.volume || candle.Volume || 0),
                    date: candle.date || candle.Date || dateStr
                };
            }
        }
    } catch (error) {
        // Silently fail - will use live data if available
    }
    return null;
}

// Calculate opportunity score for a stock (works with or without live data)
function calculateOpportunityScore(symbol, marketData, historicalData) {
    // Use historical data if live data not available
    const currentPrice = marketData?.ltp || historicalData?.close || 0;
    if (currentPrice === 0) return 0;
    
    const bids = marketData?.bids || [];
    const asks = marketData?.asks || [];
    
    // If no live order book, calculate score based on historical data only
    if (bids.length === 0 || asks.length === 0) {
        if (!historicalData) return 0;
        
        // Calculate score based on price movement from yesterday
        const change = historicalData.close - historicalData.open;
        const changePercent = (change / historicalData.open) * 100;
        const range = historicalData.high - historicalData.low;
        const rangePercent = (range / historicalData.open) * 100;
        
        // Simple scoring based on volatility and movement
        let score = 0;
        if (Math.abs(changePercent) > 2) score += 30; // Strong movement
        if (rangePercent > 3) score += 20; // High volatility
        if (historicalData.volume > 1000000) score += 20; // Good volume
        if (changePercent > 0) score += 15; // Positive movement
        else if (changePercent < -2) score += 15; // Strong negative (SHORT opportunity)
        
        return Math.min(100, score);
    }
    
    // Calculate OBI
    const obi = calculateOBI(bids, asks);
    
    // Calculate spread
    const bestBid = bids[0]?.price || currentPrice;
    const bestAsk = asks[0]?.price || currentPrice;
    const spread = ((bestAsk - bestBid) / currentPrice) * 100;
    
    // Get price history
    if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
    const prices = priceHistory.get(symbol);
    prices.push(currentPrice);
    if (prices.length > 50) prices.shift();
    
    // Calculate indicators
    const rsi = calculateRSI(prices);
    const vwap = historicalData ? historicalData.close : currentPrice;
    const priceVsVwap = ((currentPrice - vwap) / vwap) * 100;
    
    // Tape pressure (simplified)
    const tape = { buyPressure: obi > 0 ? 0.6 : 0.4, sellPressure: obi < 0 ? 0.6 : 0.4 };
    
    // Momentum
    const momentum = {
        direction: obi > 0 ? 'BULLISH' : 'BEARISH',
        confidence: Math.min(100, Math.abs(obi) * 2)
    };
    
    // Calculate quality scores for both directions
    const longQuality = calculateQualityScore('LONG', obi, tape, currentPrice, vwap, momentum, rsi);
    const shortQuality = calculateQualityScore('SHORT', obi, tape, currentPrice, vwap, momentum, rsi);
    
    // Return the higher quality score
    return Math.max(longQuality, shortQuality);
}

// API Routes
app.get('/api/opportunities', (req, res) => {
    // Sort by composite score (best first), then by changePercent
    const sorted = [...opportunities].sort((a, b) => {
        if (b.compositeScore !== a.compositeScore) {
            return b.compositeScore - a.compositeScore;
        }
        return Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0);
    });
    
    res.json({
        count: sorted.length,
        opportunities: sorted
    });
});

app.get('/api/stocks', (req, res) => {
    // Get all stocks with their data and opportunity scores
    const allStocks = Array.from(stockData.entries()).map(([symbol, data]) => {
        const historical = historicalData.get(symbol) || null;
        const opportunityScore = calculateOpportunityScore(symbol, data, historical);
        
        return {
            symbol,
            ltp: data.ltp || 0,
            volume: data.volume || 0,
            change: data.change || 0,
            changePercent: data.changePercent || 0,
            open: historical?.open || data.open || 0,
            high: historical?.high || data.high || 0,
            low: historical?.low || data.low || 0,
            close: historical?.close || data.close || 0,
            opportunityScore,
            timestamp: data.timestamp || Date.now(),
            hasLiveData: !!data.ltp
        };
    });
    
    // Sort by opportunity score (best first)
    allStocks.sort((a, b) => b.opportunityScore - a.opportunityScore);
    
    res.json({ 
        stocks: allStocks,
        total: allStocks.length,
        withLiveData: allStocks.filter(s => s.hasLiveData).length
    });
});

// API endpoint to view after-market analysis
app.get('/api/analysis/:date?', async (req, res) => {
    try {
        const { runAfterMarketAnalysis } = require('./after_market_analysis');
        const date = req.params.date || new Date().toISOString().split('T')[0];
        const analysis = await runAfterMarketAnalysis(date);
        
        if (!analysis) {
            res.status(404).json({
                error: 'No analysis found for this date',
                date
            });
            return;
        }
        
        res.json({
            date: analysis.date,
            summary: {
                totalSnapshots: analysis.totalSnapshots,
                stocksAnalyzed: analysis.marketStats.totalStocks,
                opportunitiesFound: analysis.opportunitiesFound,
                avgQuality: Math.round(analysis.performance.avgQuality * 10) / 10,
                avgNetProfit: Math.round(analysis.performance.avgNetProfit * 100) / 100
            },
            topOpportunities: analysis.topOpportunities,
            marketStats: analysis.marketStats,
            performance: analysis.performance
        });
    } catch (error) {
        console.error('Error in /api/analysis:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

app.get('/api/all-stocks', async (req, res) => {
    try {
        // Return all stocks from universe with their status
        // If universe is empty, return empty array (will be populated when API works)
        if (STOCK_UNIVERSE.length === 0) {
            res.json({
                stocks: [],
                total: 0,
                withOpportunities: 0,
                withLiveData: 0,
                withHistoricalData: 0,
                message: 'No stocks loaded yet. Server is initializing. Please wait a few seconds and refresh.'
            });
            return;
        }
    
    const allStocks = STOCK_UNIVERSE.map(inst => {
        const marketData = stockData.get(inst.symbol);
        const historical = historicalData.get(inst.symbol) || null;
        
        // Calculate opportunity score (works with or without live data)
        const opportunityScore = calculateOpportunityScore(inst.symbol, marketData, historical);
        const opp = opportunities.find(o => o.symbol === inst.symbol);
        
        // Use live data if available, otherwise use historical
        const ltp = marketData?.ltp || historical?.close || 0;
        const open = historical?.open || marketData?.open || 0;
        const high = historical?.high || marketData?.high || 0;
        const low = historical?.low || marketData?.low || 0;
        const close = historical?.close || marketData?.close || 0;
        const volume = historical?.volume || marketData?.volume || 0;
        
        // Calculate change from yesterday's close
        let change = 0;
        let changePercent = 0;
        if (marketData?.ltp && historical?.close) {
            change = marketData.ltp - historical.close;
            changePercent = (change / historical.close) * 100;
        } else if (marketData?.change !== undefined) {
            change = marketData.change;
            changePercent = marketData.changePercent || 0;
        } else if (historical) {
            // Use yesterday's movement
            change = historical.close - historical.open;
            changePercent = (change / historical.open) * 100;
        }
        
        return {
            symbol: inst.symbol,
            securityId: inst.securityId,
            exchangeSegment: inst.exchangeSegment,
            ltp,
            open,
            high,
            low,
            close,
            volume,
            change,
            changePercent,
            opportunityScore,
            hasOpportunity: !!opp,
            opportunity: opp || null,
            hasLiveData: !!marketData,
            hasHistoricalData: !!historical,
            timestamp: marketData?.timestamp || Date.now()
        };
    });
    
    // Sort by opportunity score (best first), then by hasOpportunity
    allStocks.sort((a, b) => {
        if (a.hasOpportunity && !b.hasOpportunity) return -1;
        if (!a.hasOpportunity && b.hasOpportunity) return 1;
        return b.opportunityScore - a.opportunityScore;
    });
    
        res.json({
            stocks: allStocks,
            total: allStocks.length,
            withOpportunities: allStocks.filter(s => s.hasOpportunity).length,
            withLiveData: allStocks.filter(s => s.hasLiveData).length,
            withHistoricalData: allStocks.filter(s => s.hasHistoricalData).length
        });
    } catch (error) {
        console.error('Error in /api/all-stocks:', error);
        res.status(500).json({
            stocks: [],
            total: 0,
            error: error.message
        });
    }
});

// Fetch historical OHLCV data for all stocks
// NOTE: Limited to prevent crashes with large universes
async function fetchAllHistoricalData() {
    const maxStocks = 500; // Limit to first 500 stocks to prevent crashes
    const stocksToFetch = STOCK_UNIVERSE.slice(0, maxStocks);
    
    console.log(`📊 Fetching historical data for ${stocksToFetch.length} stocks (limited to prevent crashes)...\n`);
    
    let fetched = 0;
    let failed = 0;
    const batchSize = 10; // Reduced batch size to avoid rate limiting
    
    for (let i = 0; i < stocksToFetch.length; i += batchSize) {
        const batch = stocksToFetch.slice(i, i + batchSize);
        
        try {
            await Promise.all(batch.map(async (inst) => {
                try {
                    const histData = await fetchHistoricalData(inst.symbol, inst.securityId, inst.exchangeSegment);
                    if (histData && histData.close > 0) {
                        historicalData.set(inst.symbol, histData);
                        fetched++;
                    } else {
                        failed++;
                    }
                } catch (error) {
                    failed++;
                    // Don't log every error to avoid spam
                }
            }));
        } catch (error) {
            console.error(`   ❌ Batch error: ${error.message}`);
            failed += batch.length;
        }
        
        // Longer delay between batches to avoid rate limiting
        if (i + batchSize < stocksToFetch.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        if ((i + batchSize) % 100 === 0 || i + batchSize >= stocksToFetch.length) {
            console.log(`   Progress: ${i + batchSize}/${stocksToFetch.length} | Fetched: ${fetched} | Failed: ${failed}`);
        }
    }
    
    console.log(`\n✅ Loaded historical data for ${fetched}/${stocksToFetch.length} stocks`);
    console.log(`   Failed: ${failed} stocks (will use live data when available)\n`);
    if (STOCK_UNIVERSE.length > maxStocks) {
        console.log(`   ⚠️  Note: Only fetched for first ${maxStocks} stocks (out of ${STOCK_UNIVERSE.length} total)`);
        console.log(`   💡 Remaining stocks will use live data when available\n`);
    }
}

// Initialize and start connections
async function initialize() {
    console.log('\n🚀 Initializing Universal Stock Terminal...\n');
    console.log(`📊 Capacity: ${MAX_CONNECTIONS} connections × ${MAX_INSTRUMENTS_PER_CONNECTION} instruments = ${TOTAL_CAPACITY} total\n`);
    
    // Check market status
    const marketStatus = isMarketOpen() ? '🟢 OPEN' : '🔴 CLOSED';
    console.log(`📅 Market Status: ${marketStatus}\n`);
    
    try {
        // Fetch ALL cash equities and indices
        await fetchAllInstruments();
        
        if (STOCK_UNIVERSE.length === 0) {
            console.log('❌ No instruments loaded. Cannot proceed.');
            console.log('   💡 This might be normal if CSV file is missing. Server will start but no data will be received.\n');
            return;
        }
        
        console.log(`\n🔌 Establishing ${MAX_CONNECTIONS} WebSocket connections...\n`);
        
        // Connect to all WebSockets (even if market is closed, connections will be established)
        // They will handle reconnection when market opens
        connectAllLiveFeeds();
        connectAllDepths();
        
        console.log('\n✅ Stock Terminal initialized!\n');
        console.log(`📈 Monitoring ${STOCK_UNIVERSE.length} instruments across ${MAX_CONNECTIONS} connections\n`);
        
        if (!isMarketOpen()) {
            console.log('⚠️  Market is currently closed. WebSocket connections established but may not receive data.');
            console.log('   Connections will automatically reconnect when market opens.\n');
        }
    } catch (error) {
        console.error('\n❌ ERROR DURING INITIALIZATION:');
        console.error(`   ${error.message}`);
        console.error(`   Stack: ${error.stack}\n`);
        console.log('   💡 Server will continue running but may not receive data.\n');
    }
}

// Connect to dynamic 200-level depth (single instrument on-demand)
function connectDynamicDepth200(securityId, exchangeSegment) {
    // Close existing connection if any
    if (dynamicDepth200WS && dynamicDepth200WS.readyState === WebSocket.OPEN) {
        dynamicDepth200WS.close();
    }
    
    const wsUrl = `${DHAN_CONFIG.DEPTH_200_WS}?token=${DHAN_CONFIG.ACCESS_TOKEN}&clientId=${DHAN_CONFIG.CLIENT_ID}&authType=2`;
    dynamicDepth200WS = new WebSocket(wsUrl);
    
    dynamicDepth200WS.on('open', () => {
        console.log(`✅ Dynamic 200-Level Depth Connection established for ${securityId}`);
        
        // Subscribe to single instrument
        const subscribeMsg = {
            RequestCode: 23,
            InstrumentCount: 1,
            InstrumentList: [{
                ExchangeSegment: exchangeSegment,
                SecurityId: securityId
            }]
        };
        
        dynamicDepth200WS.send(JSON.stringify(subscribeMsg));
        currentDepthSubscription = { securityId, exchangeSegment };
        console.log(`   📡 Subscribed to 200-level depth for SecurityId: ${securityId}\n`);
    });
    
    dynamicDepth200WS.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            try {
                const depthData = parseDepth200Packet(data);
                if (depthData) {
                    const symbol = getSymbolFromSecurityId(depthData.securityId);
                    if (symbol) {
                        // Store depth data
                        const existing = depth200Data.get(symbol) || { bids: [], asks: [] };
                        if (depthData.isBid) {
                            existing.bids = depthData.depth;
                        } else {
                            existing.asks = depthData.depth;
                        }
                        existing.timestamp = depthData.timestamp;
                        depth200Data.set(symbol, existing);
                        
                        // Analyze depth for trading advantages
                        if (existing.bids.length > 0 && existing.asks.length > 0) {
                            const analysis = analyzeDepth200(symbol, existing);
                            if (analysis) {
                                // Store analysis with stock data
                                const stock = stockData.get(symbol) || {};
                                stock.depth200 = analysis;
                                stockData.set(symbol, stock);
                                
                                // Broadcast depth insights to WebSocket clients
                                broadcastUpdate('DEPTH200_UPDATE', {
                                    symbol,
                                    securityId: depthData.securityId.toString(),
                                    bids: existing.bids,
                                    asks: existing.asks,
                                    ...analysis
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                if (depth200Data.size < 10) {
                    console.warn(`⚠️  Error parsing dynamic depth200 data: ${error.message}`);
                }
            }
        }
    });
    
    dynamicDepth200WS.on('error', (error) => {
        console.error(`❌ Dynamic 200-Level Depth Connection error:`, error.message);
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.log(`   ⚠️  Connection refused or timed out. This is normal when market is closed.`);
        }
    });
    
    dynamicDepth200WS.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'Unknown';
        console.log(`⚠️ Dynamic 200-Level Depth Connection closed (code: ${code}, reason: ${reasonStr})`);
        currentDepthSubscription = null;
    });
    
    return dynamicDepth200WS;
}

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Send current opportunities
    ws.send(JSON.stringify({
        type: 'INIT',
        data: {
            opportunities: opportunities.sort((a, b) => b.quality - a.quality),
            stocks: Array.from(stockData.keys())
        }
    }));
    
    // Handle client messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'subscribe_depth') {
                const { security_id, exchange_segment, symbol } = data;
                
                // Find the instrument
                let instrument = null;
                if (security_id) {
                    instrument = STOCK_UNIVERSE.find(inst => inst.securityId === security_id.toString());
                } else if (symbol) {
                    instrument = STOCK_UNIVERSE.find(inst => inst.symbol === symbol.toUpperCase());
                }
                
                if (instrument) {
                    console.log(`📡 Client requested depth subscription for ${instrument.symbol} (SecurityId: ${instrument.securityId})`);
                    
                    // Connect to dynamic depth feed
                    connectDynamicDepth200(instrument.securityId, instrument.exchangeSegment);
                    
                    // Send confirmation
                    ws.send(JSON.stringify({
                        type: 'DEPTH_SUBSCRIBED',
                        data: {
                            symbol: instrument.symbol,
                            securityId: instrument.securityId,
                            exchangeSegment: instrument.exchangeSegment
                        }
                    }));
                } else {
                    console.warn(`⚠️  Depth subscription requested for unknown instrument: ${JSON.stringify(data)}`);
                    ws.send(JSON.stringify({
                        type: 'DEPTH_ERROR',
                        error: 'Instrument not found'
                    }));
                }
            } else if (data.type === 'unsubscribe_depth') {
                console.log(`📡 Client requested depth unsubscription`);
                if (dynamicDepth200WS && dynamicDepth200WS.readyState === WebSocket.OPEN) {
                    dynamicDepth200WS.close();
                }
                currentDepthSubscription = null;
                
                ws.send(JSON.stringify({
                    type: 'DEPTH_UNSUBSCRIBED'
                }));
            }
        } catch (error) {
            console.warn(`⚠️  Error processing client message: ${error.message}`);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    
    ws.on('error', (error) => {
        console.warn(`⚠️  Client WebSocket error: ${error.message}`);
    });
});

const PORT = process.env.PORT || 3000;

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:');
    console.error(`   ${error.message}`);
    console.error(`   Stack: ${error.stack}\n`);
    console.log('   ⚠️  Server will continue running, but some features may not work.\n');
    // Don't exit - let the server continue
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ UNHANDLED REJECTION:');
    console.error(`   ${reason}`);
    console.log('   ⚠️  Server will continue running, but some features may not work.\n');
    // Don't exit - let the server continue
});

// Data collection and after-market analysis
let snapshotInterval = null;
let lastSnapshotTime = 0;

// Save periodic snapshots during market hours
function startSnapshotCollection() {
    if (snapshotInterval) return; // Already running
    
    snapshotInterval = setInterval(() => {
        if (!isMarketOpen()) {
            // Market closed - check if we should run after-market analysis
            if (checkMarketClose()) {
                console.log('\n📊 Market closed! Running after-market analysis...\n');
                setTimeout(async () => {
                    try {
                        const analysis = await runAfterMarketAnalysis();
                        if (analysis) {
                            console.log('\n✅ After-market analysis complete!');
                            console.log(`   📊 ${analysis.opportunitiesFound} opportunities found`);
                            console.log(`   📈 ${analysis.marketStats.totalStocks} stocks analyzed\n`);
                        }
                    } catch (error) {
                        console.error('❌ Error running after-market analysis:', error.message);
                    }
                }, 5000); // Wait 5 seconds after market close
            }
            return;
        }
        
        // Save snapshot every minute during market hours
        const now = Date.now();
        if (now - lastSnapshotTime >= ANALYSIS_CONFIG.SNAPSHOT_INTERVAL) {
            try {
                // Prepare stock data with indicators
                const stockDataWithIndicators = new Map();
                stockData.forEach((data, symbol) => {
                    if (data.ltp) {
                        const prices = priceHistory.get(symbol) || [];
                        const rsi = prices.length > 14 ? calculateRSI(prices) : 0;
                        const vwap = calculateVWAP(prices, prices.map(() => data.volume || 1));
                        const obi = data.obi || 0;
                        
                        stockDataWithIndicators.set(symbol, {
                            ...data,
                            rsi,
                            vwap,
                            obi,
                            quality: calculateOpportunityScore(symbol, data, historicalData.get(symbol))
                        });
                    }
                });
                
                const snapshot = createCompactSnapshot(stockDataWithIndicators, opportunities, now);
                saveSnapshot(snapshot);
                lastSnapshotTime = now;
            } catch (error) {
                console.warn(`⚠️  Error saving snapshot: ${error.message}`);
            }
        }
    }, 30000); // Check every 30 seconds
    
    console.log('💾 Snapshot collection started (saves every 1 minute during market hours)');
}

// Stop snapshot collection
function stopSnapshotCollection() {
    if (snapshotInterval) {
        clearInterval(snapshotInterval);
        snapshotInterval = null;
        console.log('💾 Snapshot collection stopped');
    }
}

server.listen(PORT, async () => {
    console.log(`\n🌐 UNIVERSAL STOCK TERMINAL SERVER`);
    console.log(`   Running on http://localhost:${PORT}`);
    console.log(`   Terminal UI: http://localhost:${PORT}/stock_terminal.html\n`);
    
    // Initialize WebSocket connections (with error handling)
    try {
        await initialize();
        
        // Start snapshot collection
        startSnapshotCollection();
    } catch (error) {
        console.error('\n❌ CRITICAL ERROR DURING INITIALIZATION:');
        console.error(`   ${error.message}`);
        console.error(`   Stack: ${error.stack}\n`);
        console.log('   ⚠️  Server is running but may not function properly.');
        console.log('   💡 Check the errors above and fix the issues.\n');
    }
});

