import { KNOWLEDGE_BASE } from '../data/knowledge';

const INITIAL_BALANCE = 10000; // ₹10,000 Budget

// Helper to get latest portfolio safely
async function getLatestPortfolio() {
    return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['DHAN_PAPER_PORTFOLIO'], (result) => {
                if (result.DHAN_PAPER_PORTFOLIO) {
                    resolve(result.DHAN_PAPER_PORTFOLIO);
                } else {
                    // Initialize if empty
                    resolve({
                        balance: INITIAL_BALANCE, // Cash Available
                        equity: INITIAL_BALANCE,  // Total Account Value
                        positions: [],
                        journal: []
                    });
                }
            });
        } else {
            // Fallback for non-extension environment
            resolve({
                balance: INITIAL_BALANCE,
                equity: INITIAL_BALANCE,
                positions: [],
                journal: []
            });
        }
    });
}

async function savePortfolio(portfolio) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ 'DHAN_PAPER_PORTFOLIO': portfolio });
    }
}

// We expose a getter for the logger, but it might be slightly stale.
// The logger should ideally be async too, but for now we'll cache the last known state.
let cachedPortfolio = { balance: INITIAL_BALANCE, positions: [], journal: [] };

export function getPortfolio() {
    return cachedPortfolio;
}

export async function executePaperTrade(action, symbol, price, reason, time) {
    const portfolio = await getLatestPortfolio();
    cachedPortfolio = portfolio; // Update cache

    // 1. UPDATE OPEN POSITIONS (Check SL/TP + Advanced Exit Rules)
    if (action === 'UPDATE') {
        let updated = false;
        portfolio.positions.forEach((pos, index) => {
            if (pos.symbol === symbol) {
                // 🔧 FIX: Handle SHORT positions (inverse PnL calculation)
                const isShort = pos.positionType === 'SHORT';
                const pnlPct = isShort 
                    ? ((pos.entryPrice - price) / pos.entryPrice) * 100  // For SHORT: profit when price goes down
                    : ((price - pos.entryPrice) / pos.entryPrice) * 100;  // For LONG: profit when price goes up
                
                pos.currentPrice = price;
                pos.pnl = isShort 
                    ? (pos.entryPrice - price) * pos.qty  // For SHORT: profit when price goes down
                    : (price - pos.entryPrice) * pos.qty; // For LONG: profit when price goes up
                pos.pnlPct = pnlPct;

                // Initialize tracking if not exists
                if (!pos.highestPrice) pos.highestPrice = pos.entryPrice;
                if (!pos.lowestPrice) pos.lowestPrice = pos.entryPrice;
                if (!pos.priceHistory) pos.priceHistory = [];
                if (!pos.lastUpdateTime) pos.lastUpdateTime = pos.entryTime;

                // Update highest/lowest price for trailing stop
                if (isShort) {
                    // For SHORT: track lowest price (best for us)
                    if (price < pos.lowestPrice) {
                        pos.lowestPrice = price;
                    }
                } else {
                    // For LONG: track highest price (best for us)
                    if (price > pos.highestPrice) {
                        pos.highestPrice = price;
                    }
                }

                // Track price history for parabolic detection
                pos.priceHistory.push({ price, time });
                // Keep only last 60 seconds of history
                const oneMinAgo = time - 60000;
                pos.priceHistory = pos.priceHistory.filter(h => h.time > oneMinAgo);

                // ─────────────────────────────────────────────────────────────────────────
                // 🛑 DISASTER MANAGEMENT (Check FIRST - No Exceptions)
                // ─────────────────────────────────────────────────────────────────────────
                // Hard Stop at -3% (Emergency Exit)
                if (pnlPct <= -3.0) {
                    closeTrade(portfolio, index, price, `🚨 HARD STOP: -3% Disaster Exit (${pnlPct.toFixed(2)}%)`, time);
                    updated = true;
                    return;
                }

                // ─────────────────────────────────────────────────────────────────────────
                // 📤 EXIT RULES (Greed Kills)
                // ─────────────────────────────────────────────────────────────────────────

                // 1. TRAILING STOP (1.5% from highest/lowest price)
                // Only activate if we're in profit (> 0.3%)
                if (pnlPct > 0.3) {
                    const trailingStopPct = 1.5; // 1.5% trailing stop
                    let trailingStopPrice;
                    
                    if (isShort) {
                        // For SHORT: trailing stop triggers if price rises 1.5% from lowest
                        trailingStopPrice = pos.lowestPrice * (1 + trailingStopPct / 100);
                        if (price >= trailingStopPrice) {
                            closeTrade(portfolio, index, price, `📉 Trailing Stop (1.5%) Hit @ ${pnlPct.toFixed(2)}%`, time);
                            updated = true;
                            return;
                        }
                    } else {
                        // For LONG: trailing stop triggers if price falls 1.5% from highest
                        trailingStopPrice = pos.highestPrice * (1 - trailingStopPct / 100);
                        if (price <= trailingStopPrice) {
                            closeTrade(portfolio, index, price, `📉 Trailing Stop (1.5%) Hit @ ${pnlPct.toFixed(2)}%`, time);
                            updated = true;
                            return;
                        }
                    }
                }

                // 2. PARABOLIC KILL SWITCH (+5% in 1 minute)
                if (pos.priceHistory.length >= 2) {
                    const oldestPrice = pos.priceHistory[0].price;
                    const priceChangePct = ((price - oldestPrice) / oldestPrice) * 100;
                    
                    if (isShort) {
                        // For SHORT: kill if price rises +5% (bad for us)
                        if (priceChangePct >= 5.0) {
                            closeTrade(portfolio, index, price, `🚀 Parabolic Kill Switch: +${priceChangePct.toFixed(2)}% in 1min`, time);
                            updated = true;
                            return;
                        }
                    } else {
                        // For LONG: kill if price rises +5% (good, but take profit)
                        if (priceChangePct >= 5.0) {
                            closeTrade(portfolio, index, price, `🚀 Parabolic Kill Switch: +${priceChangePct.toFixed(2)}% in 1min`, time);
                            updated = true;
                            return;
                        }
                    }
                }

                // 3. "STUCK" RULE (Flat PnL for 5 minutes = Kill it)
                const holdDuration = time - pos.entryTime;
                const fiveMinutes = 5 * 60 * 1000; // 5 minutes in ms
                
                if (holdDuration > fiveMinutes && Math.abs(pnlPct) < 0.1) {
                    // Flat for 5+ minutes (within 0.1% of entry)
                    closeTrade(portfolio, index, price, `⏱️ Stuck Rule: Flat for 5+ minutes (${pnlPct.toFixed(2)}%)`, time);
                    updated = true;
                    return;
                }

                // 4. REGULAR STOP LOSS
                if (pnlPct <= -pos.slPct) {
                    closeTrade(portfolio, index, price, `🛑 SL Hit (${pnlPct.toFixed(2)}%)`, time);
                    updated = true;
                    return;
                }

                // 5. TARGET (1:2 Risk Reward)
                if (pnlPct >= pos.slPct * 2) {
                    closeTrade(portfolio, index, price, `🎯 Target Hit (${pnlPct.toFixed(2)}%)`, time);
                    updated = true;
                    return;
                }

                // Update last update time
                pos.lastUpdateTime = time;
            }
        });

        if (updated) await savePortfolio(portfolio);
        return;
    }

    // 2. ENTRY LOGIC
    if (action === 'BUY') {
        // 🛑 DISASTER MANAGEMENT: NO AVERAGING DOWN
        // If we already have a position, REJECT the new entry (prevent averaging)
        const existing = portfolio.positions.find(p => p.symbol === symbol);
        if (existing) {
            // Log rejection for debugging
            // console.log(`🚫 REJECTED: Already in ${symbol}. No averaging down allowed.`);
            return;
        }

        // Get Stock Personality
        const personality = KNOWLEDGE_BASE.PERSONALITIES[symbol] || { stopLossPct: 0.5 };
        const slPct = personality.stopLossPct || 0.5;

        // Position Sizing: TARGET ₹10,000 Exposure per trade
        // This ensures we capture the strategy performance even if cash is low.
        // We use "Paper Margin" (Negative Balance) if needed.
        const TARGET_EXPOSURE = 10000;
        const qty = Math.floor(TARGET_EXPOSURE / price);

        if (qty > 0) {
            const cost = qty * price;

            // Brokerage Estimation (0.05% approx for Intraday Equity)
            const brokerage = cost * 0.0005;

            // Check if we are using Margin
            const isMarginTrade = portfolio.balance < cost;
            const marginNote = isMarginTrade ? ' (Margin Used)' : '';

            portfolio.balance -= (cost + brokerage); // Deduct Cost + Brokerage

            const trade = {
                symbol,
                entryPrice: price,
                qty,
                slPct,
                entryTime: time,
                reason: reason + marginNote,
                status: 'OPEN',
                positionType: 'LONG', // Mark as LONG position
                pnl: -brokerage // Start with negative PnL due to entry cost
            };

            portfolio.positions.push(trade);
            portfolio.journal.push({ ...trade, status: 'ENTRY_LOG', comment: `Entered LONG ${symbol}${marginNote} - Brokerage: ₹${brokerage.toFixed(2)}` });

            await savePortfolio(portfolio);
        } else {
            // console.log(`⚠️ Insufficient Funds for ${symbol}. Balance: ${portfolio.balance}`);
        }
    }

    // 🔧 NEW: SHORT ENTRY LOGIC
    if (action === 'SHORT') {
        // 🛑 DISASTER MANAGEMENT: NO AVERAGING DOWN
        // If we already have a position, REJECT the new entry (prevent averaging)
        const existing = portfolio.positions.find(p => p.symbol === symbol);
        if (existing) {
            // Log rejection for debugging
            // console.log(`🚫 REJECTED: Already in ${symbol}. No averaging down allowed.`);
            return;
        }

        // Get Stock Personality
        const personality = KNOWLEDGE_BASE.PERSONALITIES[symbol] || { stopLossPct: 0.5 };
        const slPct = personality.stopLossPct || 0.5;

        // Position Sizing: TARGET ₹10,000 Exposure per trade
        const TARGET_EXPOSURE = 10000;
        const qty = Math.floor(TARGET_EXPOSURE / price);

        if (qty > 0) {
            const cost = qty * price; // For SHORT, we need margin (but in paper trading, we'll allow it)

            // Brokerage Estimation (0.05% approx for Intraday Equity)
            const brokerage = cost * 0.0005;

            // For SHORT: We receive cash when we sell, but need margin
            // In paper trading, we'll track it as negative balance or margin
            const isMarginTrade = true; // SHORT always uses margin
            const marginNote = ' (SHORT - Margin Used)';

            // For SHORT: We receive cash from sale, but need margin for position
            // Simplified: We don't add cash immediately (it's locked as margin)
            // We'll track it as margin used
            portfolio.balance -= brokerage; // Only deduct brokerage

            const trade = {
                symbol,
                entryPrice: price,
                qty,
                slPct,
                entryTime: time,
                reason: reason + marginNote,
                status: 'OPEN',
                positionType: 'SHORT', // Mark as SHORT position
                pnl: -brokerage // Start with negative PnL due to entry cost
            };

            portfolio.positions.push(trade);
            portfolio.journal.push({ ...trade, status: 'ENTRY_LOG', comment: `Entered SHORT ${symbol}${marginNote} - Brokerage: ₹${brokerage.toFixed(2)}` });

            await savePortfolio(portfolio);
        } else {
            // console.log(`⚠️ Insufficient Funds for ${symbol}. Balance: ${portfolio.balance}`);
        }
    }

    // 3. EXIT LOGIC (Signal Based)
    if (action === 'SELL') {
        const index = portfolio.positions.findIndex(p => p.symbol === symbol);
        if (index !== -1) {
            closeTrade(portfolio, index, price, `🔻 Signal Exit: ${reason}`, time);
            await savePortfolio(portfolio);
        }
    }
}

function closeTrade(portfolio, index, price, comment, time) {
    const pos = portfolio.positions[index];
    const isShort = pos.positionType === 'SHORT';
    const turnover = price * pos.qty;
    const brokerage = turnover * 0.0005; // Exit Brokerage

    // 🔧 FIX: Calculate PnL correctly for SHORT vs LONG
    let grossPnL;
    if (isShort) {
        // For SHORT: profit when price goes down (entry - exit)
        grossPnL = (pos.entryPrice - price) * pos.qty;
    } else {
        // For LONG: profit when price goes up (exit - entry)
        grossPnL = (price - pos.entryPrice) * pos.qty;
    }
    
    const netPnL = grossPnL - brokerage; // Deduct Exit Brokerage

    // Calculate capital release
    let releaseCapital;
    if (isShort) {
        // For SHORT: We received cash when we sold, now we buy back
        // We need to pay for the buy back, but we keep the profit
        // Simplified: We add back the margin + profit - exit brokerage
        const entryValue = pos.entryPrice * pos.qty;
        const exitValue = price * pos.qty;
        releaseCapital = entryValue - exitValue - brokerage; // Profit from short
    } else {
        // For LONG: We paid cash when we bought, now we sell
        // We get back capital + profit - exit brokerage
        releaseCapital = (pos.entryPrice * pos.qty) + grossPnL - brokerage;
    }

    const closedTrade = {
        ...pos,
        exitPrice: price,
        exitTime: time,
        finalPnL: netPnL,
        // Net PnL includes both entry and exit brokerage
        netPnL: isShort
            ? (pos.entryPrice * pos.qty) - (price * pos.qty) - (pos.entryPrice * pos.qty * 0.0005) - brokerage
            : (price * pos.qty) - (pos.entryPrice * pos.qty) - (pos.entryPrice * pos.qty * 0.0005) - brokerage,
        comment,
        status: 'CLOSED'
    };

    portfolio.journal.push(closedTrade);
    portfolio.positions.splice(index, 1); // Remove from open
    portfolio.balance += releaseCapital;
    portfolio.equity = portfolio.balance;

    // console.log(`⚪ CLOSE: ${pos.symbol} ${isShort ? 'SHORT' : 'LONG'} @ ${price} | Net PnL: ${closedTrade.netPnL.toFixed(2)}`);
}

function logJournal(msg) {
    // console.log(`[PAPER] ${msg}`);
}
