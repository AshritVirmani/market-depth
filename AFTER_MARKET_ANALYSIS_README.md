# 📊 After-Market Analysis System

## Overview

The after-market analysis system automatically collects market data during trading hours and generates comprehensive analysis reports after the market closes. Data is stored in a **compact, compressed format** to minimize storage space.

---

## 🎯 Features

### 1. **Automatic Data Collection**
- Saves snapshots every **1 minute** during market hours
- Stores only essential data (compact format)
- Compresses data using **gzip** (typically 70-80% compression)

### 2. **Compact Storage Format**
- **Stock Data**: `[symbol, ltp, volume, change%, obi, rsi, quality]`
- **Opportunities**: `[symbol, type, quality, netProfit%, timestamp]`
- **File Format**: Compressed JSON (`.json.gz`)
- **Size**: ~5-20 KB per snapshot (vs 50-100 KB uncompressed)

### 3. **After-Market Analysis**
- Automatically runs when market closes
- Analyzes all snapshots from the trading day
- Generates:
  - Summary statistics
  - Top opportunities
  - Performance metrics
  - Strategy breakdown

---

## 📁 File Structure

```
market_data/          # Raw snapshots (compressed)
  snapshot_2025-12-01_0915.json.gz
  snapshot_2025-12-01_0916.json.gz
  ...

analysis/            # Analysis reports
  analysis_2025-12-01.json    # JSON report
  report_2025-12-01.txt        # Human-readable report
```

---

## 🔧 How It Works

### During Market Hours:
1. **Every 1 minute**: System saves a compact snapshot
2. **Data includes**:
   - All stocks with live data
   - Current prices, volumes, indicators
   - Active opportunities
3. **Compression**: Data is gzipped before saving

### After Market Closes:
1. **Automatic trigger**: System detects market close
2. **Analysis runs**: Processes all snapshots from the day
3. **Report generation**: Creates JSON + text reports

---

## 📊 Data Format

### Snapshot Structure:
```json
{
  "t": 1701427200000,  // timestamp
  "s": [               // stocks (compact)
    ["RELIANCE", 2450.50, 1000000, 1.2, 15.5, 55.3, 75],
    ["TCS", 3450.25, 500000, -0.5, -10.2, 45.1, 60]
  ],
  "o": [               // opportunities (compact)
    ["RELIANCE", "L", 75, 0.85, 1701427200000],
    ["TCS", "S", 60, 0.65, 1701427200000]
  ]
}
```

### Compact Format Benefits:
- **70-80% smaller** than full JSON
- **Fast to load** (compressed)
- **Easy to parse** (simple arrays)

---

## 🚀 Usage

### Automatic (Default):
The system runs automatically when the server is running. No manual intervention needed.

### Manual Analysis:
```bash
# Run analysis for today
node -e "require('./after_market_analysis').runAfterMarketAnalysis()"

# Run analysis for specific date
node -e "require('./after_market_analysis').runAfterMarketAnalysis('2025-12-01')"
```

### API Endpoint:
```bash
# Get analysis for today
curl http://localhost:3000/api/analysis

# Get analysis for specific date
curl http://localhost:3000/api/analysis/2025-12-01
```

---

## 📈 Analysis Report Contents

### Summary:
- Total snapshots collected
- Stocks analyzed
- Opportunities found
- Average quality score
- Average net profit

### Top Opportunities:
- Top 20 opportunities ranked by quality
- Symbol, type, quality, net profit

### Performance Metrics:
- Average quality score
- Average net profit
- Average risk:reward ratio

---

## 💾 Storage Management

### Automatic Cleanup:
- Snapshots are kept indefinitely (configurable)
- Reports are kept indefinitely
- You can manually delete old snapshots if needed

### Storage Size:
- **Per snapshot**: ~5-20 KB (compressed)
- **Per day**: ~5-10 MB (for 6 hours of trading)
- **Per month**: ~150-300 MB

### Cleanup Script (Optional):
```bash
# Delete snapshots older than 30 days
find market_data -name "*.json.gz" -mtime +30 -delete

# Delete analysis reports older than 90 days
find analysis -name "*.json" -mtime +90 -delete
```

---

## ⚙️ Configuration

Edit `after_market_analysis.js`:

```javascript
const ANALYSIS_CONFIG = {
    DATA_DIR: './market_data',        // Snapshot directory
    ANALYSIS_DIR: './analysis',        // Report directory
    SNAPSHOT_INTERVAL: 60000,         // 1 minute (in ms)
    KEEP_SNAPSHOTS: true,              // Keep compressed snapshots
    GENERATE_REPORT: true              // Generate analysis report
};
```

---

## 🔍 Viewing Reports

### Text Report:
```bash
cat analysis/report_2025-12-01.txt
```

### JSON Report:
```bash
cat analysis/analysis_2025-12-01.json | jq
```

### Web Interface:
Visit: `http://localhost:3000/api/analysis`

---

## 📝 Example Report

```
═══════════════════════════════════════════════════════════
📊 AFTER-MARKET ANALYSIS REPORT
═══════════════════════════════════════════════════════════

Date: 2025-12-01
Generated: 12/1/2025, 3:35:00 PM

📈 SUMMARY
───────────────────────────────────────────────────────────
Total Snapshots: 375
Stocks Analyzed: 1,250
Opportunities Found: 45
Average Quality: 72.5%
Average Net Profit: 0.68%

🎯 TOP OPPORTUNITIES
───────────────────────────────────────────────────────────
1. RELIANCE LONG  | Quality: 85% | Net Profit: 1.2%
2. TCS SHORT      | Quality: 82% | Net Profit: 0.95%
3. HDFCBANK LONG  | Quality: 80% | Net Profit: 0.88%
...
```

---

## 🎯 Benefits

1. **Space Efficient**: 70-80% compression saves disk space
2. **Automatic**: No manual intervention needed
3. **Comprehensive**: Full day analysis with insights
4. **Historical**: Build a database of trading days
5. **Fast**: Compressed format loads quickly

---

## 🔧 Troubleshooting

### Snapshots not saving?
- Check if market is open
- Check disk space
- Check file permissions

### Analysis not running?
- Check if market closed properly
- Check server logs
- Manually trigger: `node -e "require('./after_market_analysis').runAfterMarketAnalysis()"`

### Reports missing?
- Check `analysis/` directory exists
- Check file permissions
- Run analysis manually

---

## 📚 Next Steps

1. **Review daily reports** to understand market patterns
2. **Track opportunities** over time to improve strategy
3. **Analyze trends** in quality scores and profitability
4. **Optimize strategy** based on historical data

---

**The system is fully automated and runs in the background. Just keep the server running during market hours!** 🚀

