import { SCRAPE_INTERVAL_MS, DISCOVERY_MINS, MARKET_START_HOUR, MARKET_START_MINUTE, MARKET_END_HOUR, MARKET_END_MINUTE, STATES } from './config';
import { initPanel, updateStateBadge } from './utils/dom';
import { processMarketData, resetStrategy } from './core/strategy';
import { resetState, setDiscoveryStartTime, updateCurrentState, currentState } from './core/state';
import { downloadData, clearRecordedData, getRecordedDataLength } from './utils/logger';

let isRecording = false;
let isAutoMode = false;
let intervalId = null;
let autoLoopId = null;

// Web Worker for Background Throttling Bypass
// 🔧 FIX: Avoid CSP violation by using string concatenation instead of template literals in Blob
const workerCode = [
    'let intervalId = null;',
    'self.onmessage = function(e) {',
    '    if (e.data === "START") {',
    '        if (intervalId) clearInterval(intervalId);',
    '        intervalId = setInterval(() => self.postMessage("TICK"), ' + SCRAPE_INTERVAL_MS + ');',
    '    } else if (e.data === "STOP") {',
    '        if (intervalId) clearInterval(intervalId);',
    '        intervalId = null;',
    '    }',
    '};'
].join('\n');

const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(workerBlob));

worker.onmessage = function (e) {
    if (e.data === 'TICK') {
        // 🔧 FIX: Ensure processMarketData is called and handles errors
        try {
            processMarketData().catch(err => {
                console.error('Error in processMarketData:', err);
            });
        } catch (err) {
            console.error('Error calling processMarketData:', err);
        }
    }
};

function startRecording() {
    if (isRecording) return;

    isRecording = true;
    setDiscoveryStartTime(Date.now());
    updateStateBadge(STATES.DISCOVERY);
    updateCurrentState(STATES.DISCOVERY);

    const btnToggle = document.getElementById('btnToggle');
    if (btnToggle) {
        btnToggle.innerText = "⏸ PAUSE";
        btnToggle.style.background = "linear-gradient(135deg, #ffab00 0%, #ff8f00 100%)";
        btnToggle.style.color = "#000";
    }

    const timeDisplay = document.getElementById('timeDisplay');
    if (timeDisplay && !isAutoMode) {
        timeDisplay.innerText = `🔍 Discovery Phase (${DISCOVERY_MINS} mins)`;
    }

    // intervalId = setInterval(processMarketData, SCRAPE_INTERVAL_MS);
    worker.postMessage('START');
}

function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    updateStateBadge(STATES.IDLE);
    updateCurrentState(STATES.IDLE);

    const btnToggle = document.getElementById('btnToggle');
    if (btnToggle) {
        btnToggle.innerText = "▶ START";
        btnToggle.style.background = "linear-gradient(135deg, #00c853 0%, #00a843 100%)";
        btnToggle.style.color = "#fff";
    }

    const timeDisplay = document.getElementById('timeDisplay');
    if (timeDisplay && !isAutoMode) {
        timeDisplay.innerText = `Paused (${getRecordedDataLength()} snapshots)`;
    }

    // clearInterval(intervalId);
    worker.postMessage('STOP');

    document.querySelectorAll('.wall-support, .wall-resistance, .wall-melt, .zone-demand, .zone-supply')
        .forEach(el => el.classList.remove('wall-support', 'wall-resistance', 'wall-melt', 'zone-demand', 'zone-supply'));
}

function handleToggle() {
    if (isRecording) stopRecording();
    else startRecording();
}

function handleReset() {
    stopRecording();
    resetState();
    resetStrategy();
    clearRecordedData();
}

function handleAutoChange(e) {
    isAutoMode = e.target.checked;

    if (isAutoMode && !autoLoopId) {
        let consecutiveErrors = 0;
        autoLoopId = setInterval(() => {
            // 🔧 FIX: Add error handling to prevent Smart Mode from stopping
            try {
                const now = new Date();
                const nowMins = now.getHours() * 60 + now.getMinutes();
                const startMins = MARKET_START_HOUR * 60 + MARKET_START_MINUTE;
                const endMins = MARKET_END_HOUR * 60 + MARKET_END_MINUTE;
                const open = nowMins >= startMins && nowMins < endMins;

                const timeDisplay = document.getElementById('timeDisplay');

                if (nowMins < startMins) {
                    const diff = startMins - nowMins;
                    if (timeDisplay) timeDisplay.innerText = `Market opens in ${diff} mins`;
                } else if (open) {
                    const diff = endMins - nowMins;
                    const phase = currentState === STATES.DISCOVERY ? '🔍 Discovery' : '👁 Monitoring';
                    if (timeDisplay) timeDisplay.innerText = `${phase} • ${diff} mins left`;
                } else {
                    if (timeDisplay) timeDisplay.innerText = "Market Closed";
                }

                if (open && !isRecording) {
                    startRecording();
                } else if (!open && isRecording) {
                    stopRecording();
                }
                
                // Reset error counter on success
                consecutiveErrors = 0;
            } catch (error) {
                console.error('❌ Error in Smart Mode loop:', error);
                consecutiveErrors++;
                
                // If too many errors, restart the loop
                if (consecutiveErrors > 5) {
                    console.error('❌ Smart Mode loop failing, restarting...');
                    clearInterval(autoLoopId);
                    autoLoopId = null;
                    // Restart after 2 seconds
                    setTimeout(() => {
                        if (isAutoMode) {
                            console.log('🔄 Restarting Smart Mode...');
                            handleAutoChange({ target: { checked: true } });
                        }
                    }, 2000);
                }
            }
        }, 1000);
        console.log('✅ Smart Mode started');
    } else if (!isAutoMode && autoLoopId) {
        clearInterval(autoLoopId);
        autoLoopId = null;
        console.log('⏸️ Smart Mode stopped');
    }
}

// Initialize
console.log("🏦 Hybrid Quant Workstation v2.0 Loaded");
initPanel({
    onToggle: handleToggle,
    onReset: handleReset,
    onDownload: downloadData,
    onAutoChange: handleAutoChange
});

// 🔧 FIX: Ensure button shows correct initial state
setTimeout(() => {
    const btnToggle = document.getElementById('btnToggle');
    if (btnToggle && !isRecording) {
        btnToggle.innerText = "▶ START";
        btnToggle.style.background = "linear-gradient(135deg, #00c853 0%, #00a843 100%)";
        btnToggle.style.color = "#fff";
    }
}, 100);

// 📡 REGISTER WITH CENTRAL BRAIN
if (typeof chrome !== 'undefined' && chrome.runtime) {
    // Get Symbol from URL or DOM
    const symbol = document.title.split(' ')[0] || "UNKNOWN";
    chrome.runtime.sendMessage({
        type: 'REGISTER_TAB',
        symbol: symbol
    }).catch(() => { /* Ignore */ });
}
