// 🧠 CENTRAL BRAIN (Background Service Worker)
// Orchestrates trading across multiple tabs (HDFC, SBIN, ICICI, etc.)

let marketMap = {}; // { tabId: { symbol, score, timestamp, status } }
// 🔧 FIX: Lower threshold - scores are 0-100, but signals can fire at lower confidence
const EXECUTION_THRESHOLD = 40; // Minimum confidence to trade (was 80 - too high)
const SCORE_BUFFER = 5; // Must be 5% better than the next best to switch (was 10)

// 👂 LISTEN FOR MESSAGES FROM TABS
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab.id;

    if (message.type === 'REGISTER_TAB') {
        console.log(`✅ Tab Registered: ${message.symbol} (ID: ${tabId})`);
        marketMap[tabId] = {
            symbol: message.symbol,
            score: 0,
            timestamp: Date.now(),
            status: 'IDLE'
        };
    }

    if (message.type === 'OPPORTUNITY_UPDATE') {
        // Update the score for this tab
        if (!marketMap[tabId]) {
            marketMap[tabId] = { symbol: message.symbol, status: 'IDLE' };
        }

        marketMap[tabId].score = message.score;
        marketMap[tabId].timestamp = Date.now();
        marketMap[tabId].details = message.details; // { strategy, confidence }

        // 🧠 DECIDE: Who gets the trade?
        evaluateOpportunities();
    }
});

// ⚖️ THE JUDGE (Decision Engine)
function evaluateOpportunities() {
    const now = Date.now();
    let bestTab = null;
    let bestScore = -1;

    // 🔧 FIX: Add logging to debug score issues
    const activeTabs = Object.keys(marketMap).length;
    if (activeTabs === 0) {
        // console.log('🧠 Central Brain: No tabs registered');
        return;
    }

    // 1. Find the Best Opportunity
    Object.keys(marketMap).forEach(tabId => {
        const data = marketMap[tabId];

        // Filter stale data (> 10 seconds old - increased from 5s)
        if (now - data.timestamp > 10000) {
            data.score = 0;
            return;
        }

        if (data.score > bestScore) {
            bestScore = data.score;
            bestTab = tabId;
        }
    });
    
    // 🔧 FIX: Log current state for debugging
    if (bestTab && bestScore > 0) {
        console.log(`🧠 Central Brain: Best opportunity - ${marketMap[bestTab].symbol} (Score: ${bestScore.toFixed(1)})`);
    }

    // 2. Apply Logic
    if (bestTab && bestScore >= EXECUTION_THRESHOLD) {
        // Check if we are already trading somewhere else
        const activeTradeTab = Object.keys(marketMap).find(id => marketMap[id].status === 'EXECUTING');

        if (activeTradeTab && activeTradeTab !== bestTab) {
            // We are already busy. Is this new one MUCH better?
            const currentScore = marketMap[activeTradeTab].score;
            if (bestScore > currentScore + SCORE_BUFFER) {
                // SWITCH! (Cancel old, Start new)
                console.log(`🔀 SWITCHING: ${marketMap[activeTradeTab].symbol} (${currentScore.toFixed(1)}) -> ${marketMap[bestTab].symbol} (${bestScore.toFixed(1)})`);
                sendCommand(activeTradeTab, 'STANDBY');
                sendCommand(bestTab, 'EXECUTE_TRADE');

                marketMap[activeTradeTab].status = 'IDLE';
                marketMap[bestTab].status = 'EXECUTING';
            } else {
                // Not better enough, keep current trade
                // console.log(`⏸️ Keeping current trade: ${marketMap[activeTradeTab].symbol} (${currentScore.toFixed(1)}) vs ${marketMap[bestTab].symbol} (${bestScore.toFixed(1)})`);
            }
        } else if (!activeTradeTab) {
            // We are free. Take the trade!
            console.log(`🚀 EXECUTING: ${marketMap[bestTab].symbol} (Score: ${bestScore.toFixed(1)})`);
            sendCommand(bestTab, 'EXECUTE_TRADE');
            marketMap[bestTab].status = 'EXECUTING';
        }
    } else {
        // 🔧 FIX: Only send STANDBY if we were executing, not on every check
        // This prevents the rapid toggling we see in console
        const activeTabs = Object.keys(marketMap).filter(id => marketMap[id].status === 'EXECUTING');
        if (activeTabs.length > 0) {
            // Only stand down if we were executing but score dropped
            if (bestScore < EXECUTION_THRESHOLD) {
                console.log(`⏸️ STANDBY: No opportunities above threshold (${EXECUTION_THRESHOLD}). Best: ${bestScore.toFixed(1)}`);
                activeTabs.forEach(tabId => {
                    sendCommand(tabId, 'STANDBY');
                    marketMap[tabId].status = 'IDLE';
                });
            }
        }
        // Don't spam STANDBY if already IDLE
    }
}

// 📡 COMMAND CENTER
function sendCommand(tabId, type) {
    chrome.tabs.sendMessage(Number(tabId), { type: type }).catch(err => {
        // Tab might be closed
        console.log(`⚠️ Failed to send ${type} to Tab ${tabId}`);
        delete marketMap[tabId];
    });
}

// 🧹 CLEANUP (Remove closed tabs)
chrome.tabs.onRemoved.addListener((tabId) => {
    if (marketMap[tabId]) {
        console.log(`🗑️ Tab Closed: ${marketMap[tabId].symbol}`);
        delete marketMap[tabId];
    }
});
