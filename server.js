const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const EventEmitter = require('events');
const { promisify } = require('util');
const cluster = require('cluster');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

// Enhanced configuration with validation and smart defaults
const CONFIG = {
    komodoPath: process.env.KOMODO_PATH || './komodo.exe',
    engineOptions: {
        'Hash': Math.min(2048, Math.max(64, parseInt(process.env.ENGINE_HASH) || 
            Math.min(512, Math.floor(os.totalmem() / 1024 / 1024 / 8)))), // Dynamic hash based on available memory
        'Threads': Math.min(os.cpus().length, Math.max(1, parseInt(process.env.ENGINE_THREADS) || 
            Math.max(1, Math.floor(os.cpus().length * 0.75)))), // Use 75% of available cores
        'Ponder': process.env.ENGINE_PONDER === 'true',
        'MultiPV': 1,
        'UCI_LimitStrength': true,
        'UCI_Elo': 1200, // Better default starting point
        'Contempt': 0,
        'Move Overhead': 50, // Reduced for faster online play
        'Minimum Thinking Time': 10,
        'Slow Mover': 100
    },
    timeouts: {
        initialization: parseInt(process.env.INIT_TIMEOUT) || 15000,
        moveCalculation: parseInt(process.env.MOVE_TIMEOUT) || 30000,
        commandResponse: parseInt(process.env.CMD_TIMEOUT) || 5000,
        gracefulShutdown: parseInt(process.env.SHUTDOWN_TIMEOUT) || 8000,
        keepAlive: parseInt(process.env.KEEPALIVE_TIMEOUT) || 180000, // Reduced to 3 minutes
        engineRestart: parseInt(process.env.RESTART_TIMEOUT) || 10000
    },
    skillLevels: {
        min: 1,
        max: 20,
        default: 5 // Better default for casual play
    },
    performance: {
        maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT) || Math.max(2, Math.floor(os.cpus().length / 2)),
        requestQueueSize: parseInt(process.env.QUEUE_SIZE) || 50,
        enableCaching: process.env.ENABLE_CACHE !== 'false',
        cacheSize: parseInt(process.env.CACHE_SIZE) || 2000, // Increased default
        cacheTTL: parseInt(process.env.CACHE_TTL) || 7200000, // 2 hours
        maxRetries: parseInt(process.env.MAX_RETRIES) || 2,
        retryDelay: parseInt(process.env.RETRY_DELAY) || 1000
    },
    clustering: {
        enabled: process.env.CLUSTER_ENABLED === 'true',
        workers: parseInt(process.env.CLUSTER_WORKERS) || Math.max(1, Math.floor(os.cpus().length / 2))
    },
    security: {
        rateLimit: parseInt(process.env.RATE_LIMIT) || 60, // requests per minute
        maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE) || 10,
        maxRequestSize: process.env.MAX_REQUEST_SIZE || '2mb'
    }
};

// Enhanced middleware stack
app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use(express.json({ 
    limit: CONFIG.security.maxRequestSize,
    strict: true
}));

app.use(express.static('public', { 
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : '1m',
    etag: true,
    lastModified: true
}));

// Compression middleware with smart detection
const setupCompression = () => {
    try {
        const compression = require('compression');
        app.use(compression({
            level: 6,
            threshold: 1024,
            filter: (req, res) => {
                if (req.headers['x-no-compression']) return false;
                return compression.filter(req, res);
            }
        }));
        console.log('✓ Compression enabled');
    } catch (e) {
        console.log('ℹ  Compression not available, continuing without it');
    }
};

setupCompression();

// Utility functions
const delay = promisify(setTimeout);
const createTimeoutPromise = (ms, message = 'Operation timeout') => 
    new Promise((_, reject) => 
        setTimeout(() => reject(new Error(message)), ms)
    );

// Enhanced FEN validation with comprehensive checks
const FEN_REGEX = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[bw]\s+(-|[KQkq]{1,4})\s+(-|[a-h][36])\s+\d+\s+\d+$/;

const validateFEN = (fen) => {
    if (!fen || typeof fen !== 'string') return false;
    
    const trimmedFen = fen.trim();
    if (!FEN_REGEX.test(trimmedFen)) return false;
    
    try {
        const parts = trimmedFen.split(' ');
        if (parts.length !== 6) return false;
        
        const [position, activeColor, castling, enPassant, halfmove, fullmove] = parts;
        
        // Validate position
        const ranks = position.split('/');
        if (ranks.length !== 8) return false;
        
        for (const rank of ranks) {
            let squares = 0;
            for (const char of rank) {
                if ('12345678'.includes(char)) {
                    squares += parseInt(char);
                } else if ('rnbqkpRNBQKP'.includes(char)) {
                    squares += 1;
                } else {
                    return false;
                }
            }
            if (squares !== 8) return false;
        }
        
        // Count kings
        const pieces = position.replace(/[\/1-8]/g, '');
        const whiteKings = (pieces.match(/K/g) || []).length;
        const blackKings = (pieces.match(/k/g) || []).length;
        
        if (whiteKings !== 1 || blackKings !== 1) return false;
        
        // Validate other fields
        if (!['w', 'b'].includes(activeColor)) return false;
        
        const halfmoveNum = parseInt(halfmove);
        const fullmoveNum = parseInt(fullmove);
        
        if (isNaN(halfmoveNum) || halfmoveNum < 0 || halfmoveNum > 100) return false;
        if (isNaN(fullmoveNum) || fullmoveNum < 1) return false;
        
        return true;
    } catch (error) {
        return false;
    }
};

// High-performance LRU Cache with TTL and statistics
class OptimizedLRUCache {
    constructor(maxSize = 2000, ttl = 7200000) {
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.cache = new Map();
        this.timers = new Map();
        
        // Statistics
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            evictions: 0,
            memoryUsage: 0
        };
        
        // Cleanup timer
        this.cleanupInterval = setInterval(() => this.cleanup(), Math.min(ttl / 4, 300000));
    }

    get(key) {
        const item = this.cache.get(key);
        
        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() - item.timestamp > this.ttl) {
            this.delete(key);
            this.stats.misses++;
            return null;
        }

        // Move to end (LRU)
        this.cache.delete(key);
        this.cache.set(key, { ...item, timestamp: Date.now() });
        this.stats.hits++;
        
        return item.value;
    }

    set(key, value) {
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.delete(oldestKey);
            this.stats.evictions++;
        }

        const item = { value, timestamp: Date.now() };
        this.cache.set(key, item);
        this.stats.sets++;
        
        // Set TTL timer
        if (this.ttl > 0) {
            const timer = setTimeout(() => this.delete(key), this.ttl);
            this.timers.set(key, timer);
        }
        
        this.updateMemoryUsage();
    }

    delete(key) {
        const deleted = this.cache.delete(key);
        if (deleted) {
            this.stats.deletes++;
            const timer = this.timers.get(key);
            if (timer) {
                clearTimeout(timer);
                this.timers.delete(key);
            }
            this.updateMemoryUsage();
        }
        return deleted;
    }

    clear() {
        this.cache.clear();
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
        this.stats = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0, memoryUsage: 0 };
    }

    cleanup() {
        const now = Date.now();
        const expiredKeys = [];
        
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.ttl) {
                expiredKeys.push(key);
            }
        }
        
        expiredKeys.forEach(key => this.delete(key));
        
        if (expiredKeys.length > 0) {
            console.log(`🧹 Cache cleanup: removed ${expiredKeys.length} expired entries`);
        }
    }

    updateMemoryUsage() {
        // Rough estimate of memory usage
        this.stats.memoryUsage = this.cache.size * 100; // bytes per entry estimate
    }

    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) + '%' : '0%',
            ...this.stats
        };
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.clear();
    }
}

// Advanced request queue with priority and backpressure
class SmartRequestQueue {
    constructor(maxSize = 50, maxConcurrent = 4) {
        this.queue = [];
        this.processing = 0;
        this.maxSize = maxSize;
        this.maxConcurrent = maxConcurrent;
        this.stats = {
            processed: 0,
            failed: 0,
            rejected: 0,
            averageWaitTime: 0,
            totalWaitTime: 0
        };
    }

    async add(operation, priority = 0) {
        return new Promise((resolve, reject) => {
            if (this.queue.length >= this.maxSize) {
                this.stats.rejected++;
                reject(new Error('Request queue is full - system overloaded'));
                return;
            }

            const request = {
                operation,
                resolve,
                reject,
                priority,
                timestamp: Date.now(),
                id: Math.random().toString(36).substr(2, 9)
            };

            // Insert based on priority (higher priority first)
            const insertIndex = this.queue.findIndex(r => r.priority < priority);
            if (insertIndex === -1) {
                this.queue.push(request);
            } else {
                this.queue.splice(insertIndex, 0, request);
            }

            this.processNext();
        });
    }

    async processNext() {
        if (this.processing >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.processing++;
        const request = this.queue.shift();
        const waitTime = Date.now() - request.timestamp;
        
        this.stats.totalWaitTime += waitTime;

        try {
            const result = await request.operation();
            request.resolve(result);
            this.stats.processed++;
        } catch (error) {
            request.reject(error);
            this.stats.failed++;
        } finally {
            this.processing--;
            this.stats.averageWaitTime = Math.round(this.stats.totalWaitTime / 
                (this.stats.processed + this.stats.failed));
            
            // Process next request immediately
            setImmediate(() => this.processNext());
        }
    }

    getStats() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            maxConcurrent: this.maxConcurrent,
            utilizationRate: ((this.processing / this.maxConcurrent) * 100).toFixed(1) + '%',
            ...this.stats
        };
    }

    clear() {
        this.queue.forEach(request => {
            request.reject(new Error('Queue cleared'));
        });
        this.queue = [];
    }
}

// Circuit breaker for fault tolerance
class CircuitBreaker {
    constructor(threshold = 5, timeout = 60000, monitoringPeriod = 600000) {
        this.threshold = threshold;
        this.timeout = timeout;
        this.monitoringPeriod = monitoringPeriod;
        
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = null;
        this.nextAttempt = null;
        
        // Reset counters periodically
        setInterval(() => this.resetCounters(), monitoringPeriod);
    }

    async execute(operation) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Circuit breaker is OPEN - service temporarily unavailable');
            }
            this.state = 'HALF_OPEN';
        }

        try {
            const result = await operation();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        this.successes++;
        if (this.state === 'HALF_OPEN') {
            this.state = 'CLOSED';
            this.failures = 0;
        }
    }

    onFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        
        if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
        }
    }

    resetCounters() {
        if (this.state === 'CLOSED') {
            this.failures = 0;
            this.successes = 0;
        }
    }

    getState() {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            threshold: this.threshold,
            nextAttempt: this.nextAttempt ? new Date(this.nextAttempt).toISOString() : null
        };
    }
}

// Enhanced Komodo Engine with fault tolerance and optimization
class EnhancedKomodoEngine extends EventEmitter {
    constructor(id = 'default') {
        super();
        this.setMaxListeners(100);
        
        this.id = id;
        this.process = null;
        this.isReady = false;
        this.isHealthy = true;
        this.engineName = 'Unknown';
        this.engineVersion = 'Unknown';
        this.currentSkillLevel = CONFIG.skillLevels.default;
        
        // Request management
        this.pendingRequests = new Map();
        this.requestQueue = new SmartRequestQueue(
            CONFIG.performance.requestQueueSize,
            CONFIG.performance.maxConcurrentRequests
        );
        this.circuitBreaker = new CircuitBreaker(3, 30000, 300000);
        
        // Caching and buffers
        this.moveCache = CONFIG.performance.enableCaching ? 
            new OptimizedLRUCache(CONFIG.performance.cacheSize, CONFIG.performance.cacheTTL) : null;
        this.outputBuffer = '';
        this.lineBuffer = [];
        
        // Performance tracking
        this.stats = {
            movesCalculated: 0,
            cacheHits: 0,
            totalThinkingTime: 0,
            averageThinkingTime: 0,
            restarts: 0,
            uptime: Date.now()
        };
        
        // Health monitoring
        this.lastActivity = Date.now();
        this.healthMetrics = {
            consecutiveFailures: 0,
            maxConsecutiveFailures: 0,
            totalFailures: 0,
            lastError: null,
            memoryPeak: 0
        };
        
        // Timers
        this.setupTimers();
    }

    setupTimers() {
        // Keep-alive ping
        this.keepAliveTimer = setInterval(() => {
            if (this.isReady && (Date.now() - this.lastActivity) > CONFIG.timeouts.keepAlive) {
                this.sendCommand('isready').catch(() => {
                    console.warn(`⚠️  Keep-alive failed for engine ${this.id}`);
                });
            }
        }, CONFIG.timeouts.keepAlive);

        // Health check
        this.healthTimer = setInterval(() => {
            this.performHealthCheck();
        }, 120000);

        // Memory monitoring
        this.memoryTimer = setInterval(() => {
            this.updateMemoryStats();
        }, 60000);
    }

    async initialize(skillLevel = CONFIG.skillLevels.default) {
        console.log(`\n🚀 Initializing Enhanced Komodo Engine [${this.id}]`);
        
        try {
            return await this.circuitBreaker.execute(async () => {
                await this.cleanup();
                return await this.startEngine(skillLevel);
            });
        } catch (error) {
            console.error(`❌ Engine initialization failed [${this.id}]:`, error.message);
            throw error;
        }
    }

    async startEngine(skillLevel) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Engine initialization timeout'));
            }, CONFIG.timeouts.initialization);

            try {
                this.process = spawn(CONFIG.komodoPath, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: false,
                    windowsHide: true,
                    env: { ...process.env, KOMODO_THREADS: CONFIG.engineOptions.Threads }
                });

                this.setupProcessHandlers(resolve, reject, timeout, skillLevel);
                this.sendCommand('uci');

            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    setupProcessHandlers(resolve, reject, timeout, skillLevel) {
        let initialized = false;
        const startTime = Date.now();

        this.process.stdout.on('data', (data) => {
            this.handleEngineOutput(data);
        });

        this.process.stderr.on('data', (data) => {
            const error = data.toString().trim();
            if (error) {
                console.error(`Engine stderr [${this.id}]:`, error);
                this.healthMetrics.lastError = error;
            }
        });

        this.process.on('close', (code, signal) => {
            console.log(`❌ Engine process closed [${this.id}]: code=${code}, signal=${signal}`);
            this.handleProcessExit();
            if (!initialized) {
                clearTimeout(timeout);
                reject(new Error(`Engine closed unexpectedly: code=${code}`));
            }
        });

        this.process.on('error', (error) => {
            console.error(`❌ Engine process error [${this.id}]:`, error);
            clearTimeout(timeout);
            if (!initialized) {
                reject(error);
            }
        });

        this.once('readyok', () => {
            if (!initialized) {
                initialized = true;
                clearTimeout(timeout);
                
                const initTime = Date.now() - startTime;
                this.isReady = true;
                this.currentSkillLevel = skillLevel;
                this.lastActivity = Date.now();
                this.stats.uptime = Date.now();
                
                console.log(`✅ Engine initialized [${this.id}] in ${initTime}ms`);
                resolve({
                    engine: this.engineName,
                    version: this.engineVersion,
                    skillLevel,
                    initTime,
                    ready: true
                });
            }
        });
    }

    handleEngineOutput(data) {
        this.lastActivity = Date.now();
        this.outputBuffer += data.toString();
        
        let newlineIndex;
        while ((newlineIndex = this.outputBuffer.indexOf('\n')) !== -1) {
            const line = this.outputBuffer.slice(0, newlineIndex).trim();
            this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
            
            if (line) {
                this.processEngineLine(line);
            }
        }
    }

    processEngineLine(line) {
        // Optimized line processing with early returns
        if (line.startsWith('id name ')) {
            this.engineName = line.substring(8);
            console.log(`✓ Engine name [${this.id}]:`, this.engineName);
            return;
        }

        if (line.startsWith('id author ')) {
            this.engineVersion = line.substring(10);
            console.log(`✓ Engine author [${this.id}]:`, this.engineVersion);
            return;
        }

        if (line === 'uciok') {
            console.log(`✓ UCI acknowledged [${this.id}]`);
            this.configureEngine();
            return;
        }

        if (line === 'readyok') {
            this.emit('readyok');
            return;
        }

        if (line.startsWith('bestmove ')) {
            this.handleBestMove(line);
            return;
        }

        if (line.startsWith('info ')) {
            this.handleAnalysisInfo(line);
            return;
        }
    }

    handleBestMove(line) {
        const parts = line.split(' ');
        const move = parts[1];
        const ponderMove = parts[3];
        
        if (move && move !== '(none)' && move !== 'none') {
            this.resolvePendingRequests({ move, ponderMove });
            this.healthMetrics.consecutiveFailures = 0;
        } else {
            this.rejectPendingRequests(new Error('No valid move found'));
        }
    }

    handleAnalysisInfo(line) {
        // Parse analysis info for debugging/monitoring
        const info = this.parseAnalysisLine(line);
        if (info.depth && info.time) {
            this.emit('analysis', info);
        }
    }

    parseAnalysisLine(line) {
        const parts = line.split(' ');
        const info = {};
        
        for (let i = 1; i < parts.length - 1; i++) {
            switch (parts[i]) {
                case 'depth':
                    info.depth = parseInt(parts[++i]);
                    break;
                case 'time':
                    info.time = parseInt(parts[++i]);
                    break;
                case 'nodes':
                    info.nodes = parseInt(parts[++i]);
                    break;
                case 'score':
                    if (parts[i + 1] === 'cp') {
                        info.score = parseInt(parts[i + 2]);
                        i += 2;
                    }
                    break;
            }
        }
        
        return info;
    }

    configureEngine() {
        console.log(`✓ Configuring engine options [${this.id}]...`);
        
        const commands = [];
        
        // Set engine options
        Object.entries(CONFIG.engineOptions).forEach(([option, value]) => {
            commands.push(`setoption name ${option} value ${value}`);
        });
        
        // Set skill level
        commands.push(...this.getSkillLevelCommands(this.currentSkillLevel));
        commands.push('isready');
        
        // Send all commands
        commands.forEach(cmd => this.sendCommand(cmd));
    }

    getSkillLevelCommands(skillLevel) {
        const clampedLevel = Math.max(CONFIG.skillLevels.min, 
            Math.min(CONFIG.skillLevels.max, skillLevel));
        
        // Enhanced ELO mapping with better progression
        const minElo = 800;
        const maxElo = 3200;
        const normalizedLevel = (clampedLevel - 1) / (CONFIG.skillLevels.max - 1);
        const eloProgression = Math.pow(normalizedLevel, 1.3); // Slightly curved progression
        const eloRating = Math.round(minElo + eloProgression * (maxElo - minElo));
        
        console.log(`✓ Setting skill level ${clampedLevel} (ELO: ${eloRating}) [${this.id}]`);
        
        return [
            'setoption name UCI_LimitStrength value true',
            `setoption name UCI_Elo value ${eloRating}`,
            `setoption name Skill Level value ${clampedLevel}`
        ];
    }

    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error('Engine process not available'));
                return;
            }

            try {
                this.process.stdin.write(command + '\n');
                this.lastActivity = Date.now();
                resolve(true);
            } catch (error) {
                reject(error);
            }
        });
    }

    async getBestMove(fen, skillLevel = this.currentSkillLevel, options = {}) {
        // Validate inputs
        if (!validateFEN(fen)) {
            throw new Error('Invalid FEN position');
        }

        // Check cache first
        if (this.moveCache && !options.skipCache) {
            const cacheKey = this.createCacheKey(fen, skillLevel, options);
            const cached = this.moveCache.get(cacheKey);
            if (cached) {
                this.stats.cacheHits++;
                console.log(`✓ Cache hit [${this.id}]`);
                return { ...cached, fromCache: true };
            }
        }

        // Add to request queue
        return await this.requestQueue.add(async () => {
            return await this.circuitBreaker.execute(async () => {
                return await this.calculateMove(fen, skillLevel, options);
            });
        }, options.priority || 0);
    }

    createCacheKey(fen, skillLevel, options) {
        const keyParts = [fen, skillLevel];
        if (options.moveTime) keyParts.push(`t${options.moveTime}`);
        if (options.depth) keyParts.push(`d${options.depth}`);
        if (options.nodes) keyParts.push(`n${options.nodes}`);
        return keyParts.join(':');
    }

    async calculateMove(fen, skillLevel, options) {
        if (!this.isReady) {
            throw new Error(`Engine not ready [${this.id}]`);
        }

        // Update skill level if changed
        if (skillLevel !== this.currentSkillLevel) {
            await this.updateSkillLevel(skillLevel);
        }

        const startTime = Date.now();
        const requestId = `move_${startTime}_${Math.random().toString(36).substr(2, 6)}`;

        try {
            const result = await this.performMoveCalculation(fen, options, requestId);
            const calculationTime = Date.now() - startTime;
            
            // Update statistics
            this.updateMoveStats(calculationTime);
            
            // Cache result
            if (this.moveCache && !options.skipCache) {
                const cacheKey = this.createCacheKey(fen, skillLevel, options);
                this.moveCache.set(cacheKey, result);
            }
            
            return { ...result, calculationTime, fromCache: false };
            
        } catch (error) {
            this.healthMetrics.consecutiveFailures++;
            this.healthMetrics.totalFailures++;
            this.healthMetrics.maxConsecutiveFailures = Math.max(
                this.healthMetrics.maxConsecutiveFailures,
                this.healthMetrics.consecutiveFailures
            );
            throw error;
        }
    }

    async performMoveCalculation(fen, options, requestId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.cleanupRequest(requestId);
                reject(new Error('Move calculation timeout'));
            }, CONFIG.timeouts.moveCalculation);

            this.pendingRequests.set(requestId, {
                resolve: (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                timeout,
                startTime: Date.now()
            });

            this.startCalculation(fen, options).catch(error => {
                this.cleanupRequest(requestId);
                reject(error);
            });
        });
    }

    async startCalculation(fen, options) {
        // Set position
        await this.sendCommand(`position fen ${fen}`);
        
        // Determine search command
        let searchCommand = 'go';
        
        if (options.depth && options.depth > 0 && options.depth <= 20) {
            searchCommand += ` depth ${options.depth}`;
        } else if (options.nodes && options.nodes > 100 && options.nodes <= 5000000) {
            searchCommand += ` nodes ${options.nodes}`;
        } else {
            const moveTime = options.moveTime || this.calculateOptimalTime(this.currentSkillLevel);
            searchCommand += ` movetime ${moveTime}`;
        }
        
        await this.sendCommand(searchCommand);
    }

    calculateOptimalTime(skillLevel) {
        // Dynamic time calculation based on skill level
        const baseTime = 500;
        const skillMultiplier = 1 + (skillLevel - 1) * 0.2;
        return Math.min(Math.round(baseTime * skillMultiplier), 8000);
    }

    resolvePendingRequests(result) {
        this.pendingRequests.forEach((request) => {
            request.resolve(result);
        });
        this.pendingRequests.clear();
    }

    rejectPendingRequests(error) {
        this.pendingRequests.forEach((request) => {
            request.reject(error);
        });
        this.pendingRequests.clear();
    }

    cleanupRequest(requestId) {
        const request = this.pendingRequests.get(requestId);
        if (request) {
            clearTimeout(request.timeout);
            this.pendingRequests.delete(requestId);
        }
    }

    async updateSkillLevel(skillLevel) {
        const commands = this.getSkillLevelCommands(skillLevel);
        for (const command of commands) {
            await this.sendCommand(command);
        }
        this.currentSkillLevel = skillLevel;
        await this.waitForReady();
    }

    async waitForReady(timeout = CONFIG.timeouts.commandResponse) {
        return new Promise((resolve, reject) => {
            if (this.isReady) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                reject(new Error('Engine ready timeout'));
            }, timeout);

            const checkReady = () => {
                if (this.isReady) {
                    clearTimeout(timer);
                    resolve();
                } else {
                    setTimeout(checkReady, 100);
                }
            };

            checkReady();
        });
    }

    updateMoveStats(calculationTime) {
        this.stats.movesCalculated++;
        this.stats.totalThinkingTime += calculationTime;
        this.stats.averageThinkingTime = Math.round(
            this.stats.totalThinkingTime / this.stats.movesCalculated
        );
    }

    performHealthCheck() {
        const memUsage = process.memoryUsage();
        const memMB = Math.round(memUsage.rss / 1024 / 1024);
        
        // Update peak memory usage
        this.healthMetrics.memoryPeak = Math.max(this.healthMetrics.memoryPeak, memMB);
        
        // Check for unhealthy conditions
        const isUnhealthy = 
            this.healthMetrics.consecutiveFailures >= 3 ||
            !this.isReady ||
            memMB > 1500 ||
            (Date.now() - this.lastActivity) > CONFIG.timeouts.keepAlive * 2;
        
        if (isUnhealthy && this.isHealthy) {
            console.warn(`⚠️  Engine health degraded [${this.id}]`);
            this.isHealthy = false;
            this.emit('healthDegraded');
        } else if (!isUnhealthy && !this.isHealthy) {
            console.log(`✅ Engine health restored [${this.id}]`);
            this.isHealthy = true;
            this.emit('healthRestored');
        }
    }

    updateMemoryStats() {
        const memUsage = process.memoryUsage();
        const memMB = Math.round(memUsage.rss / 1024 / 1024);
        
        if (memMB > 800 && this.moveCache) {
            console.log(`🧹 High memory usage (${memMB}MB), optimizing cache [${this.id}]`);
            
            // Reduce cache size temporarily
            const oldStats = this.moveCache.getStats();
            const newSize = Math.max(500, Math.floor(this.moveCache.maxSize * 0.7));
            
            // Create new smaller cache
            const newCache = new OptimizedLRUCache(newSize, this.moveCache.ttl);
            this.moveCache.destroy();
            this.moveCache = newCache;
            
            console.log(`Cache resized from ${oldStats.size} to ${newSize} entries [${this.id}]`);
        }
    }

    handleProcessExit() {
        this.isReady = false;
        this.isHealthy = false;
        this.process = null;
        
        // Reject all pending requests
        this.rejectPendingRequests(new Error('Engine process terminated'));
        
        this.emit('processExit');
        
        // Auto-restart if configured and not shutting down
        if (process.env.AUTO_RESTART !== 'false' && !this.isShuttingDown) {
            console.log(`🔄 Auto-restarting engine [${this.id}] in 5 seconds...`);
            setTimeout(() => {
                this.initialize(this.currentSkillLevel).catch(error => {
                    console.error(`❌ Auto-restart failed [${this.id}]:`, error.message);
                });
            }, 5000);
        }
    }

    async newGame() {
        if (this.isReady) {
            await this.sendCommand('ucinewgame');
            
            // Clear position-specific cache entries
            if (this.moveCache) {
                // Simple cache cleanup - in production, you might want more sophisticated cache invalidation
                this.moveCache.clear();
            }
            
            console.log(`✅ New game started [${this.id}]`);
            return true;
        }
        return false;
    }

    getStatus() {
        return {
            id: this.id,
            ready: this.isReady,
            healthy: this.isHealthy,
            engine: this.engineName,
            version: this.engineVersion,
            skillLevel: this.currentSkillLevel,
            uptime: Date.now() - this.stats.uptime,
            stats: this.stats,
            health: this.healthMetrics,
            queue: this.requestQueue.getStats(),
            cache: this.moveCache ? this.moveCache.getStats() : null,
            circuitBreaker: this.circuitBreaker.getState(),
            memory: this.getMemoryUsage(),
            lastActivity: new Date(this.lastActivity).toISOString()
        };
    }

    getMemoryUsage() {
        const usage = process.memoryUsage();
        return {
            rss: Math.round(usage.rss / 1024 / 1024) + 'MB',
            heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
            external: Math.round(usage.external / 1024 / 1024) + 'MB'
        };
    }

    async cleanup() {
        this.isShuttingDown = true;
        
        // Clear all timers
        [this.keepAliveTimer, this.healthTimer, this.memoryTimer].forEach(timer => {
            if (timer) clearInterval(timer);
        });
        
        // Clear cache
        if (this.moveCache) {
            this.moveCache.destroy();
        }
        
        // Clear queue
        this.requestQueue.clear();
        
        // Terminate process
        if (this.process) {
            try {
                await this.sendCommand('quit');
                await delay(1000);
                
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGTERM');
                    await delay(2000);
                    
                    if (this.process && !this.process.killed) {
                        this.process.kill('SIGKILL');
                    }
                }
            } catch (error) {
                console.error(`Error during cleanup [${this.id}]:`, error.message);
            }
        }
        
        this.isReady = false;
        this.process = null;
        this.removeAllListeners();
    }

    async shutdown() {
        console.log(`🛑 Shutting down engine [${this.id}]...`);
        await this.cleanup();
    }
}

// Enhanced Engine Pool with load balancing and health management
class OptimizedEnginePool {
    constructor(maxEngines = 3) {
        this.engines = new Map();
        this.maxEngines = maxEngines;
        this.loadBalanceStrategy = process.env.LOAD_BALANCE_STRATEGY || 'least-loaded';
        this.healthCheckInterval = 60000; // 1 minute
        
        // Start health monitoring
        this.healthTimer = setInterval(() => {
            this.performPoolHealthCheck();
        }, this.healthCheckInterval);
        
        console.log(`✓ Engine pool initialized (max: ${maxEngines}, strategy: ${this.loadBalanceStrategy})`);
    }

    getEngine(id = null) {
        if (id) {
            return this.getSpecificEngine(id);
        }
        
        return this.getOptimalEngine();
    }

    getSpecificEngine(id) {
        if (!this.engines.has(id)) {
            if (this.engines.size >= this.maxEngines) {
                // Find and remove least healthy engine if pool is full
                const leastHealthyId = this.findLeastHealthyEngine();
                if (leastHealthyId) {
                    console.log(`🔄 Replacing unhealthy engine ${leastHealthyId} with ${id}`);
                    this.removeEngine(leastHealthyId);
                } else {
                    throw new Error(`Engine pool at capacity (${this.maxEngines})`);
                }
            }
            
            const engine = new EnhancedKomodoEngine(id);
            this.engines.set(id, engine);
            
            // Set up engine event handlers
            engine.on('healthDegraded', () => {
                console.warn(`⚠️  Engine ${id} health degraded`);
            });
            
            engine.on('processExit', () => {
                console.log(`❌ Engine ${id} process exited`);
            });
        }
        
        return this.engines.get(id);
    }

    getOptimalEngine() {
        if (this.engines.size === 0) {
            return this.getSpecificEngine('default');
        }
        
        const healthyEngines = Array.from(this.engines.entries())
            .filter(([id, engine]) => engine.isHealthy && engine.isReady);
        
        if (healthyEngines.length === 0) {
            // No healthy engines, try to create/restart one
            console.warn('⚠️  No healthy engines available, creating new one');
            return this.getSpecificEngine(`engine_${Date.now()}`);
        }
        
        switch (this.loadBalanceStrategy) {
            case 'round-robin':
                return this.getRoundRobinEngine(healthyEngines);
            case 'least-loaded':
                return this.getLeastLoadedEngine(healthyEngines);
            case 'fastest':
                return this.getFastestEngine(healthyEngines);
            default:
                return healthyEngines[0][1];
        }
    }

    getRoundRobinEngine(engines) {
        this.roundRobinIndex = (this.roundRobinIndex || 0) % engines.length;
        const engine = engines[this.roundRobinIndex][1];
        this.roundRobinIndex++;
        return engine;
    }

    getLeastLoadedEngine(engines) {
        return engines.reduce((least, [id, engine]) => {
            const currentLoad = engine.requestQueue.getStats().queueLength + 
                              engine.pendingRequests.size;
            const leastLoad = least.requestQueue.getStats().queueLength + 
                            least.pendingRequests.size;
            
            return currentLoad < leastLoad ? engine : least;
        }, engines[0][1]);
    }

    getFastestEngine(engines) {
        return engines.reduce((fastest, [id, engine]) => {
            const currentAvgTime = engine.stats.averageThinkingTime || Infinity;
            const fastestAvgTime = fastest.stats.averageThinkingTime || Infinity;
            
            return currentAvgTime < fastestAvgTime ? engine : fastest;
        }, engines[0][1]);
    }

    findLeastHealthyEngine() {
        let leastHealthyId = null;
        let maxFailures = -1;
        
        for (const [id, engine] of this.engines.entries()) {
            const failures = engine.healthMetrics.consecutiveFailures;
            if (failures > maxFailures) {
                maxFailures = failures;
                leastHealthyId = id;
            }
        }
        
        return leastHealthyId;
    }

    async removeEngine(id) {
        const engine = this.engines.get(id);
        if (engine) {
            await engine.shutdown();
            this.engines.delete(id);
            console.log(`🗑️  Removed engine ${id} from pool`);
        }
    }

    performPoolHealthCheck() {
        const unhealthyEngines = [];
        
        for (const [id, engine] of this.engines.entries()) {
            if (!engine.isHealthy || !engine.isReady) {
                unhealthyEngines.push(id);
            }
        }
        
        // Log pool health status
        const totalEngines = this.engines.size;
        const healthyEngines = totalEngines - unhealthyEngines.length;
        
        if (unhealthyEngines.length > 0) {
            console.warn(`⚠️  Pool health: ${healthyEngines}/${totalEngines} engines healthy`);
        }
        
        // Auto-remove persistently unhealthy engines
        for (const id of unhealthyEngines) {
            const engine = this.engines.get(id);
            if (engine && engine.healthMetrics.consecutiveFailures > 5) {
                console.log(`🧹 Removing persistently unhealthy engine ${id}`);
                this.removeEngine(id);
            }
        }
    }

    getPoolStats() {
        const engines = {};
        let totalMoves = 0;
        let totalPendingRequests = 0;
        let healthyCount = 0;
        
        for (const [id, engine] of this.engines.entries()) {
            const status = engine.getStatus();
            engines[id] = status;
            
            totalMoves += status.stats.movesCalculated;
            totalPendingRequests += status.queue.queueLength;
            if (status.healthy && status.ready) healthyCount++;
        }
        
        return {
            totalEngines: this.engines.size,
            healthyEngines: healthyCount,
            maxEngines: this.maxEngines,
            loadBalanceStrategy: this.loadBalanceStrategy,
            totalMovesCalculated: totalMoves,
            totalPendingRequests,
            utilizationRate: this.engines.size > 0 ? 
                ((totalPendingRequests / this.engines.size) * 100).toFixed(1) + '%' : '0%',
            engines
        };
    }

    async shutdownAll() {
        console.log('🛑 Shutting down all engines...');
        clearInterval(this.healthTimer);
        
        const shutdownPromises = Array.from(this.engines.values())
            .map(engine => engine.shutdown());
        
        await Promise.allSettled(shutdownPromises);
        this.engines.clear();
        
        console.log('✅ All engines shut down');
    }
}

// Advanced rate limiting with sliding window and user tracking
class AdvancedRateLimiter {
    constructor() {
        this.clients = new Map();
        this.config = {
            windowSize: 60000, // 1 minute
            maxRequests: CONFIG.security.rateLimit,
            blockDuration: 300000, // 5 minutes
            burstLimit: Math.ceil(CONFIG.security.rateLimit * 0.3), // 30% burst
            burstWindow: 10000 // 10 seconds
        };
        
        // Cleanup interval
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 60000);
    }

    middleware() {
        return (req, res, next) => {
            const clientId = this.getClientId(req);
            const now = Date.now();
            
            if (!this.clients.has(clientId)) {
                this.clients.set(clientId, {
                    requests: [],
                    burstRequests: [],
                    blocked: false,
                    blockExpiry: 0,
                    totalRequests: 0
                });
            }
            
            const client = this.clients.get(clientId);
            
            // Check if client is blocked
            if (client.blocked && now < client.blockExpiry) {
                return res.status(429).json({
                    error: 'Rate limit exceeded - temporarily blocked',
                    retryAfter: Math.ceil((client.blockExpiry - now) / 1000),
                    limit: this.config.maxRequests,
                    window: this.config.windowSize / 1000
                });
            } else if (client.blocked && now >= client.blockExpiry) {
                client.blocked = false;
                client.requests = [];
                client.burstRequests = [];
            }
            
            // Clean old requests
            client.requests = client.requests.filter(
                timestamp => timestamp > now - this.config.windowSize
            );
            client.burstRequests = client.burstRequests.filter(
                timestamp => timestamp > now - this.config.burstWindow
            );
            
            // Check burst limit
            if (client.burstRequests.length >= this.config.burstLimit) {
                return res.status(429).json({
                    error: 'Burst rate limit exceeded',
                    retryAfter: Math.ceil(this.config.burstWindow / 1000),
                    limit: this.config.burstLimit,
                    window: this.config.burstWindow / 1000
                });
            }
            
            // Check normal rate limit
            if (client.requests.length >= this.config.maxRequests) {
                client.blocked = true;
                client.blockExpiry = now + this.config.blockDuration;
                
                return res.status(429).json({
                    error: 'Rate limit exceeded',
                    retryAfter: Math.ceil(this.config.blockDuration / 1000),
                    limit: this.config.maxRequests,
                    window: this.config.windowSize / 1000
                });
            }
            
            // Add request timestamps
            client.requests.push(now);
            client.burstRequests.push(now);
            client.totalRequests++;
            
            // Add rate limit headers
            res.set({
                'X-RateLimit-Limit': this.config.maxRequests,
                'X-RateLimit-Remaining': Math.max(0, this.config.maxRequests - client.requests.length),
                'X-RateLimit-Reset': new Date(now + this.config.windowSize).toISOString(),
                'X-RateLimit-Burst-Limit': this.config.burstLimit,
                'X-RateLimit-Burst-Remaining': Math.max(0, this.config.burstLimit - client.burstRequests.length)
            });
            
            next();
        };
    }

    getClientId(req) {
        return req.ip || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress ||
               (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
               'unknown';
    }

    cleanup() {
        const now = Date.now();
        const clientsToDelete = [];
        
        for (const [clientId, client] of this.clients.entries()) {
            // Remove clients with no recent activity
            const lastRequest = Math.max(
                client.requests[client.requests.length - 1] || 0,
                client.burstRequests[client.burstRequests.length - 1] || 0
            );
            
            if (now - lastRequest > this.config.windowSize * 2 && !client.blocked) {
                clientsToDelete.push(clientId);
            }
        }
        
        clientsToDelete.forEach(clientId => this.clients.delete(clientId));
        
        if (clientsToDelete.length > 0) {
            console.log(`🧹 Rate limiter cleanup: removed ${clientsToDelete.length} inactive clients`);
        }
    }

    getStats() {
        const stats = {
            totalClients: this.clients.size,
            blockedClients: 0,
            totalRequests: 0,
            config: this.config
        };
        
        for (const client of this.clients.values()) {
            if (client.blocked) stats.blockedClients++;
            stats.totalRequests += client.totalRequests;
        }
        
        return stats;
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.clients.clear();
    }
}

// Request validation middleware factory
const createValidationMiddleware = () => {
    const validateFENMiddleware = (req, res, next) => {
        const { fen } = req.body;
        if (!fen) {
            return res.status(400).json({ 
                error: 'FEN position is required',
                timestamp: new Date().toISOString()
            });
        }
        
        if (!validateFEN(fen)) {
            return res.status(400).json({ 
                error: 'Invalid FEN position',
                details: 'FEN must be a valid chess position string',
                provided: fen,
                timestamp: new Date().toISOString()
            });
        }
        next();
    };

    const validateSkillLevelMiddleware = (req, res, next) => {
        const { skillLevel } = req.body;
        if (skillLevel !== undefined) {
            const level = parseInt(skillLevel);
            if (isNaN(level) || level < CONFIG.skillLevels.min || level > CONFIG.skillLevels.max) {
                return res.status(400).json({ 
                    error: `Skill level must be between ${CONFIG.skillLevels.min} and ${CONFIG.skillLevels.max}`,
                    provided: skillLevel,
                    timestamp: new Date().toISOString()
                });
            }
            req.body.skillLevel = level;
        } else {
            req.body.skillLevel = CONFIG.skillLevels.default;
        }
        next();
    };

    const validateOptionsMiddleware = (req, res, next) => {
        const errors = [];
        
        // Validate moveTime
        if (req.body.moveTime !== undefined) {
            const time = parseInt(req.body.moveTime);
            if (isNaN(time) || time < 100 || time > 30000) {
                errors.push('moveTime must be between 100 and 30000 milliseconds');
            } else {
                req.body.moveTime = time;
            }
        }
        
        // Validate depth
        if (req.body.depth !== undefined) {
            const depth = parseInt(req.body.depth);
            if (isNaN(depth) || depth < 1 || depth > 20) {
                errors.push('depth must be between 1 and 20');
            } else {
                req.body.depth = depth;
            }
        }
        
        // Validate nodes
        if (req.body.nodes !== undefined) {
            const nodes = parseInt(req.body.nodes);
            if (isNaN(nodes) || nodes < 100 || nodes < 5000000) {
                errors.push('nodes must be between 100 and 5000000');
            } else {
                req.body.nodes = nodes;
            }
        }
        
        if (errors.length > 0) {
            return res.status(400).json({
                error: 'Validation failed',
                details: errors,
                timestamp: new Date().toISOString()
            });
        }
        
        next();
    };

    const validateBatchMiddleware = (req, res, next) => {
        const { positions } = req.body;
        
        if (!Array.isArray(positions)) {
            return res.status(400).json({
                error: 'positions must be an array',
                timestamp: new Date().toISOString()
            });
        }
        
        if (positions.length === 0) {
            return res.status(400).json({
                error: 'positions array cannot be empty',
                timestamp: new Date().toISOString()
            });
        }
        
        if (positions.length > CONFIG.security.maxBatchSize) {
            return res.status(400).json({
                error: `Maximum ${CONFIG.security.maxBatchSize} positions per batch`,
                provided: positions.length,
                timestamp: new Date().toISOString()
            });
        }
        
        // Validate each FEN
        for (let i = 0; i < positions.length; i++) {
            if (!validateFEN(positions[i])) {
                return res.status(400).json({
                    error: 'Invalid FEN in batch',
                    invalidFen: positions[i],
                    position: i + 1,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        next();
    };

    return { 
        validateFENMiddleware, 
        validateSkillLevelMiddleware, 
        validateOptionsMiddleware,
        validateBatchMiddleware
    };
};

// Global instances
const enginePool = new OptimizedEnginePool(CONFIG.clustering.workers);
const rateLimiter = new AdvancedRateLimiter();
const { 
    validateFENMiddleware, 
    validateSkillLevelMiddleware, 
    validateOptionsMiddleware,
    validateBatchMiddleware 
} = createValidationMiddleware();

// Apply middleware
app.use((req, res, next) => {
    req.id = Math.random().toString(36).substr(2, 9);
    req.startTime = Date.now();
    next();
});

// Apply rate limiting to sensitive endpoints
const rateLimitMiddleware = rateLimiter.middleware();
app.use(['/api/engine/move', '/api/engine/batch', '/api/engine/analyze'], rateLimitMiddleware);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(`Unhandled error [${req.id}]:`, err);
    
    const errorResponse = {
        error: 'Internal server error',
        requestId: req.id,
        timestamp: new Date().toISOString()
    };
    
    if (process.env.NODE_ENV === 'development') {
        errorResponse.details = err.message;
        errorResponse.stack = err.stack;
    }
    
    res.status(500).json(errorResponse);
});

// API Routes

app.post('/api/engine/init', validateSkillLevelMiddleware, async (req, res) => {
    const startTime = Date.now();
    console.log(`\n🚀 ENGINE INIT [${req.id}]`);
    
    try {
        const { skillLevel, engineId, warmUp } = req.body;
        const engine = enginePool.getEngine(engineId);
        
        const result = await engine.initialize(skillLevel);
        
        if (warmUp) {
            // Basic warm-up with a simple position
            try {
                await engine.getBestMove(
                    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
                    skillLevel,
                    { moveTime: 100, skipCache: true }
                );
                result.warmedUp = true;
            } catch (warmUpError) {
                console.warn(`Warning: Warm-up failed [${req.id}]:`, warmUpError.message);
                result.warmedUp = false;
            }
        }
        
        const responseTime = Date.now() - startTime;
        console.log(`✅ Init completed [${req.id}] in ${responseTime}ms`);
        
        res.json({
            ...result,
            responseTime,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.error(`❌ Init failed [${req.id}] in ${responseTime}ms:`, error.message);
        
        res.status(500).json({ 
            error: 'Engine initialization failed', 
            details: error.message,
            responseTime,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/engine/move', 
    validateFENMiddleware, 
    validateSkillLevelMiddleware, 
    validateOptionsMiddleware, 
    async (req, res) => {
    
    const startTime = Date.now();
    console.log(`\n🎯 MOVE REQUEST [${req.id}]`);
    
    try {
        const { fen, skillLevel, moveTime, depth, nodes, engineId, priority } = req.body;
        const engine = enginePool.getEngine(engineId);
        
        if (!engine.isReady) {
            return res.status(503).json({ 
                error: 'Engine not ready',
                suggestion: 'Initialize engine first with /api/engine/init',
                engineStatus: engine.getStatus(),
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        }

        const options = { priority: priority || 0 };
        if (moveTime) options.moveTime = moveTime;
        if (depth) options.depth = depth;
        if (nodes) options.nodes = nodes;

        const result = await engine.getBestMove(fen, skillLevel, options);
        const responseTime = Date.now() - startTime;
        
        console.log(`✅ Move calculated [${req.id}] in ${responseTime}ms: ${result.move}${result.fromCache ? ' (cached)' : ''}`);
        
        res.json({ 
            move: result.move,
            ponderMove: result.ponderMove,
            skillLevel: engine.currentSkillLevel,
            calculationTime: result.calculationTime,
            responseTime,
            fromCache: result.fromCache,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.error(`❌ Move calculation failed [${req.id}] in ${responseTime}ms:`, error.message);
        
        const statusCode = error.message.includes('timeout') ? 408 : 
                          error.message.includes('Invalid') ? 400 :
                          error.message.includes('queue') || error.message.includes('overloaded') ? 503 : 500;
                          
        res.status(statusCode).json({ 
            error: 'Move calculation failed', 
            details: error.message,
            responseTime,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/engine/batch', 
    validateBatchMiddleware,
    validateSkillLevelMiddleware, 
    validateOptionsMiddleware, 
    async (req, res) => {
    
    const startTime = Date.now();
    console.log(`\n📦 BATCH REQUEST [${req.id}] - ${req.body.positions.length} positions`);
    
    try {
        const { positions, skillLevel, options = {}, engineId, maxConcurrency = 3 } = req.body;
        const engine = enginePool.getEngine(engineId);
        
        if (!engine.isReady) {
            return res.status(503).json({ 
                error: 'Engine not ready',
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        }

        const batchOptions = { 
            ...options,
            skipCache: options.skipCache || false,
            priority: 1 // Higher priority for batch requests
        };

        // Process positions with controlled concurrency
        const results = [];
        const chunks = [];
        
        // Create chunks for parallel processing
        for (let i = 0; i < positions.length; i += maxConcurrency) {
            chunks.push(positions.slice(i, i + maxConcurrency));
        }
        
        let processedCount = 0;
        const batchStartTime = Date.now();
        
        for (const chunk of chunks) {
            const chunkPromises = chunk.map(async (fen, index) => {
                const globalIndex = processedCount + index;
                const positionStartTime = Date.now();
                
                try {
                    const result = await engine.getBestMove(fen, skillLevel, batchOptions);
                    return {
                        position: globalIndex + 1,
                        fen,
                        move: result.move,
                        ponderMove: result.ponderMove,
                        calculationTime: result.calculationTime,
                        fromCache: result.fromCache,
                        success: true
                    };
                } catch (error) {
                    return {
                        position: globalIndex + 1,
                        fen,
                        error: error.message,
                        calculationTime: Date.now() - positionStartTime,
                        success: false
                    };
                }
            });
            
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
            processedCount += chunk.length;
        }

        const totalBatchTime = Date.now() - batchStartTime;
        const responseTime = Date.now() - startTime;
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const cached = successful.filter(r => r.fromCache);

        console.log(`✅ Batch completed [${req.id}] in ${responseTime}ms: ${successful.length}/${positions.length} successful, ${cached.length} cached`);

        res.json({
            results,
            summary: {
                total: positions.length,
                successful: successful.length,
                failed: failed.length,
                cached: cached.length,
                batchCalculationTime: `${totalBatchTime}ms`,
                averageCalculationTime: `${Math.round(totalBatchTime / positions.length)}ms`,
                responseTime: `${responseTime}ms`,
                throughput: `${(positions.length / totalBatchTime * 1000).toFixed(2)} positions/sec`
            },
            skillLevel: engine.currentSkillLevel,
            engineId: engine.id,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.error(`❌ Batch processing failed [${req.id}] in ${responseTime}ms:`, error.message);
        
        res.status(500).json({
            error: 'Batch processing failed',
            details: error.message,
            responseTime,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/engine/newgame', validateSkillLevelMiddleware, async (req, res) => {
    console.log(`\n🆕 NEW GAME [${req.id}]`);
    
    try {
        const { skillLevel, engineId } = req.body;
        const engine = enginePool.getEngine(engineId);
        
        if (!engine.isReady) {
            return res.status(503).json({ 
                error: 'Engine not ready',
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        }

        await engine.newGame();
        
        if (skillLevel && skillLevel !== engine.currentSkillLevel) {
            await engine.updateSkillLevel(skillLevel);
        }
        
        console.log(`✅ New game started [${req.id}]`);
        res.json({ 
            message: 'New game started', 
            skillLevel: engine.currentSkillLevel,
            engineId: engine.id,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ New game error [${req.id}]:`, error.message);
        res.status(500).json({ 
            error: 'Failed to start new game', 
            details: error.message,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/engine/status', (req, res) => {
    const { engineId, detailed } = req.query;
    
    try {
        if (engineId) {
            const engine = enginePool.getEngine(engineId);
            const status = engine.getStatus();
            
            if (detailed === 'true') {
                status.config = CONFIG;
                status.system = {
                    memory: process.memoryUsage(),
                    uptime: process.uptime(),
                    platform: process.platform,
                    nodeVersion: process.version,
                    cpus: os.cpus().length,
                    loadAverage: os.loadavg()
                };
            }
            
            res.json({
                ...status,
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        } else {
            // Return pool status
            const poolStats = enginePool.getPoolStats();
            const systemStats = {
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                platform: process.platform,
                nodeVersion: process.version,
                cpus: os.cpus().length,
                loadAverage: os.loadavg()
            };
            
            if (detailed === 'true') {
                systemStats.config = CONFIG;
                systemStats.rateLimiter = rateLimiter.getStats();
            }
            
            res.json({
                pool: poolStats,
                system: systemStats,
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get status',
            details: error.message,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/engine/optimize', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { action, engineId } = req.body;
        const validActions = ['clear-cache', 'gc', 'restart', 'health-check'];
        
        if (!validActions.includes(action)) {
            return res.status(400).json({
                error: 'Invalid optimization action',
                validActions,
                requestId: req.id,
                timestamp: new Date().toISOString()
            });
        }
        
        let result = { action };
        
        switch (action) {
            case 'clear-cache':
                if (engineId) {
                    const engine = enginePool.getEngine(engineId);
                    if (engine.moveCache) {
                        const oldStats = engine.moveCache.getStats();
                        engine.moveCache.clear();
                        result.cacheCleared = oldStats.size;
                        result.engineId = engineId;
                    } else {
                        result.message = 'Cache not enabled for this engine';
                    }
                } else {
                    let totalCleared = 0;
                    for (const [id, engine] of enginePool.engines.entries()) {
                        if (engine.moveCache) {
                            const oldStats = engine.moveCache.getStats();
                            engine.moveCache.clear();
                            totalCleared += oldStats.size;
                        }
                    }
                    result.totalCacheCleared = totalCleared;
                }
                break;
                
            case 'gc':
                if (global.gc) {
                    const memBefore = process.memoryUsage();
                    global.gc();
                    const memAfter = process.memoryUsage();
                    result.memoryFreed = {
                        rss: Math.round((memBefore.rss - memAfter.rss) / 1024 / 1024) + 'MB',
                        heapUsed: Math.round((memBefore.heapUsed - memAfter.heapUsed) / 1024 / 1024) + 'MB'
                    };
                } else {
                    result.message = 'Garbage collection not exposed (use --expose-gc flag)';
                }
                break;
                
            case 'restart':
                if (engineId) {
                    const engine = enginePool.getEngine(engineId);
                    const oldSkillLevel = engine.currentSkillLevel;
                    await engine.cleanup();
                    await engine.initialize(oldSkillLevel);
                    result.restarted = true;
                    result.engineId = engineId;
                } else {
                    result.message = 'Engine ID required for restart action';
                }
                break;
                
            case 'health-check':
                if (engineId) {
                    const engine = enginePool.getEngine(engineId);
                    engine.performHealthCheck();
                    result.healthStatus = engine.getStatus().health;
                    result.engineId = engineId;
                } else {
                    enginePool.performPoolHealthCheck();
                    result.poolHealth = enginePool.getPoolStats();
                }
                break;
        }
        
        const responseTime = Date.now() - startTime;
        result.responseTime = responseTime;
        
        res.json({
            message: 'Optimization completed',
            result,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        res.status(500).json({
            error: 'Optimization failed',
            details: error.message,
            responseTime,
            requestId: req.id,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const loadAvg = os.loadavg();
    const poolStats = enginePool.getPoolStats();
    
    // Determine overall health
    const isHealthy = poolStats.healthyEngines > 0 && 
                     memUsage.rss < 1073741824 && // < 1GB
                     loadAvg[0] < os.cpus().length * 2;
    
    const healthData = { 
        status: isHealthy ? 'healthy' : 'degraded',
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        uptime: {
            process: Math.round(process.uptime()),
            system: Math.round(os.uptime())
        },
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
            external: Math.round(memUsage.external / 1024 / 1024) + 'MB',
            usage: Math.round((memUsage.rss / os.totalmem()) * 100) + '%'
        },
        cpu: {
            loadAverage: loadAvg.map(avg => avg.toFixed(2)),
            cores: os.cpus().length,
            usage: Math.min(100, Math.round((loadAvg[0] / os.cpus().length) * 100)) + '%'
        },
        platform: {
            os: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            hostname: os.hostname()
        },
        engines: {
            total: poolStats.totalEngines,
            healthy: poolStats.healthyEngines,
            totalMoves: poolStats.totalMovesCalculated,
            utilization: poolStats.utilizationRate
        }
    };
    
    res.status(isHealthy ? 200 : 503).json(healthData);
});

app.get('/api/metrics', (req, res) => {
    const poolStats = enginePool.getPoolStats();
    const rateLimiterStats = rateLimiter.getStats();
    const memUsage = process.memoryUsage();
    
    // Prometheus-style metrics
    const metrics = [
        `# HELP chess_engine_pool_size Number of engines in pool`,
        `# TYPE chess_engine_pool_size gauge`,
        `chess_engine_pool_size ${poolStats.totalEngines}`,
        ``,
        `# HELP chess_engine_healthy_count Number of healthy engines`,
        `# TYPE chess_engine_healthy_count gauge`,
        `chess_engine_healthy_count ${poolStats.healthyEngines}`,
        ``,
        `# HELP chess_moves_calculated_total Total moves calculated`,
        `# TYPE chess_moves_calculated_total counter`,
        `chess_moves_calculated_total ${poolStats.totalMovesCalculated}`,
        ``,
        `# HELP chess_pending_requests Current pending requests`,
        `# TYPE chess_pending_requests gauge`,
        `chess_pending_requests ${poolStats.totalPendingRequests}`,
        ``,
        `# HELP rate_limiter_total_clients Total rate limiter clients`,
        `# TYPE rate_limiter_total_clients gauge`,
        `rate_limiter_total_clients ${rateLimiterStats.totalClients}`,
        ``,
        `# HELP rate_limiter_blocked_clients Blocked rate limiter clients`,
        `# TYPE rate_limiter_blocked_clients gauge`,
        `rate_limiter_blocked_clients ${rateLimiterStats.blockedClients}`,
        ``,
        `# HELP process_memory_usage_bytes Process memory usage`,
        `# TYPE process_memory_usage_bytes gauge`,
        `process_memory_usage_bytes{type="rss"} ${memUsage.rss}`,
        `process_memory_usage_bytes{type="heap_used"} ${memUsage.heapUsed}`,
        `process_memory_usage_bytes{type="heap_total"} ${memUsage.heapTotal}`,
        `process_memory_usage_bytes{type="external"} ${memUsage.external}`,
        ``
    ].join('\n');
    
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics);
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        suggestion: 'Check API documentation for available endpoints',
        availableEndpoints: [
            'POST /api/engine/init',
            'POST /api/engine/move',
            'POST /api/engine/batch',
            'POST /api/engine/newgame',
            'GET /api/engine/status',
            'POST /api/engine/optimize',
            'GET /api/health',
            'GET /api/metrics'
        ],
        requestId: req.id,
        timestamp: new Date().toISOString()
    });
});

// Enhanced clustering support
if (CONFIG.clustering.enabled && cluster.isMaster) {
    console.log(`🚀 Master process ${process.pid} starting ${CONFIG.clustering.workers} workers`);
    
    for (let i = 0; i < CONFIG.clustering.workers; i++) {
        const worker = cluster.fork();
        worker.on('message', (msg) => {
            if (msg.type === 'memory-warning') {
                console.warn(`⚠️  Worker ${worker.process.pid} reports high memory usage`);
            }
        });
    }
    
    cluster.on('exit', (worker, code, signal) => {
        console.log(`❌ Worker ${worker.process.pid} died (code: ${code}, signal: ${signal})`);
        
        if (!worker.exitedAfterDisconnect) {
            console.log('🔄 Starting replacement worker...');
            const newWorker = cluster.fork();
            newWorker.on('message', (msg) => {
                if (msg.type === 'memory-warning') {
                    console.warn(`⚠️  Worker ${newWorker.process.pid} reports high memory usage`);
                }
            });
        }
    });
    
    // Graceful shutdown for master
    const shutdownMaster = async () => {
        console.log('\n🛑 Master shutting down workers...');
        
        for (const worker of Object.values(cluster.workers)) {
            worker.disconnect();
        }
        
        await delay(CONFIG.timeouts.gracefulShutdown);
        
        for (const worker of Object.values(cluster.workers)) {
            if (!worker.isDead()) {
                worker.kill();
            }
        }
        
        console.log('✅ Master shutdown complete');
        process.exit(0);
    };
    
    process.on('SIGINT', shutdownMaster);
    process.on('SIGTERM', shutdownMaster);
    
} else {
    // Worker process or single process mode
    
    // Memory monitoring for workers
    if (cluster.isWorker) {
        setInterval(() => {
            const memUsage = process.memoryUsage();
            const memMB = Math.round(memUsage.rss / 1024 / 1024);
            
            if (memMB > 800) {
                process.send({ type: 'memory-warning', usage: memMB });
            }
        }, 30000);
    }
    
    // Enhanced graceful shutdown
    const gracefulShutdown = async (signal) => {
        console.log(`\n🛑 Worker ${process.pid} received ${signal}, shutting down gracefully...`);
        
        const shutdownTimeout = setTimeout(() => {
            console.log('❌ Shutdown timeout exceeded, forcing exit');
            process.exit(1);
        }, CONFIG.timeouts.gracefulShutdown);
        
        try {
            // Stop accepting new connections
            if (server) {
                server.close(() => {
                    console.log('✓ HTTP server closed');
                });
            }
            
            // Shutdown engine pool
            await enginePool.shutdownAll();
            
            // Cleanup rate limiter
            rateLimiter.destroy();
            
            console.log('✅ Graceful shutdown completed');
            clearTimeout(shutdownTimeout);
            process.exit(0);
            
        } catch (error) {
            console.error('❌ Error during shutdown:', error);
            clearTimeout(shutdownTimeout);
            process.exit(1);
        }
    };

    // Signal handlers
    ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'].forEach(signal => {
        process.on(signal, () => gracefulShutdown(signal));
    });

    // Unhandled error handlers
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught Exception:', error);
        console.error('Stack:', error.stack);
        gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Promise Rejection at:', promise);
        console.error('Reason:', reason);
        // Don't exit immediately for unhandled rejections in production
        if (process.env.NODE_ENV !== 'production') {
            gracefulShutdown('unhandledRejection');
        }
    });

    // Enhanced server startup
    const startServer = async () => {
        try {
            const server = app.listen(PORT, () => {
                const workerId = cluster.worker ? cluster.worker.id : 'single';
                const processInfo = cluster.isWorker ? `Worker ${workerId} (PID: ${process.pid})` : `PID: ${process.pid}`;
                
                console.log('\n🚀 ===============================================');
                console.log(`   Enhanced Komodo Chess Engine Server`);
                console.log(`   ${processInfo}`);
                console.log(`   http://localhost:${PORT}`);
                console.log('===============================================');
                console.log('Configuration:');
                console.log(`  Engine Path: ${CONFIG.komodoPath}`);
                console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
                console.log(`  Hash Size: ${CONFIG.engineOptions.Hash}MB`);
                console.log(`  Threads: ${CONFIG.engineOptions.Threads}`);
                console.log(`  Caching: ${CONFIG.performance.enableCaching ? 'enabled' : 'disabled'}`);
                console.log(`  Max Concurrent: ${CONFIG.performance.maxConcurrentRequests}`);
                console.log(`  Rate Limit: ${CONFIG.security.rateLimit}/min`);
                console.log(`  Max Batch Size: ${CONFIG.security.maxBatchSize}`);
                console.log(`  Clustering: ${CONFIG.clustering.enabled ? 'enabled' : 'disabled'}`);
                console.log('Ready for enhanced chess calculations! 🎯\n');
            });

            server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.error(`❌ Port ${PORT} is already in use`);
                    process.exit(1);
                } else {
                    console.error('❌ Server error:', error);
                    throw error;
                }
            });

            // Auto-initialize default engine if requested
            if (process.env.AUTO_INIT === 'true') {
                console.log('🔄 Auto-initializing default engine...');
                try {
                    const defaultEngine = enginePool.getEngine('default');
                    await defaultEngine.initialize(CONFIG.skillLevels.default);
                    console.log('✅ Default engine auto-initialized successfully');
                } catch (error) {
                    console.error('⚠️  Default engine auto-initialization failed:', error.message);
                }
            }

            // Performance monitoring and logging
            setInterval(() => {
                const poolStats = enginePool.getPoolStats();
                const memUsage = process.memoryUsage();
                const memMB = Math.round(memUsage.rss / 1024 / 1024);
                
                // Log high load warnings
                if (poolStats.totalPendingRequests > 10) {
                    console.warn(`⚠️  High load: ${poolStats.totalPendingRequests} pending requests across ${poolStats.totalEngines} engines`);
                }
                
                // Log memory warnings
                if (memMB > 1000) {
                    console.warn(`⚠️  High memory usage: ${memMB}MB`);
                }
                
                // Periodic performance summary (every 10 minutes)
                if (Date.now() % 600000 < 60000) {
                    console.log(`📊 Performance Summary:`);
                    console.log(`   Total Moves: ${poolStats.totalMovesCalculated}`);
                    console.log(`   Healthy Engines: ${poolStats.healthyEngines}/${poolStats.totalEngines}`);
                    console.log(`   Memory Usage: ${memMB}MB`);
                    console.log(`   Utilization: ${poolStats.utilizationRate}`);
                }
            }, 60000); // Check every minute

            return server;

        } catch (error) {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        }
    };

    // Start the server
    let server;
    startServer().then(s => server = s);
}

// Export for testing
module.exports = { 
    app, 
    enginePool,
    CONFIG,
    EnhancedKomodoEngine,
    OptimizedEnginePool,
    OptimizedLRUCache,
    SmartRequestQueue,
    CircuitBreaker,
    AdvancedRateLimiter,
    validateFEN
};