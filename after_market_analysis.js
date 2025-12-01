#!/usr/bin/env node

/**
 * 📊 AFTER-MARKET ANALYSIS MODULE
 * 
 * Analyzes collected market data after market closes
 * Generates reports and insights for the trading day
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Analysis configuration
const ANALYSIS_CONFIG = {
    DATA_DIR: './market_data',
    ANALYSIS_DIR: './analysis',
    SNAPSHOT_INTERVAL: 60000, // 1 minute snapshots during market hours
    KEEP_SNAPSHOTS: true,     // Keep compressed snapshots
    GENERATE_REPORT: true      // Generate analysis report
};

// Ensure directories exist
function ensureDirectories() {
    [ANALYSIS_CONFIG.DATA_DIR, ANALYSIS_CONFIG.ANALYSIS_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

/**
 * Compact data format (Carbon-like)
 * Stores only essential data points in minimal space
 */
function createCompactSnapshot(stockData, opportunities, timestamp) {
    const snapshot = {
        t: timestamp, // timestamp
        s: [],       // stocks (compact format)
        o: []        // opportunities (compact format)
    };
    
    // Compact stock data: [symbol, ltp, volume, change%, obi, rsi, quality]
    stockData.forEach((data, symbol) => {
        if (data.ltp) {
            snapshot.s.push([
                symbol,
                Math.round(data.ltp * 100) / 100,  // ltp (2 decimals)
                data.volume || 0,
                Math.round((data.changePercent || 0) * 100) / 100, // change%
                Math.round((data.obi || 0) * 100) / 100, // obi
                Math.round((data.rsi || 0) * 10) / 10,  // rsi (1 decimal)
                Math.round((data.quality || 0))         // quality (integer)
            ]);
        }
    });
    
    // Compact opportunities: [symbol, type, quality, netProfit%, timestamp]
    opportunities.forEach(opp => {
        snapshot.o.push([
            opp.symbol,
            opp.type === 'LONG' ? 'L' : 'S', // L or S
            Math.round(opp.quality || 0),
            Math.round((opp.netProfitPercent || 0) * 100) / 100,
            opp.timestamp
        ]);
    });
    
    return snapshot;
}

/**
 * Save snapshot in compact compressed format
 */
function saveSnapshot(snapshot) {
    ensureDirectories();
    
    const date = new Date(snapshot.t);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = `snapshot_${dateStr}_${date.getHours()}${String(date.getMinutes()).padStart(2, '0')}.json.gz`;
    const filepath = path.join(ANALYSIS_CONFIG.DATA_DIR, filename);
    
    // Compress JSON
    const json = JSON.stringify(snapshot);
    const compressed = zlib.gzipSync(json);
    
    fs.writeFileSync(filepath, compressed);
    
    const originalSize = Buffer.byteLength(json, 'utf8');
    const compressedSize = compressed.length;
    const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    
    console.log(`💾 Snapshot saved: ${filename} (${(compressedSize / 1024).toFixed(2)} KB, ${compressionRatio}% compressed)`);
    
    return { filepath, originalSize, compressedSize, compressionRatio };
}

/**
 * Load and decompress snapshot
 */
function loadSnapshot(filepath) {
    try {
        const compressed = fs.readFileSync(filepath);
        const decompressed = zlib.gunzipSync(compressed);
        return JSON.parse(decompressed.toString());
    } catch (error) {
        console.error(`Error loading snapshot ${filepath}:`, error.message);
        return null;
    }
}

/**
 * After-market analysis
 */
function analyzeMarketDay(snapshots) {
    if (!snapshots || snapshots.length === 0) {
        return null;
    }
    
    const analysis = {
        date: new Date(snapshots[0].t).toISOString().split('T')[0],
        totalSnapshots: snapshots.length,
        stocksAnalyzed: new Set(),
        opportunitiesFound: 0,
        topOpportunities: [],
        marketStats: {
            totalStocks: 0,
            stocksWithData: 0,
            avgOpportunities: 0,
            bestOpportunity: null
        },
        strategyBreakdown: {
            BEAST: 0,
            TRAP: 0,
            PREMIUM: 0,
            WHALE: 0
        },
        performance: {
            avgQuality: 0,
            avgNetProfit: 0,
            avgRiskReward: 0
        }
    };
    
    // Aggregate data from all snapshots
    const allOpportunities = [];
    const stockSet = new Set();
    const qualityScores = [];
    const netProfits = [];
    const riskRewards = [];
    
    snapshots.forEach(snapshot => {
        snapshot.s.forEach(stock => {
            stockSet.add(stock[0]); // symbol
        });
        
        snapshot.o.forEach(opp => {
            allOpportunities.push({
                symbol: opp[0],
                type: opp[1] === 'L' ? 'LONG' : 'SHORT',
                quality: opp[2],
                netProfit: opp[3],
                timestamp: opp[4]
            });
        });
    });
    
    // Find unique opportunities (by symbol + type + time window)
    const uniqueOpps = new Map();
    allOpportunities.forEach(opp => {
        const key = `${opp.symbol}_${opp.type}`;
        const existing = uniqueOpps.get(key);
        if (!existing || opp.quality > existing.quality) {
            uniqueOpps.set(key, opp);
        }
    });
    
    analysis.opportunitiesFound = uniqueOpps.size;
    analysis.marketStats.totalStocks = stockSet.size;
    analysis.marketStats.stocksWithData = stockSet.size;
    
    // Top opportunities
    analysis.topOpportunities = Array.from(uniqueOpps.values())
        .sort((a, b) => b.quality - a.quality)
        .slice(0, 20);
    
    // Performance metrics
    uniqueOpps.forEach(opp => {
        qualityScores.push(opp.quality);
        netProfits.push(opp.netProfit);
    });
    
    if (qualityScores.length > 0) {
        analysis.performance.avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
        analysis.performance.avgNetProfit = netProfits.reduce((a, b) => a + b, 0) / netProfits.length;
    }
    
    // Best opportunity
    if (analysis.topOpportunities.length > 0) {
        analysis.marketStats.bestOpportunity = analysis.topOpportunities[0];
    }
    
    return analysis;
}

/**
 * Generate analysis report
 */
function generateReport(analysis) {
    if (!analysis) return;
    
    ensureDirectories();
    
    const report = {
        generatedAt: new Date().toISOString(),
        analysisDate: analysis.date,
        summary: {
            totalSnapshots: analysis.totalSnapshots,
            stocksAnalyzed: analysis.marketStats.totalStocks,
            opportunitiesFound: analysis.opportunitiesFound,
            avgQuality: Math.round(analysis.performance.avgQuality * 10) / 10,
            avgNetProfit: Math.round(analysis.performance.avgNetProfit * 100) / 100
        },
        topOpportunities: analysis.topOpportunities.map(opp => ({
            symbol: opp.symbol,
            type: opp.type,
            quality: opp.quality,
            netProfit: Math.round(opp.netProfit * 100) / 100
        })),
        marketStats: analysis.marketStats,
        performance: analysis.performance
    };
    
    const filename = `analysis_${analysis.date}.json`;
    const filepath = path.join(ANALYSIS_CONFIG.ANALYSIS_DIR, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    
    console.log(`📊 Analysis report saved: ${filename}`);
    
    // Also generate a readable text report
    const textReport = generateTextReport(report);
    const textFilepath = path.join(ANALYSIS_CONFIG.ANALYSIS_DIR, `report_${analysis.date}.txt`);
    fs.writeFileSync(textFilepath, textReport);
    
    console.log(`📄 Text report saved: report_${analysis.date}.txt`);
    
    return { filepath, textFilepath };
}

/**
 * Generate human-readable text report
 */
function generateTextReport(report) {
    let text = `═══════════════════════════════════════════════════════════
📊 AFTER-MARKET ANALYSIS REPORT
═══════════════════════════════════════════════════════════

Date: ${report.analysisDate}
Generated: ${new Date(report.generatedAt).toLocaleString()}

📈 SUMMARY
───────────────────────────────────────────────────────────
Total Snapshots: ${report.summary.totalSnapshots}
Stocks Analyzed: ${report.summary.stocksAnalyzed}
Opportunities Found: ${report.summary.opportunitiesFound}
Average Quality: ${report.summary.avgQuality}%
Average Net Profit: ${report.summary.avgNetProfit}%

🎯 TOP OPPORTUNITIES
───────────────────────────────────────────────────────────
`;
    
    report.topOpportunities.slice(0, 10).forEach((opp, idx) => {
        text += `${idx + 1}. ${opp.symbol} ${opp.type.padEnd(5)} | Quality: ${opp.quality}% | Net Profit: ${opp.netProfit}%\n`;
    });
    
    text += `\n═══════════════════════════════════════════════════════════\n`;
    
    return text;
}

/**
 * Run after-market analysis on all snapshots for a date
 */
async function runAfterMarketAnalysis(date = null) {
    ensureDirectories();
    
    const targetDate = date || new Date().toISOString().split('T')[0];
    const pattern = new RegExp(`snapshot_${targetDate}_\\d{4}\\.json\\.gz$`);
    
    const files = fs.readdirSync(ANALYSIS_CONFIG.DATA_DIR)
        .filter(f => pattern.test(f))
        .sort();
    
    if (files.length === 0) {
        console.log(`⚠️  No snapshots found for ${targetDate}`);
        return null;
    }
    
    console.log(`📊 Loading ${files.length} snapshots for ${targetDate}...`);
    
    const snapshots = files.map(file => {
        const filepath = path.join(ANALYSIS_CONFIG.DATA_DIR, file);
        return loadSnapshot(filepath);
    }).filter(s => s !== null);
    
    if (snapshots.length === 0) {
        console.log(`⚠️  Failed to load any snapshots for ${targetDate}`);
        return null;
    }
    
    console.log(`✅ Loaded ${snapshots.length} snapshots`);
    
    const analysis = analyzeMarketDay(snapshots);
    if (analysis) {
        generateReport(analysis);
    }
    
    return analysis;
}

// Export functions
module.exports = {
    createCompactSnapshot,
    saveSnapshot,
    loadSnapshot,
    analyzeMarketDay,
    generateReport,
    runAfterMarketAnalysis,
    ANALYSIS_CONFIG
};

