import { SELECTORS, STRIKE_STEPS, NORMALIZED_MAPPING, STATES } from '../config';

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function cleanNumber(str) {
    if (!str) return 0;
    return Math.round(parseFloat(str.replace(/,/g, '').trim()) * 100) / 100 || 0;
}

export function getReadableTime() {
    return new Date().toLocaleString();
}

export function getPreciseTimestamp() {
    const now = new Date();
    return {
        unix: now.getTime(),
        iso: now.toISOString(),
        readable: now.toLocaleTimeString('en-IN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }) + '.' + String(now.getMilliseconds()).padStart(3, '0'),
        date: now.toLocaleDateString('en-IN')
    };
}

export function getStockName() {
    const nameEl = document.querySelector(SELECTORS.stockName) || document.title;
    let name = (nameEl.innerText || nameEl.textContent || nameEl).trim();
    if (name.includes('|')) name = name.split('|')[0].trim();

    const nameKey = Object.keys(NORMALIZED_MAPPING).find(key => key.toLowerCase() === name.toLowerCase());
    if (nameKey) {
        return NORMALIZED_MAPPING[nameKey];
    }

    const normalized = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return normalized;
}

export function getATMStrike(price, symbol) {
    if (!price || !symbol) return 0;
    const step = STRIKE_STEPS[symbol] || (price * 0.01);
    const strike = Math.round(price / step) * step;
    return strike;
}

export function showToast(msg, color, icon = '') {
    const toast = document.createElement('div');
    toast.className = 'signal-toast';
    toast.style.background = `linear-gradient(135deg, ${color} 0%, ${adjustColor(color, -30)} 100%)`;
    toast.innerHTML = `${icon} ${msg}`;
    document.body.appendChild(toast);

    if (msg.includes('BUY') || msg.includes('TRAP')) {
        playAlertSound();
    }

    setTimeout(() => toast.remove(), 4000);
}

export function adjustColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
    return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
}

export function playAlertSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.frequency.value = 880;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 0.3);
    } catch (e) { /* Audio not available */ }
}

export function updateStateBadge(newState) {
    const badge = document.getElementById('stateBadge');
    if (!badge) return;

    const stateStyles = {
        [STATES.IDLE]: { bg: '#333', color: '#666', text: 'IDLE' },
        [STATES.DISCOVERY]: { bg: '#1a3a5c', color: '#00d4ff', text: '🔍 DISCOVERY' },
        [STATES.MONITORING]: { bg: '#2a3a2a', color: '#00c853', text: '👁 MONITORING' },
        [STATES.ZONE_ALERT]: { bg: '#3a3a1a', color: '#ffab00', text: '⚡ ZONE ALERT' },
        [STATES.ENTRY_SIGNAL]: { bg: '#3a1a1a', color: '#ff4444', text: '🎯 SIGNAL' }
    };

    const s = stateStyles[newState] || stateStyles[STATES.IDLE];
    badge.style.background = s.bg;
    badge.style.color = s.color;
    badge.innerText = s.text;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA SCRAPING
// ═══════════════════════════════════════════════════════════════════════════════

let previousTopTrade = null;
let debugModeEnabled = true; // Enable debug mode by default for now

export function debugDOM() {
    console.log("--- DEBUG DOM DUMP ---");
    console.log("URL:", window.location.href);

    // Dump all tables
    const tables = document.querySelectorAll('table');
    console.log(`Found ${tables.length} tables.`);
    tables.forEach((t, i) => {
        console.log(`Table ${i}:`, t.innerText.substring(0, 200) + "...");
        console.log(`Table ${i} HTML:`, t.outerHTML.substring(0, 500) + "...");
    });

    // Dump potential depth containers
    const depthContainers = document.querySelectorAll('.market-depth, [class*="depth"], [class*="order"]');
    console.log(`Found ${depthContainers.length} potential depth containers.`);
    depthContainers.forEach((c, i) => {
        console.log(`Container ${i}:`, c.className, c.innerText.substring(0, 100));
    });
    console.log("--- END DEBUG DUMP ---");
}

export function getRealTimeTrades() {
    const tables = document.querySelectorAll(SELECTORS.tradesTable);
    let tradesTable = null;

    for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim());
        if (headers.includes('Traded Quantity')) {
            tradesTable = table;
            break;
        }
    }

    const trades = [];
    const scrapeTime = Date.now();

    if (tradesTable) {
        tradesTable.querySelectorAll(SELECTORS.tradeRows).forEach((row, idx) => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 3) {
                const timeStr = cols[0].innerText.trim();
                const qty = cleanNumber(cols[1].innerText);
                const price = cleanNumber(cols[2].innerText);

                trades.push({
                    idx: idx,
                    timeStr: timeStr,
                    seconds: parseTimeToSeconds(timeStr),
                    quantity: qty,
                    price: price,
                    value: qty * price,
                    scrapedAt: scrapeTime
                });
            }
        });
    } else {
        if (debugModeEnabled && Math.random() < 0.05) { // Log occasionally to avoid spam
            console.warn("Trades Table NOT Found!");
            debugDOM();
        }
    }

    let newCount = 0;
    if (trades.length > 0) {
        if (!previousTopTrade) {
            newCount = trades.length;
        } else {
            // Find index of previousTopTrade in current trades
            const idx = trades.findIndex(t =>
                t.timeStr === previousTopTrade.timeStr &&
                t.price === previousTopTrade.price &&
                t.quantity === previousTopTrade.quantity
            );

            if (idx === -1) {
                // Not found -> All new (or flushed)
                newCount = trades.length;
            } else {
                // Found at index 'idx'. So 0 to idx-1 are new.
                newCount = idx;
            }
        }
        previousTopTrade = trades[0];
    }

    const hasNewTrades = newCount > 0;

    return { trades, hasNewTrades, newCount, scrapeTime };
}

function parseTimeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.replace(/[AP]M/gi, '').trim().split(':');
    if (parts.length < 2) return 0;

    let hours = parseInt(parts[0]) || 0;
    const mins = parseInt(parts[1]) || 0;
    const secs = parseInt(parts[2]) || 0;

    if (timeStr.toLowerCase().includes('pm') && hours < 12) hours += 12;
    if (timeStr.toLowerCase().includes('am') && hours === 12) hours = 0;

    return hours * 3600 + mins * 60 + secs;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OPTIONS CHAIN ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

export function isOptionsChain() {
    try {
        // Method 1: URL check
        if (window.location.href.includes('option-chain') || 
            window.location.href.includes('optionchain') ||
            window.location.href.includes('options')) return true;

        // Method 2: Check for "Open Interest" column (very reliable indicator)
        const allText = document.body.innerText || '';
        if (allText.includes('Open Interest') && allText.includes('Strike')) return true;

        // Method 3: Check table headers for strike + OI
        const headers = Array.from(document.querySelectorAll('th'));
        let hasStrike = false;
        let hasOI = false;
        
        headers.forEach(th => {
            const text = (th.innerText || th.textContent || '').toLowerCase();
            if (text.includes('strike') || text.includes('strike price')) hasStrike = true;
            if (text.includes('open interest') || text === 'oi' || text.includes('oi')) hasOI = true;
        });
        
        if (hasStrike && hasOI) return true;

        // Method 4: Check for option chain container
        if (document.querySelector(SELECTORS.optionChainContainer)) return true;

        // Method 5: Check active tab text
        const activeTab = document.querySelector(SELECTORS.activeTab);
        if (activeTab) {
            const tabText = (activeTab.innerText || '').toLowerCase();
            if (tabText.includes('option') || tabText.includes('chain')) return true;
        }

        // Method 6: Check for table with both Call and Put data (side-by-side structure)
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
            const tableText = (table.innerText || '').toLowerCase();
            // Options chain typically has: Strike in middle, Call data on left, Put data on right
            if (tableText.includes('strike') && 
                (tableText.includes('call') || tableText.includes('put') || 
                 tableText.includes('ce') || tableText.includes('pe'))) {
                return true;
            }
        }

        return false;
    } catch (e) {
        console.warn("isOptionsChain check failed:", e);
        return false;
    }
}

export function processOptionsChain(sectorScore) {
    // 🔧 FIX: Try multiple methods to find options chain table
    const tables = Array.from(document.querySelectorAll('table'));
    
    // Method 1: Look for table with Strike + OI
    let ocTable = tables.find(t => {
        const text = (t.innerText || t.textContent || '').toLowerCase();
        return text.includes('strike') && (text.includes('open interest') || text.includes('oi'));
    });

    // Method 2: Check container selector
    if (!ocTable) {
        const container = document.querySelector(SELECTORS.optionChainContainer);
        if (container) ocTable = container.querySelector('table');
    }
    
    // Method 3: Look for table with Call/Put structure
    if (!ocTable) {
        ocTable = tables.find(t => {
            const text = (t.innerText || t.textContent || '').toLowerCase();
            const headers = Array.from(t.querySelectorAll('th')).map(th => (th.innerText || '').toLowerCase());
            return (text.includes('strike') || headers.some(h => h.includes('strike'))) &&
                   (text.includes('call') || text.includes('put') || headers.some(h => h.includes('call') || h.includes('put')));
        });
    }
    
    // Method 4: Look for any table with strike price column
    if (!ocTable) {
        ocTable = tables.find(t => {
            const headers = Array.from(t.querySelectorAll('th')).map(th => (th.innerText || '').toLowerCase());
            return headers.some(h => h.includes('strike')) && headers.length >= 5; // Options chain has many columns
        });
    }

    if (!ocTable) {
        // 🔧 FIX: Don't log if we're not on options page (expected behavior)
        // Only log in debug mode or if explicitly on options page
        return null;
    }

    const headerCells = Array.from(ocTable.querySelectorAll('th'));
    const headerTexts = headerCells.map(th => (th.innerText || th.textContent || '').trim());

    let strikeIdx = -1;
    let callLtpIdx = -1;
    let putLtpIdx = -1;
    let callOIIdx = -1;
    let putOIIdx = -1;

    strikeIdx = headerTexts.findIndex(h => h.includes('Strike'));

    if (strikeIdx === -1) return null;

    for (let i = strikeIdx - 1; i >= 0; i--) {
        if (headerTexts[i].includes('LTP')) {
            callLtpIdx = i;
            break;
        }
    }

    for (let i = strikeIdx + 1; i < headerTexts.length; i++) {
        if (headerTexts[i].includes('LTP')) {
            putLtpIdx = i;
            break;
        }
    }

    for (let i = 0; i < strikeIdx; i++) {
        if (headerTexts[i].includes('Open Interest') || headerTexts[i] === 'OI') {
            callOIIdx = i;
            break;
        }
    }

    for (let i = headerTexts.length - 1; i > strikeIdx; i--) {
        if (headerTexts[i].includes('Open Interest') || headerTexts[i] === 'OI') {
            putOIIdx = i;
            break;
        }
    }

    let totalCallOI = 0;
    let totalPutOI = 0;
    let currentLTP = 0;

    if (currentLTP === 0) {
        const spotPill = Array.from(document.querySelectorAll('.spot-price, .current-price, .ltp-badge')).find(el => {
            return el.offsetParent !== null && /[0-9]/.test(el.innerText);
        });
        if (spotPill) currentLTP = cleanNumber(spotPill.innerText);
    }

    if (currentLTP === 0) {
        const nameEl = document.querySelector(SELECTORS.stockName);
        if (nameEl) {
            const parent = nameEl.closest('div, header');
            if (parent) {
                const priceEl = parent.querySelector('.ltp, .val, .price');
                if (priceEl) currentLTP = cleanNumber(priceEl.innerText);
            }
        }
    }

    if (currentLTP === 0) {
        const titleMatch = document.title.match(/([0-9,]+\.[0-9]{2})/);
        if (titleMatch) currentLTP = cleanNumber(titleMatch[1]);
    }

    if (currentLTP === 0) {
        const ltpEl = document.querySelector(SELECTORS.stockPrice);
        if (ltpEl) currentLTP = cleanNumber(ltpEl.innerText);
    }

    let atmStrike = 0;
    let atmCallLTP = 0;
    let atmPutLTP = 0;
    let minDiff = Infinity;

    // ─────────────────────────────────────────────────────────────────────────
    // 📊 COMPLETE OPTION CHAIN ANALYSIS (Strike-by-Strike)
    // ─────────────────────────────────────────────────────────────────────────
    const strikeData = []; // Store OI, LTP, Volume for each strike
    let maxCallOI = 0;
    let maxPutOI = 0;
    let maxCallOIStrike = 0;
    let maxPutOIStrike = 0;
    let totalCallVolume = 0;
    let totalPutVolume = 0;

    // Try to find Volume columns (if available)
    let callVolIdx = -1;
    let putVolIdx = -1;
    for (let i = 0; i < strikeIdx; i++) {
        if (headerTexts[i].includes('Volume') || headerTexts[i] === 'Vol') {
            callVolIdx = i;
            break;
        }
    }
    for (let i = headerTexts.length - 1; i > strikeIdx; i--) {
        if (headerTexts[i].includes('Volume') || headerTexts[i] === 'Vol') {
            putVolIdx = i;
            break;
        }
    }

    const rows = ocTable.querySelectorAll('tbody tr');
    if (rows.length === 0) return null;

    rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        const maxIdx = Math.max(strikeIdx, callOIIdx, putOIIdx, callLtpIdx, putLtpIdx, callVolIdx, putVolIdx);
        if (cols.length > maxIdx) {
            const strikePrice = cleanNumber(cols[strikeIdx]?.innerText);
            if (strikePrice <= 0) return; // Skip invalid strikes

            const callOI = callOIIdx !== -1 ? cleanNumber(cols[callOIIdx]?.innerText) : 0;
            const putOI = putOIIdx !== -1 ? cleanNumber(cols[putOIIdx]?.innerText) : 0;
            const callLTP = callLtpIdx !== -1 ? cleanNumber(cols[callLtpIdx]?.innerText) : 0;
            const putLTP = putLtpIdx !== -1 ? cleanNumber(cols[putLtpIdx]?.innerText) : 0;
            const callVol = callVolIdx !== -1 ? cleanNumber(cols[callVolIdx]?.innerText) : 0;
            const putVol = putVolIdx !== -1 ? cleanNumber(cols[putVolIdx]?.innerText) : 0;

            // Accumulate totals
            totalCallOI += callOI;
            totalPutOI += putOI;
            totalCallVolume += callVol;
            totalPutVolume += putVol;

            // Track max OI strikes (potential walls)
            if (callOI > maxCallOI) {
                maxCallOI = callOI;
                maxCallOIStrike = strikePrice;
            }
            if (putOI > maxPutOI) {
                maxPutOI = putOI;
                maxPutOIStrike = strikePrice;
            }

            // Store strike-by-strike data
            strikeData.push({
                strike: strikePrice,
                callOI,
                putOI,
                callLTP,
                putLTP,
                callVol,
                putVol,
                pcr: callOI > 0 ? putOI / callOI : (putOI > 0 ? 999 : 0) // Strike-wise PCR
            });

            // Find ATM Strike
            if (currentLTP > 0) {
                const diff = Math.abs(strikePrice - currentLTP);
                if (diff < minDiff) {
                    minDiff = diff;
                    atmStrike = strikePrice;
                    atmCallLTP = callLTP;
                    atmPutLTP = putLTP;
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🎯 MAX PAIN CALCULATION
    // ─────────────────────────────────────────────────────────────────────────
    // Max Pain = Strike where total option value (calls + puts) is minimized
    let maxPainStrike = atmStrike;
    let minTotalValue = Infinity;

    strikeData.forEach(data => {
        let totalValue = 0;
        strikeData.forEach(s => {
            if (s.strike < data.strike) {
                // ITM Calls (strike < spot) have intrinsic value
                totalValue += s.callOI * Math.max(0, data.strike - s.strike);
            } else if (s.strike > data.strike) {
                // ITM Puts (strike > spot) have intrinsic value
                totalValue += s.putOI * Math.max(0, s.strike - data.strike);
            }
        });
        if (totalValue < minTotalValue) {
            minTotalValue = totalValue;
            maxPainStrike = data.strike;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🧱 OI WALLS (Support/Resistance from High OI)
    // ─────────────────────────────────────────────────────────────────────────
    const OI_WALL_THRESHOLD = Math.max(maxCallOI, maxPutOI) * 0.3; // 30% of max OI
    const callWalls = strikeData
        .filter(s => s.callOI > OI_WALL_THRESHOLD && s.strike > currentLTP)
        .sort((a, b) => b.callOI - a.callOI)
        .slice(0, 3) // Top 3 call walls
        .map(s => ({ strike: s.strike, oi: s.callOI }));

    const putWalls = strikeData
        .filter(s => s.putOI > OI_WALL_THRESHOLD && s.strike < currentLTP)
        .sort((a, b) => b.putOI - a.putOI)
        .slice(0, 3) // Top 3 put walls
        .map(s => ({ strike: s.strike, oi: s.putOI }));

    // ─────────────────────────────────────────────────────────────────────────
    // 📊 PCR ANALYSIS (Strike-wise)
    // ─────────────────────────────────────────────────────────────────────────
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;
    
    // Find strikes with extreme PCR (potential reversal zones)
    const highPCRStrikes = strikeData
        .filter(s => s.pcr > 2.0 && s.putOI > 100000) // PCR > 2.0 with significant OI
        .sort((a, b) => b.pcr - a.pcr)
        .slice(0, 3)
        .map(s => ({ strike: s.strike, pcr: s.pcr, putOI: s.putOI }));

    const lowPCRStrikes = strikeData
        .filter(s => s.pcr < 0.5 && s.callOI > 100000) // PCR < 0.5 with significant OI
        .sort((a, b) => a.pcr - b.pcr)
        .slice(0, 3)
        .map(s => ({ strike: s.strike, pcr: s.pcr, callOI: s.callOI }));

    return {
        // Basic Metrics
        totalCallOI,
        totalPutOI,
        totalCallVolume,
        totalPutVolume,
        pcr,
        timestamp: Date.now(),
        ltp: currentLTP,
        atmStrike,
        atmCallLTP,
        atmPutLTP,
        sectorScore: sectorScore,

        // Advanced Analysis
        maxPainStrike,
        maxCallOI,
        maxPutOI,
        maxCallOIStrike, // Largest Call Wall
        maxPutOIStrike, // Largest Put Wall
        callWalls, // Top 3 Call Resistance Levels
        putWalls, // Top 3 Put Support Levels
        highPCRStrikes, // Strikes with PCR > 2.0 (Put Heavy)
        lowPCRStrikes, // Strikes with PCR < 0.5 (Call Heavy)
        strikeData, // Complete strike-by-strike data
        strikeCount: strikeData.length
    };
}

// New function to update the options UI (Display in Signal Box)
export function updateOptionsUI(optionsData) {
    if (!optionsData || optionsData.pcr === 0) {
        return; // Don't display if no valid data
    }

    // Update Signal Box with Options Chain Data
    const signalBox = document.getElementById('signalBox');
    if (!signalBox) return;
    
    const pcrColor = optionsData.pcr > 1.0 ? '#00c853' : optionsData.pcr < 0.8 ? '#ff4444' : '#00d4ff';
    const pcrTrend = optionsData.pcrTrend || 0;
    const trendArrow = pcrTrend > 0.05 ? '▲' : pcrTrend < -0.05 ? '▼' : '';
    const trendColor = pcrTrend > 0.05 ? '#00c853' : pcrTrend < -0.05 ? '#ff4444' : '#888';
    
    // 🔧 FIX: Build clean options HTML without duplication
    let optionsHTML = `
        <div style='padding: 8px; border-bottom: 1px solid #222; background: #0f0f1a;'>
            <div style='color:#00d4ff; font-weight:bold; font-size:11px; margin-bottom:8px; display:flex; align-items:center; gap:4px;'>
                <span>📊 OPTIONS CHAIN</span>
            </div>
            <div style='display:grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size:10px;'>
                <div style='display:flex; justify-content:space-between;'>
                    <span style="color:#888">PCR:</span>
                    <span style="color:${pcrColor}; font-weight:bold">${optionsData.pcr.toFixed(2)}</span>
                </div>
                ${pcrTrend !== 0 ? `<div style='display:flex; justify-content:space-between;'>
                    <span style="color:#888">Trend:</span>
                    <span style="color:${trendColor}; font-size:9px;">${trendArrow} ${(Math.abs(pcrTrend) * 100).toFixed(1)}%</span>
                </div>` : ''}
                <div style='display:flex; justify-content:space-between;'>
                    <span style="color:#888">ATM:</span>
                    <span style="color:#00d4ff">${optionsData.atmStrike || '--'}</span>
                </div>
                <div style='display:flex; justify-content:space-between;'>
                    <span style="color:#888">Call OI:</span>
                    <span style="color:#00c853">${(optionsData.totalCallOI / 100000).toFixed(1)}L</span>
                </div>
                <div style='display:flex; justify-content:space-between;'>
                    <span style="color:#888">Put OI:</span>
                    <span style="color:#ff4444">${(optionsData.totalPutOI / 100000).toFixed(1)}L</span>
                </div>
    `;
    
    // Add Max Pain if available
    if (optionsData.maxPainStrike && optionsData.maxPainStrike > 0) {
        const distToMaxPain = optionsData.ltp > 0 ? Math.abs(optionsData.ltp - optionsData.maxPainStrike) : 0;
        const distPct = optionsData.ltp > 0 ? (distToMaxPain / optionsData.ltp * 100).toFixed(2) : '--';
        optionsHTML += `
            <div style='display:flex; justify-content:space-between;'>
                <span style="color:#888">Max Pain:</span>
                <span style="color:#ffaa00">${optionsData.maxPainStrike} (${distPct}%)</span>
            </div>
        `;
    }
    
    // Add OI Walls if available (only top wall to avoid clutter)
    if (optionsData.callWalls && optionsData.callWalls.length > 0) {
        const topWall = optionsData.callWalls[0];
        optionsHTML += `
            <div style='display:flex; justify-content:space-between;'>
                <span style="color:#888">Call Wall:</span>
                <span style="color:#ff4444">${topWall.strike} (${(topWall.oi / 100000).toFixed(1)}L)</span>
            </div>
        `;
    }
    
    if (optionsData.putWalls && optionsData.putWalls.length > 0) {
        const topWall = optionsData.putWalls[0];
        optionsHTML += `
            <div style='display:flex; justify-content:space-between;'>
                <span style="color:#888">Put Wall:</span>
                <span style="color:#00c853">${topWall.strike} (${(topWall.oi / 100000).toFixed(1)}L)</span>
            </div>
        `;
    }
    
    optionsHTML += `</div></div>`;
    
    // 🔧 FIX: Clean replacement - remove old options section and add new one
    const existingContent = signalBox.innerHTML;
    
    // Remove any existing OPTIONS CHAIN section (handle various formats)
    const cleanedContent = existingContent
        .replace(/<div[^>]*>[\s\S]*?📊 OPTIONS CHAIN[\s\S]*?<\/div><\/div>/gi, '')
        .replace(/<div[^>]*>[\s\S]*?OPTIONS CHAIN[\s\S]*?<\/div>/gi, '');
    
    // If there are signals, prepend options. Otherwise, show options + waiting message
    if (cleanedContent.trim() && !cleanedContent.includes('Waiting for Signals')) {
        signalBox.innerHTML = optionsHTML + cleanedContent;
    } else {
        signalBox.innerHTML = optionsHTML + `<div style='color: #444; font-style:italic; text-align:center; padding-top:10px;'>Waiting for Signals...</div>`;
    }
    
    // Also update optionsBox if it exists (for backward compatibility)
    const optionsBox = document.getElementById('optionsBox');
    if (optionsBox) {
        optionsBox.style.display = 'block';
        optionsBox.innerHTML = `
            <div style="display:flex; justify-content:space-between; padding: 8px 15px; font-size: 10px; border-bottom: 1px solid #222;">
                <span style="color:#666">PCR:</span>
                <span style="color:#00d4ff">${optionsData.pcr.toFixed(2)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding: 8px 15px; font-size: 10px; border-bottom: 1px solid #222;">
                <span style="color:#666">ATM Strike:</span>
                <span style="color:#00d4ff">${optionsData.atmStrike}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding: 8px 15px; font-size: 10px;">
                <span style="color:#666">ATM Call/Put LTP:</span>
                <span style="color:#00d4ff">${optionsData.atmCallLTP}/${optionsData.atmPutLTP}</span>
            </div>
        `;
    }
}

export function initPanel(callbacks) {
    const panel = document.createElement('div');
    panel.id = 'tradePanel';
    panel.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 300px;
        background: #0a0a12;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.8);
        font-family: 'JetBrains Mono', monospace;
        color: #eee;
        z-index: 2147483647;
        overflow: hidden;
        resize: both;
        min-width: 250px;
        min-height: 200px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        border: 1px solid #222;
    `;

    // 1. HEADER
    const header = document.createElement('div');
    header.id = 'panelHeader';
    header.style.cssText = `
        background: linear-gradient(90deg, #1a1a2e 0%, #16213e 100%);
        padding: 12px 15px;
        font-size: 13px;
        font-weight: 800;
        color: #00d4ff;
        cursor: grab;
        border-bottom: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
        letter-spacing: 1px;
        text-transform: uppercase;
        user-select: none;
    `;
    header.innerHTML = `
        <span>Strategy Intelligence</span>
        <span id="statusIndicator" class="status-dot"></span>
    `;

    // 2. MARKET BIAS (The General)
    const biasBar = document.createElement('div');
    biasBar.id = 'marketBias';
    biasBar.className = 'bias-neutral';
    biasBar.innerText = 'NEUTRAL (WAITING)';

    // 2.1 GLOBAL CONTEXT (VIX + PEERS)
    const contextBar = document.createElement('div');
    contextBar.id = 'contextBar';
    contextBar.style.cssText = `
        display: flex;
        justify-content: space-between;
        padding: 6px 12px;
        background: #111;
        border-bottom: 1px solid #222;
        font-size: 10px;
        color: #888;
    `;
    contextBar.innerHTML = `
        <span id="vixDisplay">VIX: --</span>
        <span id="sectorDisplay">SEC: --</span>
        <span id="bankNiftyDisplay">BN: --</span>
    `;

    // 3. STRATEGY GRID (The Plan)
    const strategyGrid = document.createElement('div');
    strategyGrid.id = 'strategyGrid';
    strategyGrid.innerHTML = `
        <div class="strat-card" id="strat-whale" title="🐋 WHALE: Institutional Options Activity\nHigh % = Strong PCR trend, Options OI active\nSignals: WHALE_BUY/SELL (PCR-based)">
            <div class="strat-header"><span>🐋 WHALE</span> <span class="strat-score">0%</span></div>
            <div class="progress-bg"><div class="progress-fill" style="width: 0%"></div></div>
        </div>
        <div class="strat-card" id="strat-beast" title="🐻 BEAST: Momentum & Velocity\nHigh % = Strong tape momentum, High velocity\nSignals: BEAST_BUY/SELL (Tape + Zones)">
            <div class="strat-header"><span>🐻 BEAST</span> <span class="strat-score">0%</span></div>
            <div class="progress-bg"><div class="progress-fill" style="width: 0%"></div></div>
        </div>
        <div class="strat-card" id="strat-trap" title="🪤 TRAP: Reversion/Squeeze Setup\nHigh % = Extreme RSI (70+/30-), Reversion likely\nSignals: TRAP_BUY/SELL (Squeeze plays)">
            <div class="strat-header"><span>🪤 TRAP</span> <span class="strat-score">0%</span></div>
            <div class="progress-bg"><div class="progress-fill" style="width: 0%"></div></div>
        </div>
        <div class="strat-card" id="strat-retail" title="🤡 RETAIL: Fade The Crowd\nHigh % = Extreme retail sentiment, Contrarian setup\nSignals: RETAIL_PANIC/EUPHORIA (Fade retail)">
            <div class="strat-header"><span>🤡 RETAIL</span> <span class="strat-score">0%</span></div>
            <div class="progress-bg"><div class="progress-fill" style="width: 0%"></div></div>
        </div>
    `;

    // 4. SIGNAL BOX (The Execution)
    const signalBox = document.createElement('div');
    signalBox.id = 'signalBox';
    signalBox.innerHTML = `<div style='color: #444; font-style:italic; text-align:center; padding-top:10px;'>Waiting for Signals...</div>`;

    // 5. STATS ROW
    const statsRow = document.createElement('div');
    statsRow.style.cssText = `
        display: flex; 
        justify-content: space-between; 
        font-size: 10px; 
        color: #888;
        padding: 8px 15px;
        background: #0d0d15;
        border-top: 1px solid #222;
    `;
    statsRow.innerHTML = `
        <span id="obiDisplay">OBI: --</span>
        <span id="velocityDisplay">VEL: --</span>
        <span id="recDisplay">REC: 0</span>
    `;

    // 6. CONTROLS
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = `
        padding: 10px 15px;
        background: #0a0a12;
        border-top: 1px solid #222;
    `;

    // 6.1 AUTO RECORD TOGGLE
    const autoContainer = document.createElement('div');
    autoContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    `;

    const chkAuto = document.createElement('input');
    chkAuto.type = "checkbox";
    chkAuto.id = "chkAutoRecord";
    chkAuto.style.cssText = `cursor: pointer; accent-color: #00d4ff;`;
    if (callbacks.onAutoChange) chkAuto.addEventListener('change', callbacks.onAutoChange);

    const lblAuto = document.createElement('label');
    lblAuto.innerText = "Smart Mode (9:15 - 3:30)";
    lblAuto.htmlFor = "chkAutoRecord";
    lblAuto.style.cssText = `cursor: pointer; font-size: 11px; color: #888;`;

    autoContainer.appendChild(chkAuto);
    autoContainer.appendChild(lblAuto);
    controlsContainer.appendChild(autoContainer);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = `display: flex; gap: 8px;`;

    const btnToggle = document.createElement('button');
    btnToggle.innerText = "▶ START"; // Start with START (not recording initially)
    btnToggle.className = 'btn-primary';
    btnToggle.id = 'btnToggle'; // Ensure ID is set for index.js to find it
    if (callbacks.onToggle) btnToggle.addEventListener('click', callbacks.onToggle);

    const btnReset = document.createElement('button');
    btnReset.innerText = "↻";
    btnReset.className = 'btn-icon';
    if (callbacks.onReset) btnReset.addEventListener('click', callbacks.onReset);

    const btnDownload = document.createElement('button');
    btnDownload.innerText = "⬇";
    btnDownload.className = 'btn-icon';
    if (callbacks.onDownload) btnDownload.addEventListener('click', callbacks.onDownload);

    btnContainer.appendChild(btnToggle);
    btnContainer.appendChild(btnReset);
    btnContainer.appendChild(btnDownload);
    controlsContainer.appendChild(btnContainer);

    // ASSEMBLE
    panel.appendChild(header);
    panel.appendChild(biasBar);
    panel.appendChild(contextBar);
    panel.appendChild(strategyGrid);
    panel.appendChild(signalBox);
    panel.appendChild(statsRow);
    panel.appendChild(controlsContainer);

    document.body.appendChild(panel);

    // DRAG LOGIC
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.onmousedown = (e) => {
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        header.style.cursor = 'grabbing';
    };

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            e.preventDefault();
            panel.style.left = (e.clientX - dragOffsetX) + 'px';
            panel.style.top = (e.clientY - dragOffsetY) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'grab';
        }
    });

    // INJECT STYLES
    const style = document.createElement('style');
    style.innerHTML = `
        /* BIAS BAR */
        #marketBias {
            padding: 8px;
            text-align: center;
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 1px;
            border-bottom: 1px solid #222;
        }
        .bias-bullish { background: rgba(0, 200, 83, 0.2); color: #00ff88; }
        .bias-bearish { background: rgba(255, 68, 68, 0.2); color: #ff4444; }
        .bias-neutral { background: #222; color: #888; }

        /* STRATEGY GRID */
        #strategyGrid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            padding: 10px;
            background: #111;
        }
        .strat-card {
            background: #1a1a2e;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid #333;
        }
        .strat-header {
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            margin-bottom: 4px;
            color: #ccc;
        }
        .progress-bg {
            height: 4px;
            background: #333;
            border-radius: 2px;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: #00d4ff;
            transition: width 0.3s ease;
        }

        /* SIGNAL BOX */
        #signalBox {
            flex: 1;
            background: #0d0d15;
            padding: 10px;
            overflow-y: auto;
            font-size: 12px;
            border-top: 1px solid #222;
        }

        /* BUTTONS */
        .btn-primary {
            flex: 1;
            padding: 10px;
            background: linear-gradient(135deg, #00c853 0%, #00a843 100%);
            color: white;
            border: none;
            border-radius: 6px;
            font-weight: bold;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .btn-icon {
            padding: 10px 14px;
            background: #2a2a3a;
            color: #ccc;
            border: none;
            border-radius: 6px;
            cursor: pointer;
        }

        /* UTILS */
        .status-dot {
            width: 8px; height: 8px; border-radius: 50%; background: #ff9800; display: inline-block;
        }
        .signal-toast { 
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            padding: 12px 24px; border-radius: 8px; color: white; 
            z-index: 2147483648; animation: slideDown 0.3s ease, fadeOut 4s forwards;
            font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        @keyframes slideDown { from { transform: translate(-50%, -20px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
        @keyframes fadeOut { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
    `;
    document.head.appendChild(style);
}
