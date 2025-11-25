// --- CONFIGURATION ---
const SCRAPE_INTERVAL_MS = 1000;
const WALL_MULTIPLIER = 2.5; // Wall = 2.5x Average Liquidity
const SPOOF_MULTIPLIER = 10; // Spoof = 10x Average Liquidity (Tuned for Bank Stocks)
const PANIC_MULTIPLIER = 3.0; // Panic = 3x Average Volume
const MELT_THRESHOLD = 0.3; // 30% drop = Melt
const ENTRY_SPREAD_PERCENT = 0.05; // Entry signal if spread < 0.05% of price

// Market Hours
const MARKET_START_HOUR = 9;
const MARKET_START_MINUTE = 15;
const MARKET_END_HOUR = 15;
const MARKET_END_MINUTE = 30;

// State
let isRecording = false;
let isAutoMode = false;
let recordedData = [];
let intervalId = null;
let autoLoopId = null;
let wallTracker = {}; 

// --- ADAPTIVE METRICS STATE ---
let metrics = {
    totalRowQty: 0,
    rowCount: 0,
    totalVisibleVol: 0,
    volSamples: 0,
    avgRowValue: 0,    // "Normal" Limit Order Value (in ₹)
    avgVisibleVol: 0   // "Normal" Tape Speed (in Qty)
};

// --- UI CREATION ---
const panel = document.createElement('div');
panel.style.cssText = `
    position: fixed; bottom: 80px; right: 20px; 
    background: #0f0f0f; color: #e0e0e0; padding: 15px; 
    border-radius: 8px; z-index: 2147483647; border: 1px solid #333;
    font-family: 'Segoe UI', sans-serif; box-shadow: 0 4px 15px rgba(0,0,0,0.8);
    display: flex; flex-direction: column; gap: 10px; min-width: 280px;
`;

const title = document.createElement('div');
title.innerText = "Adaptive Scalp Terminal";
title.style.cssText = "font-weight: bold; font-size: 14px; border-bottom: 1px solid #444; padding-bottom: 5px; color: #fff;";

const signalBox = document.createElement('div');
signalBox.style.cssText = `
    background: #1a1a1a; padding: 10px; border-radius: 4px; 
    font-size: 13px; min-height: 60px; border: 1px solid #333;
    max-height: 120px; overflow-y: auto;
`;
signalBox.innerHTML = "<div style='color: #888'>Calibrating...</div>";

const statsRow = document.createElement('div');
statsRow.style.cssText = "display: flex; justify-content: space-between; font-size: 11px; color: #aaa;";
statsRow.innerHTML = "<span>OBI: --</span><span>Avg Val: --</span>";

const timeDisplay = document.createElement('div');
timeDisplay.innerText = "";
timeDisplay.style.fontSize = "12px";
timeDisplay.style.color = "#aaa";
timeDisplay.style.textAlign = "center";

// Auto Mode
const autoContainer = document.createElement('div');
autoContainer.style.display = "flex";
autoContainer.style.alignItems = "center";
autoContainer.style.gap = "8px";

const chkAuto = document.createElement('input');
chkAuto.type = "checkbox"; 
chkAuto.id = "chkAutoRecord"; 
chkAuto.style.cursor = "pointer";

const lblAuto = document.createElement('label');
lblAuto.innerText = "Smart Mode (9:15 - 3:30)"; 
lblAuto.htmlFor = "chkAutoRecord"; 
lblAuto.style.cursor = "pointer"; 
lblAuto.style.fontSize = "13px";

autoContainer.appendChild(chkAuto); 
autoContainer.appendChild(lblAuto);

// Buttons Row 1
const btnContainer = document.createElement('div');
btnContainer.style.display = "flex"; 
btnContainer.style.gap = "5px";

const btnToggle = document.createElement('button');
btnToggle.innerText = "Start";
btnToggle.style.cssText = "padding: 8px; flex: 1; cursor: pointer; background: #28a745; color: white; border: none; border-radius: 4px; font-weight: bold;";

const btnReset = document.createElement('button');
btnReset.innerText = "Reset";
btnReset.style.cssText = "padding: 8px; flex: 0.5; cursor: pointer; background: #dc3545; color: white; border: none; border-radius: 4px; font-weight: bold;";

const btnDownload = document.createElement('button');
btnDownload.innerText = "Download";
btnDownload.style.cssText = "padding: 8px; flex: 0.7; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; font-weight: bold;";

btnContainer.appendChild(btnToggle); 
btnContainer.appendChild(btnReset); 
btnContainer.appendChild(btnDownload);

panel.appendChild(title); 
panel.appendChild(signalBox); 
panel.appendChild(statsRow); 
panel.appendChild(timeDisplay);
panel.appendChild(autoContainer); 
panel.appendChild(btnContainer); 
document.body.appendChild(panel);

// CSS
const style = document.createElement('style');
style.innerHTML = `
    .wall-support { background-color: rgba(40, 167, 69, 0.3) !important; border-left: 3px solid #28a745; }
    .wall-resistance { background-color: rgba(220, 53, 69, 0.3) !important; border-right: 3px solid #dc3545; }
    .wall-melt { animation: flashRed 0.5s infinite; }
    .gap-highlight { background-color: rgba(0, 123, 255, 0.2) !important; border-left: 3px solid #007bff; }
    .signal-toast { position: fixed; top: 20px; right: 20px; padding: 10px 20px; border-radius: 4px; color: white; z-index: 2147483648; animation: fadeOut 4s forwards; }
    @keyframes flashRed { 0% { background-color: rgba(255,0,0,0.5); } 50% { background-color: transparent; } 100% { background-color: rgba(255,0,0,0.5); } }
    @keyframes fadeOut { 0% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
`;
document.head.appendChild(style);

// --- HELPERS ---
function cleanNumber(str) {
    if (!str) return 0;
    const num = parseFloat(str.replace(/,/g, '').trim()) || 0;
    // Round to 2 decimal places for price precision
    return Math.round(num * 100) / 100;
}

function getReadableTime() { 
    return new Date().toLocaleString(); 
}

function getStockName() {
    const nameEl = document.querySelector('.stockName') || document.querySelector('.instrument-name') || document.title;
    let name = (nameEl.innerText || nameEl.textContent || nameEl).trim();
    if (name.includes('|')) name = name.split('|')[0].trim();
    return name.replace(/[^a-zA-Z0-9]/g, '_');
}

function showToast(msg, color) {
    const toast = document.createElement('div');
    toast.className = 'signal-toast';
    toast.style.background = color;
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// --- ANALYSIS CORE ---
function getRealTimeTrades() {
    const tables = document.querySelectorAll('table');
    let tradesTable = null;
    for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim());
        if (headers.includes('Traded Quantity')) { 
            tradesTable = table; 
            break; 
        }
    }
    const trades = [];
    if (tradesTable) {
        tradesTable.querySelectorAll('tbody tr').forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 3) {
                trades.push({
                    time: cols[0].innerText.trim(),
                    quantity: cleanNumber(cols[1].innerText),
                    price: cleanNumber(cols[2].innerText)
                });
            }
        });
    }
    return trades;
}

function processMarketData() {
    const buyRows = Array.from(document.querySelectorAll('.BuyOrdersDepth tbody tr'));
    const sellRows = Array.from(document.querySelectorAll('.SellOrdersDepth tbody tr'));
    let bids = [], asks = [], quantities = [];
    let totalBidQty = 0, totalAskQty = 0;

    // 1. Scrape & Clean
    buyRows.forEach(row => {
        row.classList.remove('wall-support', 'wall-melt', 'gap-highlight');
        const cols = row.querySelectorAll('td');
        if(cols.length >= 3) {
            const qty = cleanNumber(cols[1].querySelector('.depthText')?.innerText);
            const price = cleanNumber(cols[2].innerText);
            if (qty > 0) { 
                bids.push({ row, price, qty }); 
                totalBidQty += qty; 
                quantities.push(qty); 
            }
        }
    });

    sellRows.forEach(row => {
        row.classList.remove('wall-resistance', 'wall-melt', 'gap-highlight');
        const cols = row.querySelectorAll('td');
        if(cols.length >= 3) {
            const price = cleanNumber(cols[0].innerText);
            const qty = cleanNumber(cols[1].querySelector('.depthText')?.innerText);
            if (qty > 0) { 
                asks.push({ row, price, qty }); 
                totalAskQty += qty; 
                quantities.push(qty); 
            }
        }
    });

    if (bids.length === 0 || asks.length === 0) return;

    // 2. UPDATE ADAPTIVE METRICS (Self-Learning)
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    
    // Learning Phase: Update Row Averages
    quantities.forEach(q => {
        metrics.totalRowQty += q;
        metrics.rowCount++;
    });
    
    // Calculate Dynamic Thresholds
    const avgQty = metrics.rowCount > 0 ? metrics.totalRowQty / metrics.rowCount : 0;
    const avgRowValue = avgQty * bestBid; // The "Normal" Order Value in Rupees
    
    metrics.avgRowValue = avgRowValue; // Store for display/debug
    const WALL_THRESHOLD = avgQty * WALL_MULTIPLIER;
    const SPOOF_THRESHOLD_VALUE = avgRowValue * SPOOF_MULTIPLIER; // 10x Average Value

    // Trades Analysis (Velocity)
    const realTimeTrades = getRealTimeTrades();
    let visibleVol = realTimeTrades.reduce((acc, t) => acc + t.quantity, 0);
    
    // Update Trade Volume Average
    metrics.totalVisibleVol += visibleVol;
    metrics.volSamples++;
    const avgVisibleVol = metrics.volSamples > 0 ? metrics.totalVisibleVol / metrics.volSamples : 0;

    let signals = [];
    let loggedSignals = [];

    // --- SIGNAL LOGIC ---

    // A. Tape Panic (Adaptive)
    // If current visible volume is 3x higher than average => PANIC
    let sellPressure = 0, buyPressure = 0;
    realTimeTrades.forEach(t => { 
        if(t.price <= bestBid) sellPressure += t.quantity; 
        else buyPressure += t.quantity; 
    });

    if (visibleVol > avgVisibleVol * PANIC_MULTIPLIER && avgVisibleVol > 0) {
        if (sellPressure > buyPressure) {
            const msg = `🔥 TAPE PANIC: Volume ${PANIC_MULTIPLIER}x Avg!`;
            signals.push(`<div style='color:#ff4444; font-weight:bold'>${msg}</div>`);
            loggedSignals.push({ type: 'PANIC_SELL', time: getReadableTime() });
        }
    }

    // Dynamic spread threshold based on price (0.05% of best bid)
    const entrySpreadThreshold = bestBid * ENTRY_SPREAD_PERCENT / 100;
    
    // Clean stale wallTracker entries (prices no longer in order book)
    const currentPrices = new Set([...bids.map(b => b.price), ...asks.map(a => a.price)]);
    Object.keys(wallTracker).forEach(price => {
        if (!currentPrices.has(parseFloat(price))) {
            delete wallTracker[price];
        }
    });

    // B. Analyze Bids (Support)
    bids.forEach(bid => {
        // Wall Detection
        if (bid.qty > WALL_THRESHOLD) {
            bid.row.classList.add('wall-support');
            
            // Check for Melt/Spoof
            if (wallTracker[bid.price]) {
                const prevQty = wallTracker[bid.price];
                const dropQty = prevQty - bid.qty;
                const dropValue = dropQty * bid.price;
                
                // Adaptive Spoof Logic: Value > 10x Avg AND Volume didn't justify it
                if (dropQty > 0) {
                    // Check volume traded at this price
                    const tradedAtPrice = realTimeTrades.filter(t => t.price === bid.price).reduce((acc, t) => acc + t.quantity, 0);
                    
                    if (dropValue > SPOOF_THRESHOLD_VALUE && tradedAtPrice < dropQty * 0.1) {
                         const valLakhs = (dropValue / 100000).toFixed(1);
                         const msg = `👻 SPOOF: ₹${valLakhs}L pulled at ${bid.price}`;
                         signals.push(`<div style='color:#ff9800'>${msg}</div>`);
                         loggedSignals.push({ type: 'SPOOF_SUPPORT', price: bid.price, val: valLakhs, time: getReadableTime() });
                         showToast(msg, '#ff9800');
                    } else if (dropQty > prevQty * MELT_THRESHOLD) {
                         bid.row.classList.add('wall-melt');
                         // Only alert if it's near price
                         if (bestAsk - bid.price < entrySpreadThreshold * 2) {
                             signals.push(`<div style='color:#ff4444'>⚠️ Support Melting at ${bid.price}</div>`);
                             loggedSignals.push({ type: 'MELT_SUPPORT', price: bid.price, time: getReadableTime() });
                         }
                    }
                }
            }
            wallTracker[bid.price] = bid.qty;

            // Entry Signal (spread-based)
            if (bestAsk - bid.price <= entrySpreadThreshold) {
                const msg = `✅ BUY SIGNAL: Wall at ${bid.price}`;
                signals.push(`<div style='color:#4caf50'>${msg}</div>`);
                loggedSignals.push({ type: 'ENTRY_BUY', price: bid.price, time: getReadableTime() });
            }
        }
    });

    // C. Analyze Asks (Resistance)
    asks.forEach(ask => {
        if (ask.qty > WALL_THRESHOLD) {
            ask.row.classList.add('wall-resistance');
            
            if (wallTracker[ask.price]) {
                const prevQty = wallTracker[ask.price];
                const dropQty = prevQty - ask.qty;
                const dropValue = dropQty * ask.price;
                
                if (dropQty > 0) {
                    const tradedAtPrice = realTimeTrades.filter(t => t.price === ask.price).reduce((acc, t) => acc + t.quantity, 0);
                    
                    if (dropValue > SPOOF_THRESHOLD_VALUE && tradedAtPrice < dropQty * 0.1) {
                         const valLakhs = (dropValue / 100000).toFixed(1);
                         const msg = `👻 SPOOF: ₹${valLakhs}L pulled at ${ask.price}`;
                         signals.push(`<div style='color:#ff9800'>${msg}</div>`);
                         loggedSignals.push({ type: 'SPOOF_RESISTANCE', price: ask.price, val: valLakhs, time: getReadableTime() });
                         showToast(msg, '#ff9800');
                    } else if (dropQty > prevQty * MELT_THRESHOLD) {
                         ask.row.classList.add('wall-melt');
                         if (ask.price - bestBid < entrySpreadThreshold * 2) {
                             signals.push(`<div style='color:#ff4444'>⚠️ Resistance Melting at ${ask.price}</div>`);
                             loggedSignals.push({ type: 'MELT_RESISTANCE', price: ask.price, time: getReadableTime() });
                         }
                    }
                }
            }
            wallTracker[ask.price] = ask.qty;

            if (ask.price - bestBid <= entrySpreadThreshold) {
                const msg = `🔻 SELL SIGNAL: Wall at ${ask.price}`;
                signals.push(`<div style='color:#ff5252'>${msg}</div>`);
                loggedSignals.push({ type: 'ENTRY_SELL', price: ask.price, time: getReadableTime() });
            }
        }
    });

    // Recording
    if (bids.length > 0) {
        recordedData.push({
            timestamp: getReadableTime(),
            marketDepth: { 
                bids: bids.map(b => ({ price: b.price, qty: b.qty })), 
                asks: asks.map(a => ({ price: a.price, qty: a.qty })) 
            },
            recentTrades: realTimeTrades,
            signals: loggedSignals
        });
    }

    // UI Updates
    const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
    const obiColor = obi > 0 ? '#4caf50' : '#ff5252';
    const rowValDisplay = (metrics.avgRowValue / 1000).toFixed(1) + 'k'; // e.g. "40.5k"
    
    statsRow.innerHTML = `
        <span style="color:${obiColor}">OBI: ${(obi*100).toFixed(0)}%</span>
        <span>AvgOrder: ₹${rowValDisplay}</span>
        <span style="color:#aaa">Rec: ${recordedData.length}</span>
    `;

    if (signals.length > 0) signalBox.innerHTML = signals.slice(0, 3).join('');
    else signalBox.innerHTML = "<div style='color: #666'>Scanning (Adaptive)...</div>";
}

// --- LOOPS & EVENTS ---
function startRecording() {
    if (isRecording) return;
    isRecording = true;
    btnToggle.innerText = "Pause";
    btnToggle.style.background = "#ffc107"; 
    btnToggle.style.color = "#000";
    if (!isAutoMode) timeDisplay.innerText = "Recording...";
    intervalId = setInterval(processMarketData, SCRAPE_INTERVAL_MS);
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    btnToggle.innerText = "Start";
    btnToggle.style.background = "#28a745"; 
    btnToggle.style.color = "#fff";
    if (!isAutoMode) timeDisplay.innerText = `Paused (${recordedData.length} snapshots)`;
    clearInterval(intervalId);
    document.querySelectorAll('.wall-support, .wall-resistance, .wall-melt').forEach(el => {
        el.classList.remove('wall-support', 'wall-resistance', 'wall-melt');
    });
}

function downloadData() {
    const stockName = getStockName() || "market_data";
    const blob = new Blob([JSON.stringify(recordedData, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = `${stockName}_${new Date().getTime()}.json`; 
    a.click();
    URL.revokeObjectURL(url);
}

// Listeners
chkAuto.onchange = (e) => {
    isAutoMode = e.target.checked;
    if (isAutoMode && !autoLoopId) {
        autoLoopId = setInterval(() => {
            const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
            const startMins = MARKET_START_HOUR * 60 + MARKET_START_MINUTE;
            const endMins = MARKET_END_HOUR * 60 + MARKET_END_MINUTE;
            const open = nowMins >= startMins && nowMins < endMins;
            
            if (nowMins < startMins) {
                const diff = startMins - nowMins;
                timeDisplay.innerText = `Market opens in ${diff} mins`;
            } else if (open) {
                const diff = endMins - nowMins;
                timeDisplay.innerText = `[Smart] Recording • ${diff} mins left`;
            } else {
                timeDisplay.innerText = "Market Closed";
            }
            
            if(open && !isRecording) startRecording();
            else if(!open && isRecording) { 
                stopRecording(); 
                downloadData(); 
            }
        }, 1000);
    } else { 
        clearInterval(autoLoopId); 
        autoLoopId = null; 
        timeDisplay.innerText = ""; 
    }
};

btnToggle.onclick = () => isRecording ? stopRecording() : startRecording();

btnReset.onclick = () => { 
    stopRecording(); 
    recordedData = []; 
    wallTracker = {};
    signalBox.innerHTML = "<div style='color: #888'>Ready to record...</div>"; 
    timeDisplay.innerText = "";
    statsRow.innerHTML = "<span>OBI: --</span><span>Avg Val: --</span><span>Rec: 0</span>";
    metrics = {
        totalRowQty: 0, 
        rowCount: 0, 
        totalVisibleVol: 0, 
        volSamples: 0, 
        avgRowValue: 0, 
        avgVisibleVol: 0
    }; 
};

btnDownload.onclick = downloadData;