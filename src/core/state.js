import { STATES } from '../config';

export let currentState = STATES.IDLE;
export let discoveryStartTime = null;

export let state = {
    symbol: '',
    vwap: 0,
    vwapData: { cumTypicalVol: 0, cumVol: 0 },
    lastSignalTime: {}, // Track last signal times for deduplication
    zones: {
        demand: [],  // { price, type, strength, timestamp }
        supply: []
    },
    tapeHistory: [],
    priceHistory: [],
    volumeHistory: [],

    // Execution Guards
    dailyPL: 0,
    tradeHistory: [],
    strategyCooldowns: {},
    isStopped: false,

    // 🧠 PLAN & LEARN (Strategy Performance)
    strategyPerformance: {
        'WHALE': { wins: 0, losses: 0, consecutiveLosses: 0, status: 'ACTIVE' },
        'BEAST': { wins: 0, losses: 0, consecutiveLosses: 0, status: 'ACTIVE' },
        'TRAP': { wins: 0, losses: 0, consecutiveLosses: 0, status: 'ACTIVE' },
        'WALL': { wins: 0, losses: 0, consecutiveLosses: 0, status: 'ACTIVE' }
    }
};

export function updateStrategyPerformance(strategy, result) {
    const stats = state.strategyPerformance[strategy];
    if (!stats) return;

    if (result === 'WIN') {
        stats.wins++;
        stats.consecutiveLosses = 0;
        stats.status = 'ACTIVE'; // Re-enable if it was disabled? Maybe not automatically.
    } else if (result === 'LOSS') {
        stats.losses++;
        stats.consecutiveLosses++;

        // 🛑 KILL SWITCH: 2 Consecutive Losses = Disable Strategy for Day
        if (stats.consecutiveLosses >= 2) {
            stats.status = 'DISABLED';
            console.log(`🚫 STRATEGY DISABLED: ${strategy} (2 Consecutive Losses)`);
        }
    }
}

export let metrics = {
    totalRowQty: 0,
    rowCount: 0,
    totalVisibleVol: 0,
    volSamples: 0,
    avgRowValue: 0,
    avgVisibleVol: 0,
    tradeVelocity: 0,
    lastTradeCount: 0,
    lastTradeTime: Date.now()
};

export let wallTracker = {};

export function updateCurrentState(newState) {
    currentState = newState;
}

export function setDiscoveryStartTime(time) {
    discoveryStartTime = time;
}

export function resetState() {
    currentState = STATES.IDLE;
    discoveryStartTime = null;

    state.symbol = '';
    state.vwap = 0;
    state.vwapData = { cumTypicalVol: 0, cumVol: 0 };
    state.lastSignalTime = {};
    state.zones = { demand: [], supply: [] };
    state.tapeHistory = [];
    state.priceHistory = [];
    state.volumeHistory = [];

    metrics.totalRowQty = 0;
    metrics.rowCount = 0;
    metrics.totalVisibleVol = 0;
    metrics.volSamples = 0;
    metrics.avgRowValue = 0;
    metrics.avgVisibleVol = 0;
    metrics.tradeVelocity = 0;
    metrics.lastTradeCount = 0;
    metrics.lastTradeTime = Date.now();

    wallTracker = {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 LONG-TERM MEMORY (PERSISTENCE) - CHROME STORAGE
// ─────────────────────────────────────────────────────────────────────────────
export function saveMemory() {
    if (!state.symbol) return;

    const memory = {
        timestamp: Date.now(),
        vwap: state.vwap,
        vwapData: state.vwapData,
        zones: state.zones,
        strategyPerformance: state.strategyPerformance // <--- PERSIST LEARNING
    };

    try {
        // Use Chrome Storage if available, fallback to localStorage (for testing)
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const key = `DHAN_BRAIN_${state.symbol}`;
            chrome.storage.local.set({ [key]: memory }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Storage Save Error:', chrome.runtime.lastError);
                }
            });
        } else {
            localStorage.setItem(`DHAN_BRAIN_${state.symbol}`, JSON.stringify(memory));
        }
    } catch (e) {
        console.error('Failed to save memory', e);
    }
}

import { KNOWLEDGE_BASE } from '../data/knowledge'; // Import Instincts

export async function loadMemory(symbol) {
    return new Promise((resolve) => {
        const key = `DHAN_BRAIN_${symbol}`;

        const applyMemory = (memory) => {
            // 1. If we have Dynamic Memory, use it.
            if (memory) {
                // Check if memory is stale (> 12 hours)
                const ageHours = (Date.now() - memory.timestamp) / (1000 * 60 * 60);

                if (ageHours <= 12) {
                    // FRESH MEMORY (Same Day Continuation)
                    state.symbol = symbol;
                    state.vwap = memory.vwap;
                    state.vwapData = memory.vwapData;
                    state.zones = memory.zones;
                    if (memory.strategyPerformance) state.strategyPerformance = memory.strategyPerformance;
                    return true;
                } else {
                    // STALE MEMORY (New Day - Merge Knowledge)
                    // console.log(`🧠 Merging Historical Knowledge for ${symbol}...`);
                    state.symbol = symbol;

                    // 1. Merge Zones (Keep Strongest Historical Zones)
                    // Decay strength of old zones by 50%
                    const oldDemand = (memory.zones.demand || []).map(z => ({ ...z, strength: z.strength * 0.5 }));
                    const oldSupply = (memory.zones.supply || []).map(z => ({ ...z, strength: z.strength * 0.5 }));

                    // Seed with Psychological Levels + Strongest Old Zones
                    const baseLevels = KNOWLEDGE_BASE.LEVELS[symbol] || [];
                    const psychDemand = baseLevels.map(p => ({ price: p, strength: 1000, type: 'PSYCH' }));
                    const psychSupply = baseLevels.map(p => ({ price: p, strength: 1000, type: 'PSYCH' }));

                    state.zones = {
                        demand: [...psychDemand, ...oldDemand].sort((a, b) => b.strength - a.strength).slice(0, 10),
                        supply: [...psychSupply, ...oldSupply].sort((a, b) => b.strength - a.strength).slice(0, 10)
                    };

                    // 2. Merge Strategy Stats (Accumulate Wisdom)
                    if (memory.strategyPerformance) {
                        Object.keys(state.strategyPerformance).forEach(strat => {
                            if (memory.strategyPerformance[strat]) {
                                state.strategyPerformance[strat].wins += memory.strategyPerformance[strat].wins;
                                state.strategyPerformance[strat].losses += memory.strategyPerformance[strat].losses;
                                // Reset consecutive losses and status for new day
                                state.strategyPerformance[strat].consecutiveLosses = 0;
                                state.strategyPerformance[strat].status = 'ACTIVE';
                            }
                        });
                    }

                    return true;
                }
            }

            // 2. If no memory (or stale), use KNOWLEDGE BASE (Instincts)
            // console.log(`🧠 No Dynamic Memory. Loading Instincts for ${symbol}...`);
            state.symbol = symbol;
            state.vwap = 0;
            state.vwapData = { cumTypicalVol: 0, cumVol: 0 };

            // Seed Zones with Psychological Levels
            const baseLevels = KNOWLEDGE_BASE.LEVELS[symbol] || [];
            state.zones = {
                demand: baseLevels.map(p => ({ price: p, strength: 1000, type: 'PSYCH' })),
                supply: baseLevels.map(p => ({ price: p, strength: 1000, type: 'PSYCH' }))
            };

            return true; // We successfully loaded *something*
        };

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get([key], (result) => {
                resolve(applyMemory(result[key]));
            });
        } else {
            const raw = localStorage.getItem(key);
            resolve(applyMemory(raw ? JSON.parse(raw) : null));
        }
    });
}
