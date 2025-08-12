# Komodo Chess Server

A high-performance Node.js server for communicating with the Komodo chess engine, featuring advanced caching, load balancing, fault tolerance, and a modern web-based chess interface.

## Features

### Core Functionality
- **UCI Protocol Communication**: Full UCI (Universal Chess Interface) support for Komodo engine
- **RESTful API**: Comprehensive REST endpoints for chess operations
- **Web Interface**: Modern, responsive HTML5 chess client with drag-and-drop gameplay
- **Real-time Engine Communication**: Non-blocking engine interactions with timeout handling

### Advanced Server Features
- **Intelligent Engine Pool**: Multiple engine instances with automatic load balancing
- **High-Performance Caching**: LRU cache with TTL for move calculations
- **Smart Request Queue**: Priority-based request handling with backpressure control
- **Circuit Breaker Pattern**: Fault tolerance with automatic recovery
- **Advanced Rate Limiting**: Sliding window rate limiter with burst protection
- **Clustering Support**: Multi-process scaling with worker management
- **Health Monitoring**: Real-time engine health checks and automatic restarts

### Engine Management
- **Dynamic Skill Levels**: Configurable from 1-20 (800-3200 ELO range)
- **Memory Optimization**: Dynamic hash table sizing based on available memory
- **Thread Management**: Automatic CPU core utilization (75% by default)
- **Move Time Control**: Flexible time limits (100ms to 30 seconds)
- **Batch Processing**: Efficient multiple position analysis
- **Engine Optimization**: Memory monitoring and automatic cache cleanup

### Web Interface
- **Modern Design**: Responsive interface with gradient backgrounds and smooth animations
- **Drag & Drop**: Intuitive piece movement with visual feedback
- **Move Validation**: Real-time legal move checking with highlighting
- **Game History**: Complete move history with algebraic notation
- **Multiple Skill Levels**: Easy engine strength adjustment
- **Connection Management**: Automatic reconnection and health monitoring
- **Game Controls**: New game, undo moves, flip board functionality

## Requirements

- **Node.js**: Version 14 or higher
- **Komodo Chess Engine**: Licensed Komodo engine executable
- **Modern Web Browser**: Chrome 80+, Firefox 75+, Safari 13+, or Edge 80+
- **System Memory**: Minimum 2GB RAM (4GB+ recommended for optimal performance)

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/top-site/chess2
   cd komodo-chess-server
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Install Komodo Chess Engine**:
   - Download Komodo from the official website
   - Place the executable in your project directory or system PATH
   - On Windows: ensure `komodo.exe` is accessible
   - On macOS/Linux: ensure `komodo` binary has execute permissions

4. **Configure Environment** (Optional):
   Create a `.env` file for production settings:
   ```bash
   # Engine Configuration
   KOMODO_PATH=./komodo.exe
   ENGINE_HASH=512
   ENGINE_THREADS=4
   
   # Performance Settings
   MAX_CONCURRENT=4
   CACHE_SIZE=2000
   RATE_LIMIT=60
   
   # Clustering
   CLUSTER_ENABLED=true
   CLUSTER_WORKERS=2
   
   # Security
   CORS_ORIGIN=http://localhost:3000
   MAX_BATCH_SIZE=10
   ```

## Usage

### Start the Server

**Development Mode:**
```bash
npm run dev
```

**Production Mode:**
```bash
npm start
```

**With Clustering:**
```bash
CLUSTER_ENABLED=true npm start
```

The server will be available at `http://localhost:3001`

### Web Interface

1. Open `optimized_chess_client.html` in a web browser
2. Configure server URL (default: `http://localhost:3001`)
3. Click "Connect to Engine" to establish connection
4. Start playing by making moves on the board
5. Adjust difficulty and settings as needed

### API Usage Examples

**Initialize Engine:**
```bash
curl -X POST http://localhost:3001/api/engine/init \
  -H "Content-Type: application/json" \
  -d '{"skillLevel": 5, "warmUp": true}'
```

**Get Best Move:**
```bash
curl -X POST http://localhost:3001/api/engine/move \
  -H "Content-Type: application/json" \
  -d '{
    "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    "skillLevel": 10,
    "moveTime": 1000
  }'
```

**Batch Analysis:**
```bash
curl -X POST http://localhost:3001/api/engine/batch \
  -H "Content-Type: application/json" \
  -d '{
    "positions": [
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
      "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"
    ],
    "skillLevel": 8
  }'
```

## API Endpoints

### Engine Management
- `POST /api/engine/init` - Initialize engine with skill level and options
- `POST /api/engine/move` - Calculate best move for position
- `POST /api/engine/batch` - Analyze multiple positions
- `POST /api/engine/newgame` - Reset engine for new game
- `GET /api/engine/status` - Get engine and pool status
- `POST /api/engine/optimize` - Perform optimization operations

### System Monitoring
- `GET /api/health` - Health check endpoint with system metrics
- `GET /api/metrics` - Prometheus-style metrics for monitoring

### Request/Response Format

**Move Request:**
```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "skillLevel": 10,
  "moveTime": 2000,
  "engineId": "player1"
}
```

**Move Response:**
```json
{
  "move": "e7e5",
  "ponderMove": "g1f3",
  "skillLevel": 10,
  "calculationTime": 1847,
  "responseTime": 1892,
  "fromCache": false,
  "requestId": "abc123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Configuration Options

### Engine Settings
```javascript
engineOptions: {
    'Hash': 512,              // Memory in MB
    'Threads': 4,             // CPU threads
    'UCI_LimitStrength': true,
    'UCI_Elo': 1200,          // Target ELO rating
    'Move Overhead': 50,      // Network overhead in ms
    'Minimum Thinking Time': 10
}
```

### Performance Tuning
```javascript
performance: {
    maxConcurrentRequests: 4,  // Concurrent calculations
    requestQueueSize: 50,      // Max queued requests
    cacheSize: 2000,          // Cached positions
    cacheTTL: 7200000,        // Cache lifetime (2 hours)
    maxRetries: 2,            // Failed request retries
    retryDelay: 1000          // Retry delay in ms
}
```

### Security Settings
```javascript
security: {
    rateLimit: 60,            // Requests per minute
    maxBatchSize: 10,         // Max positions per batch
    maxRequestSize: '2mb'     // Max request body size
}
```

## Performance Monitoring

### Built-in Metrics
- Engine pool utilization
- Cache hit rates
- Request queue statistics
- Memory usage tracking
- Response time monitoring
- Error rate tracking

### Health Check Response
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": { "process": 3600, "system": 86400 },
  "memory": { "rss": "128MB", "usage": "12%" },
  "cpu": { "usage": "25%", "cores": 8 },
  "engines": { "total": 3, "healthy": 3, "totalMoves": 1547 }
}
```

## Architecture Overview

### Core Components
- **EnhancedKomodoEngine**: Individual engine wrapper with health monitoring
- **OptimizedEnginePool**: Load-balanced engine management
- **OptimizedLRUCache**: High-performance caching layer
- **SmartRequestQueue**: Priority-based request handling
- **CircuitBreaker**: Fault tolerance and recovery
- **AdvancedRateLimiter**: Request rate control

### Load Balancing Strategies
- **Round Robin**: Equal distribution across engines
- **Least Loaded**: Route to engine with fewest pending requests
- **Fastest**: Prefer engines with lowest average response time

### Fault Tolerance
- **Circuit Breaker**: Automatic failure detection and recovery
- **Health Monitoring**: Continuous engine health assessment
- **Auto-restart**: Automatic engine restart on failure
- **Graceful Degradation**: Continue operation with reduced capacity

## Clustering and Scaling

### Multi-Process Mode
```bash
# Enable clustering with 4 workers
CLUSTER_ENABLED=true CLUSTER_WORKERS=4 npm start
```

### Load Balancing
- Master process manages worker distribution
- Automatic worker restart on failure
- Graceful shutdown coordination
- Memory monitoring and warnings

## Troubleshooting

### Engine Connection Issues
```
Error: Engine initialization timeout
```
**Solution**: 
- Verify Komodo engine path is correct
- Check engine executable permissions
- Ensure sufficient system memory
- Try increasing initialization timeout

### High Memory Usage
```
Warning: High memory usage (800MB+)
```
**Solution**:
- Reduce cache size: `CACHE_SIZE=1000`
- Lower concurrent requests: `MAX_CONCURRENT=2`
- Enable automatic cache cleanup
- Restart server periodically in production

### Rate Limiting Errors
```
Error: Rate limit exceeded
```
**Solution**:
- Increase rate limit: `RATE_LIMIT=120`
- Implement request batching
- Use multiple engine instances
- Consider caching frequent positions

### Performance Issues
```
Warning: High response times
```
**Solution**:
- Enable clustering: `CLUSTER_ENABLED=true`
- Optimize engine hash size based on available memory
- Use faster storage for cache data
- Monitor system resource usage

## Production Deployment

### Docker Configuration
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

### Environment Variables
```bash
# Production settings
NODE_ENV=production
PORT=3001
KOMODO_PATH=/usr/local/bin/komodo

# Performance optimization
CLUSTER_ENABLED=true
CLUSTER_WORKERS=4
ENGINE_HASH=1024
CACHE_SIZE=5000

# Security
RATE_LIMIT=120
CORS_ORIGIN=https://yourdomain.com
```

### Process Management
```bash
# Using PM2
pm2 start server.js --name "komodo-chess" --instances 4
pm2 monit
pm2 restart komodo-chess
```

## Development

### Running Tests
```bash
npm test
```

### Development Mode
```bash
npm run dev
```

### Code Structure
```
komodo-chess-server/
├── server.js                 # Main server application
├── optimized_chess_client.html  # Web interface
├── package.json              # Dependencies and scripts
├── README.md                # Documentation
├── .env.example             # Environment template
└── .gitignore              # Git ignore rules
```

## Contributing

We welcome contributions! Areas for improvement:
- **Opening Books**: Integration with opening book databases
- **Endgame Tablebases**: Syzygy tablebase support
- **Tournament Management**: Multi-game tournament system
- **WebSocket Support**: Real-time bidirectional communication
- **Database Integration**: Game storage and retrieval
- **Analysis Features**: Position evaluation and variation analysis
- **Mobile Optimization**: Touch-friendly interface improvements

### Development Guidelines
1. Follow Node.js best practices
2. Maintain comprehensive error handling
3. Add unit tests for new features
4. Update documentation for API changes
5. Consider performance impact of changes

## License

This project is licensed under the MIT License. See LICENSE file for details.

---

**Note**: This application requires a licensed Komodo chess engine. The server handles all UCI communication, caching, and load balancing, while the web interface provides an intuitive way to interact with the engine for chess analysis and gameplay.
