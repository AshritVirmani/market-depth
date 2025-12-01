// 🧠 PRE-TRAINED KNOWLEDGE BASE (Derived from 5-Year Backtest)
// This file contains the "Instincts" of the system.

export const KNOWLEDGE_BASE = {
    // 🕒 TIME OF DAY EDGES
    SCHEDULE: {
        MORNING_RUSH: { start: '09:30', end: '11:00', bestFor: ['SBIN'] },
        LUNCH_LULL: { start: '11:30', end: '12:30', bestFor: ['NONE'], action: 'AVOID' },
        WHALE_ZONE: { start: '12:30', end: '14:30', bestFor: ['HDFCBANK'] },
        EURO_BLAST: { start: '14:30', end: '15:00', bestFor: ['ALL'] }
    },

    // 📊 VIX REGIMES
    VIX: {
        LOW: { max: 12, advice: 'FULL_SIZE', winRate: '52.8%' },
        NORMAL: { min: 12, max: 16, advice: 'NORMAL_SIZE', winRate: '49.4%' },
        HIGH: { min: 16, advice: 'HALF_SIZE_OR_AVOID', winRate: '46.5%' }
    },

    // 🐂 STOCK PERSONALITIES
    PERSONALITIES: {
        'SBIN': {
            type: 'MOMENTUM',
            edge: 'PRICE_ACTION',
            ignoreOptions: true,
            stopLossPct: 0.7
        },
        'HDFCBANK': {
            type: 'MEAN_REVERSION',
            edge: 'OPTION_CHAIN',
            ignoreOptions: false,
            stopLossPct: 0.5
        },
        'ICICIBANK': {
            type: 'FOLLOWER',
            edge: 'NONE',
            ignoreOptions: true,
            stopLossPct: 0.6
        }
    },

    // 🧱 PSYCHOLOGICAL LEVELS (Initial Seeds)
    // The dynamic memory will add to this list.
    LEVELS: {
        'HDFCBANK': [1500, 1550, 1600, 1650, 1700, 1750],
        'SBIN': [750, 800, 850, 900],
        'ICICIBANK': [1000, 1050, 1100, 1150, 1200]
    }
};
