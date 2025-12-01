# 📡 Dhan API - Complete Capabilities Guide

## 🎯 Available Data & Features

### 1. **Live Market Feed** (Real-time)
- **Endpoint:** `wss://api-feed.dhan.co`
- **Data:**
  - Last Traded Price (LTP)
  - Last Traded Quantity
  - Volume
  - Bid/Ask Quantities (top level)
  - Change & Change %
  - OHLC (Open, High, Low, Close)
  - **5-Level Market Depth** (bid/ask prices, quantities, order counts)
- **Capacity:** Up to 5,000 instruments per connection
- **Update Frequency:** Real-time (tick-by-tick)
- **Use Cases:**
  - Real-time price monitoring
  - Quick order book snapshot
  - Volume analysis
  - Price change tracking

### 2. **20-Level Market Depth** (Level 3 Data)
- **Endpoint:** `wss://depth-api-feed.dhan.co/twentydepth`
- **Data:**
  - 20 levels of bid prices & quantities
  - 20 levels of ask prices & quantities
  - Order counts at each level
  - Sequence numbers for synchronization
- **Capacity:** Up to 50 instruments per connection
- **Use Cases:**
  - Support/Resistance identification
  - Large order detection (whale watching)
  - Liquidity analysis
  - Order flow analysis

### 3. **200-Level Market Depth** (Full Depth) ⭐ NEW
- **Endpoint:** `wss://full-depth-api.dhan.co/twohundreddepth`
- **Data:**
  - **200 levels** of bid prices & quantities
  - **200 levels** of ask prices & quantities
  - Complete order book visualization
  - Maximum market depth available
- **Capacity:** Limited (typically 10-20 instruments per connection)
- **Use Cases:**
  - **Advanced Support/Resistance:** Identify major price levels with large orders
  - **Whale Detection:** Spot institutional orders beyond visible levels
  - **Liquidity Mapping:** Understand true market liquidity
  - **Order Flow Analysis:** Track large orders entering/exiting
  - **Slippage Prediction:** Estimate execution costs for large orders
  - **Market Microstructure:** Analyze order book dynamics

### 4. **Historical Data**
- **Endpoint:** `https://api.dhan.co/historical`
- **Data:**
  - Daily OHLCV data
  - Intraday data (1min, 5min, 15min, 30min, 60min)
  - Date range queries
- **Use Cases:**
  - Backtesting
  - Technical analysis
  - Pattern recognition
  - Performance analysis

### 5. **Market Quote API** (Snapshot)
- **Endpoint:** `https://api.dhan.co/market-quote`
- **Data:**
  - Bulk snapshot of multiple instruments
  - LTP, quotes, depth for up to 1,000 instruments
  - Single request for multiple stocks
- **Use Cases:**
  - Initial data load
  - Periodic snapshots
  - Bulk analysis

### 6. **Option Chain API**
- **Endpoint:** `https://api.dhan.co/option-chain`
- **Data:**
  - All strikes for an underlying
  - Open Interest (OI)
  - Greeks (Delta, Gamma, Theta, Vega)
  - Volume & bid/ask prices
- **Use Cases:**
  - Options trading strategies
  - Max Pain calculation
  - PCR (Put-Call Ratio) analysis
  - Options flow analysis

### 7. **Instrument Master**
- **Endpoint:** `https://api.dhan.co/masters/instruments` (or CSV download)
- **Data:**
  - All tradable instruments
  - Security IDs
  - Exchange segments
  - Instrument types
- **Use Cases:**
  - Building stock universe
  - Symbol mapping
  - Security ID lookup

---

## 🚀 How to Use 200-Level Depth to Your Advantage

### 1. **Support/Resistance Identification**

```javascript
function findSupportResistance(depth200) {
    const bids = depth200.bids; // 200 levels
    const asks = depth200.asks; // 200 levels
    
    // Find large order clusters (potential support/resistance)
    const supportLevels = [];
    const resistanceLevels = [];
    
    // Aggregate quantities at price levels
    const bidClusters = aggregateByPrice(bids, 0.5); // 0.5% price bands
    const askClusters = aggregateByPrice(asks, 0.5);
    
    // Support = Large bid clusters
    bidClusters.forEach(cluster => {
        if (cluster.totalQty > 100000) { // Large order
            supportLevels.push({
                price: cluster.price,
                quantity: cluster.totalQty,
                strength: cluster.totalQty / 100000 // Normalized
            });
        }
    });
    
    // Resistance = Large ask clusters
    askClusters.forEach(cluster => {
        if (cluster.totalQty > 100000) {
            resistanceLevels.push({
                price: cluster.price,
                quantity: cluster.totalQty,
                strength: cluster.totalQty / 100000
            });
        }
    });
    
    return { supportLevels, resistanceLevels };
}
```

### 2. **Whale Detection**

```javascript
function detectWhales(depth200) {
    const whales = [];
    
    // Look for unusually large orders (institutional)
    depth200.bids.forEach(level => {
        if (level.quantity > 500000) { // Large order threshold
            whales.push({
                type: 'BUY_WHALE',
                price: level.price,
                quantity: level.quantity,
                distance: (currentPrice - level.price) / currentPrice * 100
            });
        }
    });
    
    depth200.asks.forEach(level => {
        if (level.quantity > 500000) {
            whales.push({
                type: 'SELL_WHALE',
                price: level.price,
                quantity: level.quantity,
                distance: (level.price - currentPrice) / currentPrice * 100
            });
        }
    });
    
    return whales;
}
```

### 3. **Liquidity Analysis**

```javascript
function analyzeLiquidity(depth200, targetQuantity) {
    const bids = depth200.bids;
    const asks = depth200.asks;
    
    // Calculate how much liquidity exists at different price levels
    let cumulativeBidQty = 0;
    let cumulativeAskQty = 0;
    
    const bidLiquidity = [];
    const askLiquidity = [];
    
    // For bids (buying pressure)
    for (let i = 0; i < bids.length; i++) {
        cumulativeBidQty += bids[i].quantity;
        bidLiquidity.push({
            price: bids[i].price,
            cumulativeQty: cumulativeBidQty,
            levels: i + 1
        });
        
        if (cumulativeBidQty >= targetQuantity) {
            break; // Found enough liquidity
        }
    }
    
    // For asks (selling pressure)
    for (let i = 0; i < asks.length; i++) {
        cumulativeAskQty += asks[i].quantity;
        askLiquidity.push({
            price: asks[i].price,
            cumulativeQty: cumulativeAskQty,
            levels: i + 1
        });
        
        if (cumulativeAskQty >= targetQuantity) {
            break;
        }
    }
    
    return {
        bidLiquidity,
        askLiquidity,
        canBuy: cumulativeBidQty >= targetQuantity,
        canSell: cumulativeAskQty >= targetQuantity,
        estimatedSlippage: calculateSlippage(bidLiquidity, askLiquidity, targetQuantity)
    };
}
```

### 4. **Order Flow Analysis**

```javascript
function trackOrderFlow(previousDepth, currentDepth) {
    // Compare previous vs current to detect order flow
    const flow = {
        newBids: [],
        removedBids: [],
        newAsks: [],
        removedAsks: [],
        modifiedBids: [],
        modifiedAsks: []
    };
    
    // Track new large orders appearing
    currentDepth.bids.forEach(bid => {
        const prev = previousDepth.bids.find(b => b.price === bid.price);
        if (!prev) {
            if (bid.quantity > 100000) {
                flow.newBids.push(bid); // New large bid
            }
        } else if (bid.quantity !== prev.quantity) {
            flow.modifiedBids.push({
                price: bid.price,
                oldQty: prev.quantity,
                newQty: bid.quantity,
                change: bid.quantity - prev.quantity
            });
        }
    });
    
    // Similar for asks...
    
    return flow;
}
```

### 5. **Slippage Estimation**

```javascript
function estimateSlippage(depth200, orderSize, orderType) {
    // Estimate execution price for a large order
    let cumulativeQty = 0;
    let weightedPrice = 0;
    const levels = orderType === 'BUY' ? depth200.asks : depth200.bids;
    
    for (const level of levels) {
        const qtyToTake = Math.min(level.quantity, orderSize - cumulativeQty);
        weightedPrice += level.price * qtyToTake;
        cumulativeQty += qtyToTake;
        
        if (cumulativeQty >= orderSize) {
            break;
        }
    }
    
    const avgPrice = weightedPrice / cumulativeQty;
    const currentPrice = orderType === 'BUY' ? depth200.asks[0].price : depth200.bids[0].price;
    const slippage = Math.abs(avgPrice - currentPrice) / currentPrice * 100;
    
    return {
        estimatedPrice: avgPrice,
        slippage: slippage,
        levelsUsed: levels.findIndex(l => cumulativeQty >= orderSize) + 1
    };
}
```

### 6. **Market Microstructure Analysis**

```javascript
function analyzeMicrostructure(depth200) {
    // Analyze order book shape and dynamics
    const bids = depth200.bids;
    const asks = depth200.asks;
    
    // Calculate order book imbalance across all 200 levels
    const totalBidQty = bids.reduce((sum, b) => sum + b.quantity, 0);
    const totalAskQty = asks.reduce((sum, a) => sum + a.quantity, 0);
    const totalQty = totalBidQty + totalAskQty;
    
    const obi200 = ((totalBidQty - totalAskQty) / totalQty) * 100;
    
    // Calculate spread across depth
    const spread = asks[0].price - bids[0].price;
    const spreadPercent = (spread / bids[0].price) * 100;
    
    // Calculate depth concentration (how much liquidity is in top 10 vs rest)
    const top10BidQty = bids.slice(0, 10).reduce((sum, b) => sum + b.quantity, 0);
    const top10AskQty = asks.slice(0, 10).reduce((sum, a) => sum + a.quantity, 0);
    const concentration = {
        bid: top10BidQty / totalBidQty * 100,
        ask: top10AskQty / totalAskQty * 100
    };
    
    return {
        obi200, // Order Book Imbalance (200 levels)
        spread,
        spreadPercent,
        concentration,
        totalBidQty,
        totalAskQty,
        depthRatio: totalBidQty / totalAskQty
    };
}
```

---

## 📊 Implementation Strategy

### Priority Instruments for 200-Level Depth:
1. **High-volume stocks** (for liquidity analysis)
2. **Large-cap stocks** (for whale detection)
3. **Stocks with active opportunities** (for execution optimization)
4. **Options-heavy stocks** (for support/resistance)

### Connection Management:
- Use **separate WebSocket** for 200-level depth
- Subscribe to **10-20 key instruments** only
- Rotate subscriptions based on opportunity scores
- Monitor connection health and auto-reconnect

---

## 🎯 Trading Advantages

1. **Better Entry/Exit:** Know exact liquidity at price levels
2. **Reduced Slippage:** Estimate execution costs before trading
3. **Whale Following:** Track institutional orders
4. **Support/Resistance:** Identify real price levels (not just chart levels)
5. **Order Flow:** Understand market dynamics beyond price action
6. **Risk Management:** Assess market depth before large positions

---

## ⚠️ Limitations

- **Limited Capacity:** Only 10-20 instruments per connection
- **Higher Latency:** More data to process
- **Resource Intensive:** Requires more memory/CPU
- **Subscription Cost:** May require premium API access

---

## 🔗 References

- [Dhan API Documentation](https://dhanhq.co/docs/)
- [20-Level Market Depth](https://dhanhq.co/docs/v2/20-market-depth/)
- [Full Market Depth Blog](https://blog.dhan.co/introducing-full-market-depth/)

