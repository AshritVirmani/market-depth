# 🌐 Universal Stock Terminal - Complete Guide

**Real-time stock monitoring system using Dhan WebSocket API**

---

## 🚀 Features

- ✅ **Real-time Market Data** via Dhan Live Market Feed WebSocket
- ✅ **20-Level Market Depth** for complete order book analysis
- ✅ **Profitable Conditions Scanner** - Identifies trading opportunities
- ✅ **Quality Scoring** - Multi-factor signal strength assessment
- ✅ **Web Terminal UI** - Beautiful real-time dashboard
- ✅ **WebSocket Broadcasting** - Live updates to all connected clients

---

## 📡 Dhan API Integration

### WebSocket Connections Used:

1. **Live Market Feed**
   - Endpoint: `wss://api-feed.dhan.co`
   - Purpose: Real-time quotes, LTP, volume, 5-level depth
   - Capacity: Up to 5000 instruments per connection
   - Reference: [Live Market Feed Docs](https://dhanhq.co/docs/v2/live-market-feed/)

2. **20-Level Market Depth**
   - Endpoint: `wss://depth-api-feed.dhan.co/twentydepth`
   - Purpose: Complete order book (20 levels)
   - Capacity: Up to 50 instruments per connection
   - Reference: [Full Market Depth Docs](https://dhanhq.co/docs/v2/full-market-depth/)

---

## 🔧 Setup Instructions

### 1. Install Dependencies

```bash
npm install express ws axios
```

### 2. Update Security IDs

The terminal needs to map stock symbols to Dhan's security IDs. You have two options:

**Option A: Automatic (Recommended)**
- The server will try to fetch security IDs from Dhan's instrument list API
- If successful, no manual configuration needed

**Option B: Manual Mapping**
- If automatic fetch fails, manually update `SECURITY_ID_MAP` in the code
- Get security IDs from: https://dhanhq.co/docs/v2/instrument-list/

### 3. Start Server

```bash
node stock_terminal_server.js
```

### 4. Open Terminal UI

Navigate to: `http://localhost:3000/stock_terminal.html`

---

## 📊 How It Works

### Data Flow:

1. **WebSocket Connections**
   - Connects to Dhan Live Feed and Depth WebSockets
   - Subscribes to all stocks in `STOCK_UNIVERSE`

2. **Binary Packet Parsing**
   - Receives binary market data packets
   - Parses according to Dhan's protocol
   - Extracts: LTP, bids, asks, volume, etc.

3. **Indicator Calculation**
   - Calculates OBI (Order Book Imbalance)
   - Calculates RSI (Relative Strength Index)
   - Calculates VWAP (Volume Weighted Average Price)
   - Calculates tape pressure from recent trades

4. **Opportunity Detection**
   - Checks each stock against profitable conditions
   - Calculates quality score (0-100)
   - Only signals if quality > 65%

5. **Real-time Broadcasting**
   - Sends opportunities to connected WebSocket clients
   - Updates terminal UI in real-time

---

## 🎯 Profitable Conditions

### SHORT Setup:
- OBI < -20%
- Sell Pressure > 72%
- Momentum Confidence > 88%
- Spread < 0.01%
- RSI > 50
- Price >= VWAP
- Quality Score > 65%

### LONG Setup:
- OBI > 20%
- Buy Pressure > 65%
- Momentum Confidence > 85%
- Spread < 0.01%
- RSI < 50
- Price < VWAP
- Quality Score > 65%

---

## 📋 API Endpoints

### Server Endpoints:

- `GET /api/opportunities` - Get all current opportunities
- `GET /api/stocks` - Get list of monitored stocks
- `WebSocket /` - Real-time opportunity updates

---

## 🔍 Binary Packet Structure

### Live Market Feed (Full Packet - 162 bytes):

```
Bytes 0-7:   Response Header (8 bytes)
Bytes 8-11:  LTP (float32)
Bytes 12-15: Last Traded Quantity (int32)
Bytes 16-19: Volume (int32)
Bytes 20-23: Bid Quantity (int32)
Bytes 24-27: Ask Quantity (int32)
Bytes 28-31: Change (float32)
Bytes 32-35: Change % (float32)
Bytes 36-39: Open (float32)
Bytes 40-43: High (float32)
Bytes 44-47: Low (float32)
Bytes 48-51: Close (float32)
Bytes 52-151: Market Depth (5 levels, 20 bytes each)
```

### 20-Level Depth Packet (332 bytes):

```
Bytes 0-11:  Response Header (12 bytes)
Bytes 12-331: 20 levels × 16 bytes each
  - Price (float64, 8 bytes)
  - Quantity (uint32, 4 bytes)
  - Orders (uint32, 4 bytes)
```

---

## ⚠️ Important Notes

1. **Security IDs**: You must map stock symbols to Dhan's security IDs
2. **Market Hours**: WebSocket only works during market hours
3. **Rate Limits**: Dhan allows up to 5 WebSocket connections per user
4. **Reconnection**: Server automatically reconnects on disconnect
5. **Binary Parsing**: Requires proper byte order (little-endian)

---

## 🐛 Troubleshooting

### Connection Issues:
- Check access token is valid
- Verify client ID is correct
- Ensure market is open (for live data)

### No Opportunities:
- Check if stocks meet profitable conditions
- Verify security ID mapping is correct
- Check WebSocket connection status

### Binary Parsing Errors:
- Verify byte order (little-endian)
- Check packet length matches expected size
- Ensure buffer is complete before parsing

---

## 📚 References

- [Dhan Live Market Feed](https://dhanhq.co/docs/v2/live-market-feed/)
- [Dhan Full Market Depth](https://dhanhq.co/docs/v2/full-market-depth/)
- [Dhan Instrument List](https://dhanhq.co/docs/v2/instrument-list/)

---

## ✅ Status

**Ready to use!** The terminal is fully integrated with Dhan WebSocket API and ready to monitor stocks in real-time.

