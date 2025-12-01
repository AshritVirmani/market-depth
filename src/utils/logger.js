import { getStockName, showToast } from './dom';
import { state } from '../core/state';
import { getPortfolio } from '../core/paperTrader';

let recordedData = [];

export function recordSnapshot(snapshot) {
    recordedData.push(snapshot);
}

export function getRecordedDataLength() {
    return recordedData.length;
}

export function clearRecordedData() {
    recordedData = [];
}

export function downloadData() {
    const stockName = state.symbol || getStockName() || "hybrid_quant";
    const portfolio = getPortfolio();

    const exportData = {
        data: recordedData,
        paperTrades: portfolio.journal,
        activePositions: portfolio.positions,
        finalBalance: portfolio.balance
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    // Generate Clean Filename
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5); // HH-MM
    const count = recordedData.length;
    const cleanName = `${stockName}_${dateStr}_${timeStr}_${count}snaps.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = cleanName;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Saved: ${cleanName}`, '#00d4ff', '⬇');
}
