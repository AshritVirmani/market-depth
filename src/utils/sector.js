import { state } from '../core/state';
import { getStockName } from './dom';
import { broadcastUpdate, getMarketContext, getSectorFromSync } from './sync';

export function broadcastSectorStatus(obi, isPanic, bestBid, velocity) {
    const symbol = state.symbol || getStockName();

    // Broadcast to all other tabs via BroadcastChannel
    broadcastUpdate('PEER_UPDATE', {
        symbol: symbol,
        obi: obi,
        isPanic: isPanic,
        ltp: bestBid,
        velocity: velocity
    });
}

export function getSectorSentiment() {
    // Get aggregated sector data from sync.js
    const sentiment = getSectorFromSync();
    
    // UI is now updated automatically by sync.js when PEER_UPDATE is received
    // Just return the sentiment for strategy use
    return sentiment;
}
