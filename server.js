const express = require('express');
const os = require('os');
const path = require('path');

const app = express();
const port = 3000;

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 资源使用历史数据（10分钟，每10秒一条）
const resourceHistory = {
  cpu: [],
  memory: [],
  timestamp: []
};

// 系统状态缓存
let systemStatsCache = null;
let lastCacheUpdate = 0;
const CACHE_INTERVAL = 10000; // 10秒

// IP请求计数存储
const ipRequestCount = new Map();

// 定时清空IP请求计数（每小时）
setInterval(() => {
  ipRequestCount.clear();
  console.log('IP请求计数已清空');
}, 60 * 60 * 1000);

// 上一次CPU时间戳（用于计算CPU使用率）
let lastCpuInfo = null;
let lastCpuTimestamp = 0;

// 计算CPU使用率
function calculateCpuUsage() {
  const cpus = os.cpus();
  const now = Date.now();
  
  // 如果是第一次调用，返回N/A
  if (!lastCpuInfo) {
    lastCpuInfo = cpus;
    lastCpuTimestamp = now;
    return 'N/A';
  }
  
  // 计算时间差
  const timeDiff = now - lastCpuTimestamp;
  if (timeDiff === 0) {
    return 'N/A';
  }
  
  let totalIdle = 0;
  let totalTick = 0;
  
  // 计算所有CPU核心的总空闲时间和总时间
  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const lastCpu = lastCpuInfo[i];
    
    // 计算当前CPU的总时间
    let currentTick = 0;
    for (const type in cpu.times) {
      currentTick += cpu.times[type];
    }
    
    // 计算上次CPU的总时间
    let lastTick = 0;
    for (const type in lastCpu.times) {
      lastTick += lastCpu.times[type];
    }
    
    // 计算时间差
    const tickDiff = currentTick - lastTick;
    const idleDiff = cpu.times.idle - lastCpu.times.idle;
    
    totalIdle += idleDiff;
    totalTick += tickDiff;
  }
  
  // 计算CPU使用率
  if (totalTick > 0) {
    const usage = ((totalTick - totalIdle) / totalTick * 100).toFixed(2);
    
    // 更新上次CPU信息
    lastCpuInfo = cpus;
    lastCpuTimestamp = now;
    
    return usage + '%';
  }
  
  return 'N/A';
}

// 实际获取系统资源使用情况的函数
function fetchSystemStats() {
  try {
    // 内存使用情况
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem * 100).toFixed(2);
    
    // CPU使用情况
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    
    // 计算CPU使用率
    const cpuUsage = calculateCpuUsage();
    
    // 系统信息
    const uptime = os.uptime();
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    
    // 更新资源历史数据
    const now = new Date();
    resourceHistory.timestamp.push(now.toISOString());
    resourceHistory.memory.push(parseFloat(memUsage));
    // 解析CPU使用率，移除'%'符号
    const cpuUsageValue = cpuUsage === 'N/A' ? 0 : parseFloat(cpuUsage.replace('%', '')) || 0;
    resourceHistory.cpu.push(cpuUsageValue);
    
    // 保持历史数据不超过10分钟（60条，每10秒一条）
    const maxDataPoints = 60;
    if (resourceHistory.timestamp.length > maxDataPoints) {
      resourceHistory.timestamp.shift();
      resourceHistory.memory.shift();
      resourceHistory.cpu.shift();
    }
    
    const stats = {
      memory: {
        total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        used: (usedMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        free: (freeMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        usage: memUsage + '%'
      },
      cpu: {
        count: cpuCount,
        model: cpus[0].model,
        usage: cpuUsage
      },
      system: {
        uptime: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm',
        hostname,
        platform,
        arch
      },
      history: {
        timestamp: resourceHistory.timestamp,
        memory: resourceHistory.memory,
        cpu: resourceHistory.cpu
      }
    };
    
    // 更新缓存
    systemStatsCache = stats;
    lastCacheUpdate = Date.now();
    
    return stats;
  } catch (error) {
    console.error('[系统信息] 获取系统信息失败:', error.message);
    return {
      memory: {
        total: 'N/A',
        used: 'N/A',
        free: 'N/A',
        usage: 'N/A'
      },
      cpu: {
        count: 'N/A',
        model: 'N/A',
        usage: 'N/A'
      },
      system: {
        uptime: 'N/A',
        hostname: 'N/A',
        platform: 'N/A',
        arch: 'N/A'
      },
      history: {
        timestamp: [],
        memory: [],
        cpu: []
      }
    };
  }
}

// 获取系统资源使用情况（使用缓存）
function getSystemStats() {
  const now = Date.now();
  
  // 检查缓存是否有效
  if (systemStatsCache && (now - lastCacheUpdate) < CACHE_INTERVAL) {
    return systemStatsCache;
  }
  
  // 缓存无效，重新获取
  return fetchSystemStats();
}

// 获取请求数量前5的IP地址
function getTopIPs() {
  // 将Map转换为数组并排序
  const sortedIPs = Array.from(ipRequestCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  return sortedIPs.map(([ip, count]) => ({ ip, count }));
}

// 频率限制存储
const rateLimitStore = new Map();

// 检查频率限制
function checkRateLimit(ip) {
  // 本地请求不限制
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return true;
  }
  
  const now = Date.now();
  const lastRequest = rateLimitStore.get(ip);
  
  if (lastRequest && (now - lastRequest) < 10000) { // 10秒限制
    return false;
  }
  
  rateLimitStore.set(ip, now);
  return true;
}

// 获取客户端IP
function getClientIP(req) {
  return req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
}

// 状态API路由
app.get('/api/status', (req, res) => {
  const clientIP = getClientIP(req);
  
  // 增加IP请求计数
  const currentCount = ipRequestCount.get(clientIP) || 0;
  ipRequestCount.set(clientIP, currentCount + 1);
  
  // 检查频率限制
  if (!checkRateLimit(clientIP)) {
    console.log(`[状态API] IP ${clientIP} 请求过于频繁，请稍后再试`);
    return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  }
  
  try {
    // 获取系统资源使用情况
    const systemStats = getSystemStats();
    // 获取请求数量前5的IP地址
    const topIPs = getTopIPs();
    
    // 返回状态信息
    res.json({
      success: true,      
      system: systemStats,
      topIPs: topIPs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[状态API] 获取状态失败: ${error.message}`);
    res.status(500).json({ success: false, message: '获取状态失败' });
  }
});

// 定时更新系统状态缓存
setInterval(fetchSystemStats, CACHE_INTERVAL);

// 启动服务器
app.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`);
  // 初始获取系统状态
  fetchSystemStats();
});
