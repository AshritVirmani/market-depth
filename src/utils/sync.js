// Cross-Tab Communication for the "Black Box"
// Allows HDFC Tab to know what ICICI/SBIN/etc Tabs are doing.

import { SECTOR_PEERS, BANK_WEIGHTS, SECTOR_STALE_MS } from '../config';

const channel = new BroadcastChannel('DHAN_BOX_SYNC');

let marketState = {
    sectorTrend: 'FLAT', // BankNifty Trend
    sectorLTP: 0,
    vixValue: 0,
    vixRegime: 'NORMAL', // LOW, NORMAL, HIGH
    peers: {}, // Store data from each peer tab
    options: {}
};

// Calculate sector sentiment from all peer data
function calculateSectorSentiment() {
    let netScore = 0;
    let panicCount = 0;
    let bullishCount = 0;
    let activeCount = 0;
    const connectedPeers = [];
    const now = Date.now();

    SECTOR_PEERS.forEach(peer => {
        const peerData = marketState.peers[peer];
        if (!peerData) return;

        // Check if data is stale
        if (now - peerData.timestamp > SECTOR_STALE_MS) return;

        activeCount++;
        connectedPeers.push(peer);
        const weight = BANK_WEIGHTS[peer] || 0.05;

        if (peerData.isPanic) panicCount++;
        if (peerData.obi > 20) bullishCount++;

        netScore += peerData.obi * weight;
    });

    return {
        netScore: Math.round(netScore * 10) / 10,
        panicCount,
        bullishCount,
        activeCount,
        connectedPeers
    };
}

export function broadcastUpdate(type, data) {
    channel.postMessage({ type, data, timestamp: Date.now() });
}

export function listenToMarket(onUpdate) {
    channel.onmessage = (event) => {
        const { type, data, timestamp } = event.data;

        if (type === 'BANKNIFTY_UPDATE') {
            marketState.sectorTrend = data.trend;
            marketState.sectorLTP = data.ltp;
        }

        if (type === 'VIX_UPDATE') {
            marketState.vixValue = data.ltp;
            // 🔧 FIX: Use regime from data if provided, otherwise calculate
            marketState.vixRegime = data.regime || (data.ltp < 12 ? 'LOW' : (data.ltp > 16 ? 'HIGH' : 'NORMAL'));
        }

        if (type === 'OPTIONS_UPDATE') {
            marketState.options[data.symbol] = data;
        }

        // 🔥 NEW: Handle peer updates from other bank tabs
        if (type === 'PEER_UPDATE' && data.symbol) {
            marketState.peers[data.symbol] = {
                obi: data.obi,
                isPanic: data.isPanic,
                ltp: data.ltp,
                velocity: data.velocity,
                timestamp: timestamp || Date.now()
            };

            // Update sector status UI
            updateSectorUI();
        }

        if (onUpdate) onUpdate(type, data);
    };
}

function updateSectorUI() {
    const sectorStatus = document.getElementById('sectorStatus');
    if (!sectorStatus) return;

    const sentiment = calculateSectorSentiment();

    if (sentiment.activeCount === 0) {
        sectorStatus.innerHTML = `<span style="color:#555">No peers active</span>`;
        sectorStatus.title = "Open other bank tabs to enable Sector Sync";
    } else if (sentiment.panicCount >= 2) {
        sectorStatus.innerHTML = `<span style="color:#ff4444">⚠️ SECTOR PANIC (${sentiment.panicCount} falling)</span>`;
        sectorStatus.title = `Connected: ${sentiment.connectedPeers.join(', ')}`;
    } else if (sentiment.bullishCount >= 2) {
        sectorStatus.innerHTML = `<span style="color:#00c853">✓ SECTOR BULLISH (${sentiment.bullishCount} strong)</span>`;
        sectorStatus.title = `Connected: ${sentiment.connectedPeers.join(', ')}`;
    } else {
        const scoreColor = sentiment.netScore > 0 ? '#00c853' : sentiment.netScore < 0 ? '#ff4444' : '#888';
        sectorStatus.innerHTML = `<span style="color:${scoreColor}">${sentiment.activeCount} peers | Score: ${sentiment.netScore}</span>`;
        sectorStatus.title = `Connected: ${sentiment.connectedPeers.join(', ')}`;
    }
}

export function getMarketContext() {
    return {
        ...marketState,
        sector: calculateSectorSentiment()
    };
}

export function getSectorFromSync() {
    return calculateSectorSentiment();
}
