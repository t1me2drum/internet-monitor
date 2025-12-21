// server.js — Internet Monitor v1.3.6 + hostnames
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ping = require('ping');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// Монітори
const monitors = new Map();
monitors.set('main', { id: 'main', target: '8.8.8.8', type: 'main', lastStatus: null, failCount: 0, successCount: 0 });
monitors.set('custom', { id: 'custom', target: '185.41.20.4', type: 'custom', lastStatus: null, failCount: 0, successCount: 0 });

// ===== static + index =====
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ===== endpoint логів =====
app.get('/log/today', (req, res) => {
  const fileName = `${new Date().toISOString().slice(0, 10)}.txt`;
  const filePath = path.join(LOG_DIR, fileName);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send('⚠️ Лог-файл за сьогодні ще не створено.');
});

// ===== socket =====
io.on('connection', (socket) => {
  console.log('🔌 Клієнт підключився');
  socket.emit('monitorList', Array.from(monitors.values()).map(m => ({ id: m.id, target: m.target, label: m.label || '', type: m.type })));

  // --- зміна custom IP ---
  socket.on('setCustomIp', (ip) => {
    if (!ip || typeof ip !== 'string') return;
    const cm = monitors.get('custom');
    const old = cm.target;
    cm.target = ip;
    cm.failCount = cm.successCount = 0;
    cm.lastStatus = null;
    const timeStr = new Date().toLocaleTimeString('uk-UA');
    logEvent(`🎯 Змінено ціль custom монітора з ${old} на ${ip}`, timeStr);
    console.log(`🎯 custom target set to ${ip}`);
    io.emit('monitorUpdated', { id: 'custom', target: ip });
  });

  // --- додавання нового монітора ---
  socket.on('addMonitor', (target, cb) => {
    const extrasCount = Array.from(monitors.values()).filter(m => m.type === 'extra').length;
    if (extrasCount >= 3) return cb && cb({ ok: false, error: 'max' });
    if (!target || typeof target !== 'string') return cb && cb({ ok: false, error: 'invalid' });

    // 🆕 Розбір "IP - Назва"
    const [address, label] = target.split('-').map(s => s.trim());

    const id = 'extra-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const monitor = { id, target: address, label: label || '', type: 'extra', lastStatus: null, failCount: 0, successCount: 0 };
    monitors.set(id, monitor);

    const timeStr = new Date().toLocaleTimeString('uk-UA');
    logEvent(`➕ Додано моніторинг ${address}${label ? ` (${label})` : ''}`, timeStr);

    io.emit('monitorAdded', { id: monitor.id, target: monitor.target, label: monitor.label, type: monitor.type });
    console.log(`➕ Додано монітор ${id} -> ${address}${label ? ` (${label})` : ''}`);
    cb && cb({ ok: true, id: monitor.id });
  });

  // --- видалення монітора ---
  socket.on('removeMonitor', (id, cb) => {
    if (!id || !monitors.has(id)) return cb && cb({ ok: false, error: 'notfound' });
    const m = monitors.get(id);
    if (m.type !== 'extra') return cb && cb({ ok: false, error: 'forbidden' });
    monitors.delete(id);
    const timeStr = new Date().toLocaleTimeString('uk-UA');
    logEvent(`➖ Видалено моніторинг ${m.target}`, timeStr);
    io.emit('monitorRemoved', { id });
    console.log(`➖ Видалено монітор ${id}`);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => console.log('🔌 Клієнт відключився'));
});

// ===== ping loop =====
const INTERVAL = 3000;
const THRESHOLD = 5;

setInterval(async () => {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('uk-UA');

  for (const [id, m] of monitors.entries()) {
    try {
      const res = await ping.promise.probe(m.target, { timeout: 2 });
      const alive = !!res.alive;
      const responseTime = alive ? (Number(res.time) || 0) : 0;

      io.emit('pingData', { id: m.id, target: m.target, alive, time: timeStr, responseTime });

      if (!alive) {
        m.failCount = (m.failCount || 0) + 1;
        m.successCount = 0;
      } else {
        m.successCount = (m.successCount || 0) + 1;
        m.failCount = 0;
      }

      if (m.failCount >= THRESHOLD && m.lastStatus !== false) {
        m.lastStatus = false;
        const statusText = `❌ ${m.target} недоступний (${THRESHOLD} невдалих пінгів підряд)`;
        logEvent(statusText, timeStr);
      }

      if (m.successCount >= THRESHOLD && m.lastStatus !== true) {
        m.lastStatus = true;
        const statusText = `✅ ${m.target} відновлено (${THRESHOLD} успішних пінгів підряд)`;
        logEvent(statusText, timeStr);
      }
    } catch (err) {
      console.error(`Ping error for ${m.target}:`, err?.message || err);
      m.failCount++;
      m.successCount = 0;
      if (m.failCount >= THRESHOLD && m.lastStatus !== false) {
        m.lastStatus = false;
        logEvent(`❌ ${m.target} недоступний (помилка ping)`, timeStr);
      }
    }
  }
}, INTERVAL);

// ===== логування =====
function logEvent(statusText, timeStr) {
  const now = new Date();
  const fname = `${now.toISOString().slice(0, 10)}.txt`;
  const filePath = path.join(LOG_DIR, fname);
  const line = `${timeStr} — ${statusText}\n`;
  try {
    fs.appendFileSync(filePath, line);
  } catch (e) {
    console.error('Логування помилка:', e);
  }
  io.emit('log', { time: timeStr, status: statusText });
  console.log(line.trim());
}

// ===== старт =====
server.listen(PORT, () => console.log(`✅ Internet Monitor v1.3.6+hostnames: http://localhost:${PORT}`));
