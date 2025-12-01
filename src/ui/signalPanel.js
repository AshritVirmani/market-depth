import { STRATEGY, NO_TRADE_WINDOW } from '../config.js';

/**
 * Signal Panel - Unified signal generator that synthesizes all edge factors
 * into clear, actionable trading signals
 */

export class SignalPanel {
    constructor() {
        this.currentSignal = null;
        this.position = 'FLAT'; // FLAT, LONG, SHORT
        this.entryPrice = 0;
        this.entryTime = null;
    }

    /**
     * Main signal generator - synthesizes all edge factors
     * @param {Object} marketData - Current market data (ltp, depth, trades)
     * @param {Object} analysis - Strategy analysis (walls, tape, vwap, sector, options)
     * @returns {Object} Signal object with type, action, confidence, and edge factors
     */
    generateSignal(marketData, analysis) {
        // If we have a position, check for exit signals
        if (this.position !== 'FLAT') {
            return this.checkExitSignal(marketData, analysis);
        }

        // Time Filter Check
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        if (timeStr >= NO_TRADE_WINDOW.start && timeStr < NO_TRADE_WINDOW.end) {
            return {
                type: 'WAIT',
                icon: '☕',
                title: 'LUNCH BREAK',
                action: ['No new entries'],
                reason: `Low volatility zone (${NO_TRADE_WINDOW.start} - ${NO_TRADE_WINDOW.end}). Avoid chop.`,
                edgeFactors: [],
                confidenceScore: 0,
                timestamp: timeStr
            };
        }

        // Otherwise, check for entry signals
        return this.checkEntrySignal(marketData, analysis);
    }

    /**
     * Check for entry signals (BUY or SHORT)
     */
    checkEntrySignal(marketData, analysis) {
        const edgeFactors = [];
        let confidence = 0;
        const ltp = marketData.ltp;

        // EDGE FACTOR 1: Support/Resistance Walls
        if (analysis.walls?.support) {
            edgeFactors.push({
                icon: '✅',
                text: `Support Wall at ${analysis.walls.support.price.toFixed(2)} (${analysis.walls.support.qty.toLocaleString()} qty)`,
                weight: 25
            });
            confidence += 25;
        }

        if (analysis.walls?.resistance) {
            edgeFactors.push({
                icon: '⚠️',
                text: `Resistance Wall at ${analysis.walls.resistance.price.toFixed(2)} (${analysis.walls.resistance.qty.toLocaleString()} qty)`,
                weight: -10
            });
            confidence -= 10;
        }

        // EDGE FACTOR 2: Tape Analysis
        if (analysis.tape?.bullish) {
            const buyPressure = (analysis.tape.buyPressure * 100).toFixed(0);
            edgeFactors.push({
                icon: '✅',
                text: `Bullish Tape (${buyPressure}% buyers)`,
                weight: 20
            });
            confidence += 20;
        } else if (analysis.tape?.bearish) {
            const sellPressure = (analysis.tape.sellPressure * 100).toFixed(0);
            edgeFactors.push({
                icon: '⚠️',
                text: `Bearish Tape (${sellPressure}% sellers)`,
                weight: -15
            });
            confidence -= 15;
        }

        // EDGE FACTOR 3: VWAP Confluence
        if (analysis.vwap?.confluence) {
            edgeFactors.push({
                icon: '✅',
                text: `VWAP Confluence (${analysis.vwap.price.toFixed(2)})`,
                weight: 20
            });
            confidence += 20;
        }

        // EDGE FACTOR 4: Sector Sentiment
        if (analysis.sector?.bullish) {
            edgeFactors.push({
                icon: '✅',
                text: `Sector Bullish (+${analysis.sector.score.toFixed(1)} score)`,
                weight: 15
            });
            confidence += 15;
        } else if (analysis.sector?.bearish) {
            edgeFactors.push({
                icon: '⚠️',
                text: `Sector Bearish (${analysis.sector.score.toFixed(1)} score)`,
                weight: -10
            });
            confidence -= 10;
        }

        // EDGE FACTOR 5: Options Chain Activity
        if (analysis.options?.callBuying) {
            edgeFactors.push({
                icon: '✅',
                text: `Call Buying (OI +${analysis.options.oiChange.toLocaleString()})`,
                weight: 20
            });
            confidence += 20;
        } else if (analysis.options?.putBuying) {
            edgeFactors.push({
                icon: '⚠️',
                text: `Put Buying (OI +${analysis.options.oiChange.toLocaleString()})`,
                weight: -15
            });
            confidence -= 15;
        }

        // EDGE FACTOR 6: Relative Volume (RVOL) - Backtest Confirmation
        if (analysis.rvol > 1.5) {
            edgeFactors.push({
                icon: '🔥',
                text: `High Volume (RVOL ${analysis.rvol.toFixed(1)}x)`,
                weight: 15
            });
            confidence += 15;
        } else if (analysis.rvol < 0.5) {
            edgeFactors.push({
                icon: '💤',
                text: `Low Volume (RVOL ${analysis.rvol.toFixed(1)}x)`,
                weight: -10
            });
            confidence -= 10;
        }

        // EDGE FACTOR 7: PCR Trend (Smart Money) - Stock Specific Weighting
        // HDFC: Strong Edge (+10) - The Whale 🐳
        // SBIN: No Edge (0) - The Beast 🐂 (Trade Price)
        // ICICI: No Edge (0) - The Trap ⚠️ (Avoid Options)
        let pcrWeight = 0;
        if (state.symbol.includes('HDFCBANK')) pcrWeight = 10;

        if (pcrWeight > 0) {
            if (analysis.pcrTrend > 0.05) {
                edgeFactors.push({
                    icon: '🐳',
                    text: `Smart Money Bullish (PCR +${(analysis.pcrTrend * 100).toFixed(0)}%)`,
                    weight: pcrWeight
                });
                confidence += pcrWeight;
            } else if (analysis.pcrTrend < -0.05) {
                edgeFactors.push({
                    icon: '🐻',
                    text: `Smart Money Bearish (PCR ${(analysis.pcrTrend * 100).toFixed(0)}%)`,
                    weight: -pcrWeight
                });
                confidence -= pcrWeight;
            }
        }

        // Generate BUY signal if confidence >= 60
        if (confidence >= STRATEGY.MIN_CONFIDENCE) {
            // Calculate smart limit order prices
            const limitOrders = this.calculateLimitOrderPrices(marketData, analysis, 'BUY');

            return {
                type: 'BUY',
                icon: '🟢',
                title: 'BUY SIGNAL',
                price: ltp,
                confidence: this.getConfidenceLabel(confidence),
                confidenceScore: confidence,
                action: [
                    `Place limit order at ₹${limitOrders.optimal} (recommended)`,
                    `Or market order at ₹${limitOrders.market}`,
                    'Hold until exit signal'
                ],
                limitOrders: {
                    aggressive: limitOrders.aggressive,
                    optimal: limitOrders.optimal,
                    conservative: limitOrders.conservative,
                    market: limitOrders.market,
                    reasoning: limitOrders.reasoning
                },
                edgeFactors,
                targets: {
                    exit: (ltp * (1 + STRATEGY.TAKE_PROFIT_PCT / 100)).toFixed(2),
                    stop: (ltp * (1 - STRATEGY.STOP_LOSS_PCT / 100)).toFixed(2)
                },
                timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false })
            };
        }

        // Generate SHORT signal if confidence <= -60
        if (confidence <= -STRATEGY.MIN_CONFIDENCE) {
            // Calculate smart limit order prices
            const limitOrders = this.calculateLimitOrderPrices(marketData, analysis, 'SHORT');

            return {
                type: 'SHORT',
                icon: '🔴',
                title: 'SHORT SIGNAL',
                price: ltp,
                confidence: this.getConfidenceLabel(Math.abs(confidence)),
                confidenceScore: Math.abs(confidence),
                action: [
                    `Place limit order at ₹${limitOrders.optimal} (recommended)`,
                    `Or market order at ₹${limitOrders.market}`,
                    'Hold until exit signal'
                ],
                limitOrders: {
                    aggressive: limitOrders.aggressive,
                    optimal: limitOrders.optimal,
                    conservative: limitOrders.conservative,
                    market: limitOrders.market,
                    reasoning: limitOrders.reasoning
                },
                edgeFactors,
                targets: {
                    exit: (ltp * (1 - STRATEGY.TAKE_PROFIT_PCT / 100)).toFixed(2),
                    stop: (ltp * (1 + STRATEGY.STOP_LOSS_PCT / 100)).toFixed(2)
                },
                timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false })
            };
        }

        // No clear edge - WAIT signal
        return {
            type: 'WAIT',
            icon: '⚪',
            title: 'NO TRADE',
            action: ['Stay flat'],
            reason: confidence > 0
                ? `Bullish bias but not strong enough (need ${STRATEGY.MIN_CONFIDENCE}+ confidence)`
                : confidence < 0
                    ? `Bearish bias but not strong enough (need ${STRATEGY.MIN_CONFIDENCE}+ confidence)`
                    : 'Market neutral, no clear edge',
            edgeFactors,
            confidenceScore: Math.abs(confidence),
            watch: {
                support: analysis.zones?.demand?.[0]?.price?.toFixed(2),
                resistance: analysis.zones?.supply?.[0]?.price?.toFixed(2)
            },
            timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false })
        };
    }

    /**
     * Check for exit signals (when in position)
     */
    checkExitSignal(marketData, analysis) {
        const ltp = marketData.ltp;
        const pnl = this.position === 'LONG'
            ? ltp - this.entryPrice
            : this.entryPrice - ltp;
        const pnlPercent = (pnl / this.entryPrice) * 100;

        // Check for exit conditions
        const exitReasons = [];

        // 1. Take Profit
        if (pnlPercent >= STRATEGY.TAKE_PROFIT_PCT) {
            exitReasons.push(`Target reached (+${STRATEGY.TAKE_PROFIT_PCT}%)`);
        }

        // 2. Stop Loss
        if (pnlPercent <= -STRATEGY.STOP_LOSS_PCT) {
            exitReasons.push(`Stop loss hit (-${STRATEGY.STOP_LOSS_PCT}%)`);
        }

        // 3. Tape Reversal
        if (this.position === 'LONG' && analysis.tape?.bearish && analysis.tape.sellPressure > 0.75) {
            exitReasons.push('Strong selling pressure detected');
        }
        if (this.position === 'SHORT' && analysis.tape?.bullish && analysis.tape.buyPressure > 0.75) {
            exitReasons.push('Strong buying pressure detected');
        }

        // 4. Sector Reversal
        if (this.position === 'LONG' && analysis.sector?.bearish && analysis.sector.score < -2) {
            exitReasons.push('Sector turned bearish');
        }
        if (this.position === 'SHORT' && analysis.sector?.bullish && analysis.sector.score > 2) {
            exitReasons.push('Sector turned bullish');
        }

        // Generate EXIT signal if any exit condition met
        if (exitReasons.length > 0) {
            return {
                type: 'EXIT',
                icon: pnl >= 0 ? '🟢' : '🔴',
                title: 'EXIT NOW',
                price: ltp,
                currentPnL: pnl.toFixed(2),
                currentPnLPercent: pnlPercent.toFixed(2),
                action: [
                    this.position === 'LONG' ? 'Sell at market price' : 'Cover short at market price',
                    'Exit immediately'
                ],
                reasons: exitReasons,
                timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false })
            };
        }

        // Otherwise, HOLD signal
        return {
            type: 'HOLD',
            icon: '⏳',
            title: 'HOLD POSITION',
            position: this.position,
            entryPrice: this.entryPrice.toFixed(2),
            currentPrice: ltp.toFixed(2),
            currentPnL: pnl.toFixed(2),
            currentPnLPercent: pnlPercent.toFixed(2),
            action: ['Continue holding'],
            reason: 'No exit signals yet',
            watch: {
                target: this.position === 'LONG'
                    ? (this.entryPrice * (1 + STRATEGY.TAKE_PROFIT_PCT / 100)).toFixed(2)
                    : (this.entryPrice * (1 - STRATEGY.TAKE_PROFIT_PCT / 100)).toFixed(2),
                stop: this.position === 'LONG'
                    ? (this.entryPrice * (1 - STRATEGY.STOP_LOSS_PCT / 100)).toFixed(2)
                    : (this.entryPrice * (1 + STRATEGY.STOP_LOSS_PCT / 100)).toFixed(2)
            },
            timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false })
        };
    }

    /**
   * Calculate smart limit order prices based on order book
   * @param {Object} marketData - Current market data
   * @param {Object} analysis - Strategy analysis
   * @param {String} direction - 'BUY' or 'SHORT'
   * @returns {Object} Limit order prices with reasoning
   */
    calculateLimitOrderPrices(marketData, analysis, direction) {
        const ltp = marketData.ltp;
        const bids = marketData.bids || [];
        const asks = marketData.asks || [];

        if (direction === 'BUY') {
            // For BUY: We want to buy at the lowest price possible
            const bestBid = bids[0]?.price || ltp;
            const bestAsk = asks[0]?.price || ltp;
            const spread = bestAsk - bestBid;

            // Find support wall (if any)
            const supportWall = analysis.walls?.support;

            // AGGRESSIVE: Join the bid (might not get filled)
            const aggressive = bestBid.toFixed(2);

            // OPTIMAL: Between bid and ask, closer to support wall if present
            let optimal;
            if (supportWall && Math.abs(supportWall.price - ltp) < ltp * 0.002) {
                // If near support wall, place order at wall price
                optimal = supportWall.price.toFixed(2);
            } else {
                // Otherwise, place order at mid-point or slightly above bid
                optimal = (bestBid + spread * 0.3).toFixed(2);
            }

            // CONSERVATIVE: At or slightly above ask (guaranteed fill)
            const conservative = (bestAsk + 0.05).toFixed(2);

            // MARKET: Current ask price
            const market = bestAsk.toFixed(2);

            // Reasoning
            let reasoning = [];
            if (supportWall) {
                reasoning.push(`Support wall at ₹${supportWall.price.toFixed(2)} (${supportWall.qty.toLocaleString()} qty)`);
            }
            reasoning.push(`Spread: ₹${spread.toFixed(2)} (${((spread / ltp) * 100).toFixed(2)}%)`);
            reasoning.push(`Optimal price saves ₹${(parseFloat(market) - parseFloat(optimal)).toFixed(2)} vs market`);

            return {
                aggressive,
                optimal,
                conservative,
                market,
                reasoning: reasoning.join(' • ')
            };

        } else {
            // For SHORT: We want to sell at the highest price possible
            const bestBid = bids[0]?.price || ltp;
            const bestAsk = asks[0]?.price || ltp;
            const spread = bestAsk - bestBid;

            // Find resistance wall (if any)
            const resistanceWall = analysis.walls?.resistance;

            // AGGRESSIVE: Join the ask (might not get filled)
            const aggressive = bestAsk.toFixed(2);

            // OPTIMAL: Between bid and ask, closer to resistance wall if present
            let optimal;
            if (resistanceWall && Math.abs(resistanceWall.price - ltp) < ltp * 0.002) {
                // If near resistance wall, place order at wall price
                optimal = resistanceWall.price.toFixed(2);
            } else {
                // Otherwise, place order at mid-point or slightly below ask
                optimal = (bestAsk - spread * 0.3).toFixed(2);
            }

            // CONSERVATIVE: At or slightly below bid (guaranteed fill)
            const conservative = (bestBid - 0.05).toFixed(2);

            // MARKET: Current bid price
            const market = bestBid.toFixed(2);

            // Reasoning
            let reasoning = [];
            if (resistanceWall) {
                reasoning.push(`Resistance wall at ₹${resistanceWall.price.toFixed(2)} (${resistanceWall.qty.toLocaleString()} qty)`);
            }
            reasoning.push(`Spread: ₹${spread.toFixed(2)} (${((spread / ltp) * 100).toFixed(2)}%)`);
            reasoning.push(`Optimal price gains ₹${(parseFloat(optimal) - parseFloat(market)).toFixed(2)} vs market`);

            return {
                aggressive,
                optimal,
                conservative,
                market,
                reasoning: reasoning.join(' • ')
            };
        }
    }

    /**
     * Get confidence label based on score
     */
    getConfidenceLabel(score) {
        if (score >= 80) return '⭐⭐⭐⭐⭐ VERY HIGH';
        if (score >= 60) return '⭐⭐⭐⭐ HIGH';
        if (score >= 40) return '⭐⭐⭐ MEDIUM';
        if (score >= 20) return '⭐⭐ LOW';
        return '⭐ VERY LOW';
    }

    /**
     * Update position (called when user executes trade)
     */
    enterPosition(type, price) {
        this.position = type; // 'LONG' or 'SHORT'
        this.entryPrice = price;
        this.entryTime = new Date();
    }

    /**
     * Exit position (called when user exits trade)
     */
    exitPosition() {
        this.position = 'FLAT';
        this.entryPrice = 0;
        this.entryTime = null;
    }

    /**
     * Get current position info
     */
    getPositionInfo() {
        return {
            position: this.position,
            entryPrice: this.entryPrice,
            entryTime: this.entryTime
        };
    }
}
