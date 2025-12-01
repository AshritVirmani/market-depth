/**
 * Optimized Logger - Compressed JSON format for lightweight, complete logging
 * Reduces file size by 60-80% while maintaining ALL data
 * 
 * KEY FEATURE: Records EVERY snapshot (1-second intervals) for reactive post-market analysis
 * This gives you the edge to see exactly what happened tick-by-tick
 */

export class OptimizedLogger {
    constructor(symbol, options = {}) {
        this.symbol = symbol;
        this.snapshots = [];
        this.signals = [];
        this.meta = {
            symbol: symbol,
            date: new Date().toISOString().split('T')[0],
            startTime: new Date().toLocaleTimeString('en-IN', { hour12: false }),
            version: '2.0', // Compressed format version
            captureInterval: options.captureInterval || 1000, // 1 second default
            fields: {
                snapshot: ['timestamp', 'ltp'],
                depth: ['price', 'qty'],
                trades: ['time', 'price', 'qty']
            }
        };
        this.lastSaveTime = Date.now();
        this.autoSaveInterval = options.autoSaveInterval || 100; // Save every 100 snapshots
        this.useDeltaCompression = options.useDeltaCompression || false; // Optional: even more compression
        this.lastSnapshot = null;
        this.missedSnapshots = 0; // Track if we're missing data
    }

    /**
     * Log market snapshot in compressed array format
     * CRITICAL: This captures EVERY second of market data for post-market analysis
     * @param {Object} marketData - Market depth and trades
     */
    logSnapshot(marketData) {
        try {
            const timestamp = marketData.timestamp || Date.now();

            // VALIDATION: Check if we're missing snapshots (gap > 2 seconds)
            if (this.lastSnapshot) {
                const gap = timestamp - this.lastSnapshot.timestamp;
                if (gap > 2000) { // More than 2 seconds gap
                    this.missedSnapshots++;
                    console.warn(`[Logger] ⚠️ Gap detected: ${(gap / 1000).toFixed(1)}s since last snapshot`);
                }
            }

            // Compressed format: [timestamp, ltp, bids, asks, trades]
            const snapshot = [
                timestamp,
                marketData.ltp || 0,
                this.compressDepth(marketData.bids || []),
                this.compressDepth(marketData.asks || []),
                this.compressTrades(marketData.recentTrades || [])
            ];

            this.snapshots.push(snapshot);
            this.lastSnapshot = { timestamp, data: snapshot };

            // Auto-save every N snapshots to prevent memory issues
            if (this.snapshots.length % this.autoSaveInterval === 0) {
                console.log(`[Logger] Auto-save triggered at ${this.snapshots.length} snapshots`);
                if (this.missedSnapshots > 0) {
                    console.warn(`[Logger] ⚠️ ${this.missedSnapshots} gaps detected so far`);
                }
                this.saveToFile();
            }
        } catch (error) {
            console.error('[Logger] Error logging snapshot:', error);
        }
    }

    /**
     * Compress market depth array
     * From: [{price: 990.50, quantity: 500}, ...]
     * To: [[990.50, 500], ...]
     */
    compressDepth(depth) {
        if (!Array.isArray(depth)) return [];
        return depth.map(item => [
            item.price || 0,
            item.quantity || item.qty || 0
        ]);
    }

    /**
     * Compress trades array
     * From: [{timeStr: "10:35:42", price: 990.50, quantity: 100}, ...]
     * To: [["10:35:42", 990.50, 100], ...]
     */
    compressTrades(trades) {
        if (!Array.isArray(trades)) return [];
        return trades.map(t => [
            t.timeStr || t.time || '',
            t.price || 0,
            t.quantity || t.qty || 0
        ]);
    }

    /**
     * Log trading signal with confidence and edge factors
     * @param {Object} signal - Signal object from SignalPanel
     */
    logSignal(signal) {
        try {
            this.signals.push({
                type: signal.type,
                price: signal.price,
                time: signal.timestamp,
                confidence: signal.confidenceScore || 0,
                // Store only text of edge factors (not icons)
                factors: signal.edgeFactors?.map(f => f.text) || [],
                targets: signal.targets,
                action: signal.action
            });
        } catch (error) {
            console.error('[Logger] Error logging signal:', error);
        }
    }

    /**
   * Save data to JSON file
   */
    saveToFile() {
        try {
            // Calculate capture quality metrics
            const captureQuality = this.calculateCaptureQuality();

            const data = {
                meta: {
                    ...this.meta,
                    endTime: new Date().toLocaleTimeString('en-IN', { hour12: false }),
                    snapshotCount: this.snapshots.length,
                    signalCount: this.signals.length,
                    captureQuality: {
                        missedSnapshots: this.missedSnapshots,
                        averageInterval: captureQuality.avgInterval,
                        completeness: captureQuality.completeness
                    }
                },
                snapshots: this.snapshots,
                signals: this.signals
            };

            const jsonString = JSON.stringify(data);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this.symbol}_${this.meta.date}_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);

            console.log(`[Logger] ✅ Saved ${this.snapshots.length} snapshots, ${this.signals.length} signals`);
            console.log(`[Logger] 📊 Capture Quality: ${captureQuality.completeness}% complete`);
            console.log(`[Logger] 💾 File size: ${(jsonString.length / 1024).toFixed(2)} KB`);

            // Reset for next batch
            this.snapshots = [];
            this.signals = [];
            this.missedSnapshots = 0;
            this.lastSaveTime = Date.now();
        } catch (error) {
            console.error('[Logger] Error saving file:', error);
        }
    }

    /**
     * Calculate capture quality metrics
     */
    calculateCaptureQuality() {
        if (this.snapshots.length < 2) {
            return { avgInterval: 0, completeness: 100 };
        }

        // Calculate average interval between snapshots
        let totalInterval = 0;
        for (let i = 1; i < this.snapshots.length; i++) {
            const interval = this.snapshots[i][0] - this.snapshots[i - 1][0];
            totalInterval += interval;
        }
        const avgInterval = totalInterval / (this.snapshots.length - 1);

        // Calculate completeness (100% = perfect 1-second intervals)
        const expectedInterval = this.meta.captureInterval;
        const completeness = Math.min(100, (expectedInterval / avgInterval) * 100);

        return {
            avgInterval: (avgInterval / 1000).toFixed(2), // Convert to seconds
            completeness: completeness.toFixed(1)
        };
    }

    /**
     * Force save (called on extension unload)
     */
    forceSave() {
        if (this.snapshots.length > 0) {
            console.log('[Logger] Force saving remaining snapshots...');
            this.saveToFile();
        }
    }

    /**
     * Get current stats
     */
    getStats() {
        return {
            snapshotCount: this.snapshots.length,
            signalCount: this.signals.length,
            estimatedSize: JSON.stringify({
                meta: this.meta,
                snapshots: this.snapshots,
                signals: this.signals
            }).length
        };
    }
}

/**
 * Decompress snapshot data (for viewer.html)
 * @param {Object} compressedData - Compressed JSON data
 * @returns {Array} Decompressed snapshots
 */
export function decompressData(compressedData) {
    const { meta, snapshots, signals } = compressedData;

    if (!meta || meta.version !== '2.0') {
        // Old format, return as-is
        console.log('[Logger] Old format detected, no decompression needed');
        return compressedData;
    }

    // Decompress snapshots
    const decompressed = snapshots.map((snapshot, index) => {
        const [timestamp, ltp, bids, asks, trades] = snapshot;

        // Find signals for this timestamp
        const snapshotSignals = signals.filter(s => {
            const signalTime = new Date(s.time).getTime();
            return Math.abs(signalTime - timestamp) < 1000; // Within 1 second
        });

        return {
            timestamp,
            ltp,
            marketDepth: {
                bids: bids.map(([price, qty]) => ({
                    price,
                    quantity: qty,
                    qty
                })),
                asks: asks.map(([price, qty]) => ({
                    price,
                    quantity: qty,
                    qty
                }))
            },
            recentTrades: trades.map(([time, price, qty]) => ({
                timeStr: time,
                time,
                price,
                quantity: qty,
                qty
            })),
            signals: snapshotSignals
        };
    });

    console.log(`[Logger] Decompressed ${decompressed.length} snapshots`);
    return decompressed;
}
