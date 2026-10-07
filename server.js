require('dotenv').config();
var fs = require('fs');
var path = require('path');
var http = require('http');
var express = require('express');
var cookieParser = require('cookie-parser');
var bcrypt = require('bcryptjs');
var jwt = require('jsonwebtoken');
var QRCode = require('qrcode');
var pino = require('pino');
var WebSocket = require('ws');
var baileys = require('@whiskeysockets/baileys');
var makeWASocket = baileys.default || baileys.makeWASocket;
var useMultiFileAuthState = baileys.useMultiFileAuthState;
var fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;

var PORT = parseInt(process.env.PORT || '5000', 10);
var ADMIN_USER = process.env.ADMIN_USER || 'admin';
var ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
var JWT_SECRET = process.env.JWT_SECRET || 'crmwa-secret-2024';
var ADMIN_HASH = bcrypt.hashSync(ADMIN_PASS, 10);
var DATA_FILE = path.join(__dirname, 'data.json');
var TPL_FILE = path.join(__dirname, 'template.json');
var AUTH_DIR = path.join(__dirname, 'auth');
var DEFAULT_TPL = 'Halo {nama}, kami dari tim kami ingin mengingatkan Anda. Selamat {waktu}.';

function log(tag, msg) {
  console.log('[' + new Date().toISOString() + '] [' + tag + '] ' + msg);
}
function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clean(s) { return String(s === undefined || s === null ? '' : s).replace(/[<>$`]/g, '').trim(); }

function readJson(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { log('ERR', 'read ' + file + ': ' + e.message); }
  return def;
}
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function loadData() {
  var d = readJson(DATA_FILE, null);
  if (!d || !Array.isArray(d.nasabah)) d = { nasabah: [], nextId: 1 };
  if (!d.nextId) d.nextId = 1;
  return d;
}
function saveData(d) { writeJson(DATA_FILE, d); }
function loadTemplate() {
  var t = readJson(TPL_FILE, null);
  if (!t || typeof t.text !== 'string') t = { text: DEFAULT_TPL };
  return t;
}

function normalize(raw) {
  var d = String(raw === undefined || raw === null ? '' : raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.indexOf('62') === 0) { /* ok */ }
  else if (d.charAt(0) === '0') d = '62' + d.slice(1);
  else if (d.charAt(0) === '8') d = '62' + d;
  else return null;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

function buildMessage(tpl, n) {
  var h = new Date().getHours();
  var w = h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
  return String(tpl).split('{nama}').join(n.nama).split('{no_hp}').join(n.no_hp).split('{waktu}').join(w);
}

function verifyToken(t) {
  try { return jwt.verify(t, JWT_SECRET); } catch (e) { return null; }
}
function getToken(req) {
  var h = req.headers.authorization || '';
  if (h.indexOf('Bearer ') === 0) return h.slice(7);
  return (req.cookies && req.cookies.token) || '';
}

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server, path: '/ws' });

function broadcast(obj) {
  var s = JSON.stringify(obj);
  wss.clients.forEach(function (c) {
    if (c.readyState === WebSocket.OPEN) c.send(s);
  });
}

wss.on('connection', function (ws, req) {
  var u = new URL(req.url, 'http://localhost');
  if (!verifyToken(u.searchParams.get('token') || '')) { ws.close(1008, 'unauthorized'); return; }
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });
  ws.on('message', function (m) {
    try {
      var j = JSON.parse(m.toString());
      if (j.type === 'ping') { ws.isAlive = true; ws.send(JSON.stringify({ type: 'pong' })); }
    } catch (e) { /* abaikan */ }
  });
  ws.send(JSON.stringify({ type: 'wa_status', status: waStatus }));
});
setInterval(function () {
  wss.clients.forEach(function (c) {
    if (c.isAlive === false) { c.terminate(); return; }
    c.isAlive = false;
    try { c.ping(); } catch (e) { /* abaikan */ }
  });
}, 30000);

// ===================== WHATSAPP =====================
var sock = null;
var waStatus = 'disconnected';
var aborted = false;
var currentMode = 'qr';
var pairingPhone = null;

function setStatus(s) {
  waStatus = s;
  broadcast({ type: 'wa_status', status: s });
}
function hasSession() { return fs.existsSync(path.join(AUTH_DIR, 'creds.json')); }
function wipeAuth() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { log('ERR', e.message); }
}
function killSock() {
  if (sock) {
    try { sock.ev.removeAllListeners('connection.update'); } catch (e) { /* abaikan */ }
    try { sock.end(undefined); } catch (e) { /* abaikan */ }
    sock = null;
  }
}

async function requestPairing(s, phone) {
  var num = normalize(phone);
  if (!num) { broadcast({ type: 'pairing_error', message: 'Nomor tidak valid' }); return; }
  await sleep(2000);
  for (var i = 1; i <= 3; i++) {
    try {
      var code = await s.requestPairingCode(num);
      log('WA', 'Pairing code: ' + code);
      broadcast({ type: 'pairing_code', code: code });
      return;
    } catch (e) {
      log('ERR', 'Pairing try ' + i + ': ' + e.message);
      if (i === 3) broadcast({ type: 'pairing_error', message: 'Gagal minta kode: ' + e.message });
      else await sleep(2000);
    }
  }
}

function restartWA() {
  if (aborted) return;
  startWA(currentMode, pairingPhone).catch(function (e) { log('ERR', 'restart: ' + e.message); });
}

async function startWA(mode, phone) {
  aborted = false;
  killSock();
  currentMode = mode;
  pairingPhone = phone || null;
  log('WA', 'Connect method=' + mode);
  setStatus('connecting');
  var st = await useMultiFileAuthState(AUTH_DIR);
  var ver = null;
  try { ver = await fetchLatestBaileysVersion(); } catch (e) { ver = null; }
  var opts = {
    auth: st.state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    printQRInTerminal: false
  };
  if (ver && ver.version) opts.version = ver.version;
  var s = makeWASocket(opts);
  sock = s;
  var pairingRequested = false;
  s.ev.on('creds.update', st.saveCreds);
  s.ev.on('connection.update', async function (u) {
    if (aborted || sock !== s) return;
    try {
      if (u.connection === 'connecting' && mode === 'pairing' && !pairingRequested && !s.authState.creds.registered) {
        pairingRequested = true;
        requestPairing(s, phone);
      }
      if (u.qr && mode === 'qr') {
        var img = await QRCode.toDataURL(u.qr);
        broadcast({ type: 'qr', qr: img });
        setStatus('waiting_qr');
      }
      if (u.connection === 'open') {
        log('WA', 'CONNECTED');
        broadcast({ type: 'qr_clear' });
        setStatus('connected');
      }
      if (u.connection === 'close') {
        var err = u.lastDisconnect && u.lastDisconnect.error;
        var code = err && err.output ? err.output.statusCode : 0;
        log('WA', 'Close code: ' + code);
        broadcast({ type: 'qr_clear' });
        if (code === 401) {
          killSock();
          wipeAuth();
          setStatus('logged_out');
        } else if (code === 515) {
          setStatus('restarting');
          setTimeout(restartWA, 3000);
        } else if (code === 428) {
          setStatus('connecting');
          setTimeout(restartWA, 3000);
        } else {
          setStatus('disconnected');
          setTimeout(restartWA, 3000);
        }
      }
    } catch (e) { log('ERR', 'conn.update: ' + e.message); }
  });
}

async function sendText(no, text) {
  if (!sock || waStatus !== 'connected') throw new Error('WhatsApp belum terhubung');
  await sock.sendMessage(no + '@s.whatsapp.net', { text: text });
}

function updateContact(id, ok) {
  var d = loadData();
  var n = d.nasabah.find(function (x) { return x.id === id; });
  if (!n) return;
  if (ok) { n.status = 'Sudah'; n.last_followup = now(); n.send_error = null; }
  else n.send_error = 'FAILED';
  n.updated_at = now();
  saveData(d);
}

// ===================== BLAST =====================
var stopFlag = false;
var progress = { total: 0, current: 0, success: 0, failed: 0, percent: 0, currentNama: '', currentNoHp: '', logs: [], running: false };

function addLog(s) {
  progress.logs.unshift(s);
  if (progress.logs.length > 200) progress.logs.pop();
}
async function waitStop(ms) {
  var t = 0;
  while (t < ms && !stopFlag) { await sleep(500); t += 500; }
}

async function runBlast() {
  var d = loadData();
  var list = d.nasabah.filter(function (x) { return x.status === 'Belum'; });
  var tpl = loadTemplate().text;
  stopFlag = false;
  progress = { total: list.length, current: 0, success: 0, failed: 0, percent: 0, currentNama: '', currentNoHp: '', logs: [], running: true };
  log('BLAST', 'Start total=' + list.length);
  broadcast({ type: 'send_progress', progress: progress });
  for (var i = 0; i < list.length; i++) {
    if (stopFlag) break;
    var n = list[i];
    progress.currentNama = n.nama;
    progress.currentNoHp = n.no_hp;
    broadcast({ type: 'send_progress', progress: progress });
    try {
      await sendText(n.no_hp, buildMessage(tpl, n));
      progress.success++;
      updateContact(n.id, true);
      addLog('OK ' + n.no_hp);
    } catch (e) {
      progress.failed++;
      updateContact(n.id, false);
      addLog('ERR ' + n.no_hp + ' ' + e.message);
      log('ERR', 'send ' + n.no_hp + ': ' + e.message);
    }
    progress.current = i + 1;
    progress.percent = Math.round((progress.current / progress.total) * 100);
    broadcast({ type: 'send_progress', progress: progress });
    if (i < list.length - 1 && !stopFlag) await waitStop(3000 + Math.floor(Math.random() * 5001));
  }
  progress.running = false;
  progress.currentNama = '';
  progress.currentNoHp = '';
  log('BLAST', 'Done. OK=' + progress.success + ' FAIL=' + progress.failed);
  broadcast({ type: 'send_complete', progress: progress });
}

// ===================== EXPRESS =====================
function h(fn) {
  return async function (req, res) {
    try { await fn(req, res); }
    catch (e) {
      log('ERR', req.method + ' ' + req.originalUrl + ': ' + e.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    }
  };
}

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', h(function (req, res) {
  var b = req.body || {};
  var okUser = String(b.username || '') === ADMIN_USER;
  var okPass = bcrypt.compareSync(String(b.password || ''), ADMIN_HASH);
  if (!okUser || !okPass) return res.status(401).json({ ok: false, error: 'Username atau password salah' });
  var token = jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('token', token, { httpOnly: false, maxAge: 86400000 });
  res.json({ ok: true, token: token });
}));

app.use('/api', function (req, res, next) {
  var p = verifyToken(getToken(req));
  if (!p) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  req.user = p.user;
  next();
});

app.post('/api/logout', h(function (req, res) {
  res.clearCookie('token');
  res.json({ ok: true });
}));
app.get('/api/me', h(function (req, res) {
  res.json({ ok: true, user: req.user });
}));

// ----- Nomor -----
app.get('/api/nasabah', h(function (req, res) {
  res.json({ ok: true, nasabah: loadData().nasabah });
}));

app.post('/api/nasabah/bulk', h(function (req, res) {
  var raw = String((req.body && req.body.raw) || '');
  var parts = raw.split(/[\s,;]+/).filter(Boolean);
  var d = loadData();
  var exist = {};
  d.nasabah.forEach(function (x) { exist[x.no_hp] = true; });
  var inserted = 0, skipped = 0, invalid = 0;
  parts.forEach(function (p) {
    var no = normalize(p);
    if (!no) { invalid++; return; }
    if (exist[no]) { skipped++; return; }
    var t = now();
    d.nasabah.push({ id: d.nextId, nama: 'Kontak ' + d.nextId, no_hp: no, status: 'Belum', last_followup: null, send_error: null, created_at: t, updated_at: t });
    d.nextId++;
    exist[no] = true;
    inserted++;
  });
  saveData(d);
  res.json({ ok: true, inserted: inserted, skipped: skipped, invalid: invalid });
}));

app.post('/api/nasabah', h(function (req, res) {
  var b = req.body || {};
  var no = normalize(b.no_hp);
  if (!no) return res.status(400).json({ ok: false, error: 'Nomor tidak valid' });
  var d = loadData();
  if (d.nasabah.some(function (x) { return x.no_hp === no; })) return res.status(409).json({ ok: false, error: 'Nomor sudah ada' });
  var t = now();
  var n = { id: d.nextId, nama: clean(b.nama) || ('Kontak ' + d.nextId), no_hp: no, status: 'Belum', last_followup: null, send_error: null, created_at: t, updated_at: t };
  d.nextId++;
  d.nasabah.push(n);
  saveData(d);
  res.json({ ok: true, nasabah: n });
}));

app.put('/api/nasabah/:id', h(function (req, res) {
  var d = loadData();
  var id = parseInt(req.params.id, 10);
  var n = d.nasabah.find(function (x) { return x.id === id; });
  if (!n) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
  var b = req.body || {};
  if (b.nama !== undefined) n.nama = clean(b.nama) || n.nama;
  if (b.no_hp !== undefined) {
    var no = normalize(b.no_hp);
    if (!no) return res.status(400).json({ ok: false, error: 'Nomor tidak valid' });
    if (d.nasabah.some(function (x) { return x.id !== id && x.no_hp === no; })) return res.status(409).json({ ok: false, error: 'Nomor sudah ada' });
    n.no_hp = no;
  }
  if (b.status === 'Belum' || b.status === 'Sudah') {
    n.status = b.status;
    if (b.status === 'Belum') n.send_error = null;
  }
  n.updated_at = now();
  saveData(d);
  res.json({ ok: true, nasabah: n });
}));

app.delete('/api/nasabah/:id', h(function (req, res) {
  var d = loadData();
  var id = parseInt(req.params.id, 10);
  d.nasabah = d.nasabah.filter(function (x) { return x.id !== id; });
  saveData(d);
  res.json({ ok: true });
}));

app.delete('/api/nasabah', h(function (req, res) {
  var d = loadData();
  d.nasabah = [];
  saveData(d);
  res.json({ ok: true });
}));

// ----- Template -----
app.get('/api/template', h(function (req, res) {
  res.json({ ok: true, template: loadTemplate() });
}));
app.post('/api/template', h(function (req, res) {
  var text = clean((req.body && req.body.text) || '');
  if (!text) return res.status(400).json({ ok: false, error: 'Template kosong' });
  var t = { text: text };
  writeJson(TPL_FILE, t);
  res.json({ ok: true, template: t });
}));

// ----- WhatsApp -----
app.get('/api/wa/status', h(function (req, res) {
  res.json({ ok: true, status: waStatus, hasSession: hasSession(), progress: progress });
}));
app.post('/api/wa/connect-qr', h(async function (req, res) {
  await startWA('qr', null);
  res.json({ ok: true });
}));
app.post('/api/wa/connect-pairing', h(async function (req, res) {
  var no = normalize(req.body && req.body.phone);
  if (!no) return res.status(400).json({ ok: false, error: 'Nomor tidak valid' });
  await startWA('pairing', no);
  res.json({ ok: true });
}));
app.post('/api/wa/disconnect', h(function (req, res) {
  aborted = true;
  killSock();
  broadcast({ type: 'qr_clear' });
  setStatus('disconnected');
  res.json({ ok: true });
}));
app.post('/api/wa/logout', h(async function (req, res) {
  aborted = true;
  if (sock) { try { await sock.logout(); } catch (e) { /* abaikan */ } }
  killSock();
  wipeAuth();
  broadcast({ type: 'qr_clear' });
  setStatus('logged_out');
  res.json({ ok: true });
}));

// ----- Blast -----
app.post('/api/blast/start', h(function (req, res) {
  if (progress.running) return res.status(400).json({ ok: false, error: 'Blast sedang berjalan' });
  if (!sock || waStatus !== 'connected') return res.status(400).json({ ok: false, error: 'WhatsApp belum terhubung' });
  runBlast().catch(function (e) {
    log('ERR', 'blast: ' + e.message);
    progress.running = false;
    broadcast({ type: 'send_complete', progress: progress });
  });
  res.json({ ok: true });
}));
app.post('/api/blast/stop', h(function (req, res) {
  stopFlag = true;
  res.json({ ok: true });
}));
app.post('/api/send/:id', h(async function (req, res) {
  var d = loadData();
  var id = parseInt(req.params.id, 10);
  var n = d.nasabah.find(function (x) { return x.id === id; });
  if (!n) return res.status(404).json({ ok: false, error: 'Tidak ditemukan' });
  try {
    await sendText(n.no_hp, buildMessage(loadTemplate().text, n));
    updateContact(id, true);
    log('BLAST', 'Manual OK ' + n.no_hp);
    res.json({ ok: true });
  } catch (e) {
    updateContact(id, false);
    log('ERR', 'manual ' + n.no_hp + ': ' + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}));

server.listen(PORT, '127.0.0.1', function () {
  log('SERVER', 'Listening on http://127.0.0.1:' + PORT);
  if (hasSession()) {
    startWA('qr', null).catch(function (e) { log('ERR', 'autostart: ' + e.message); });
  }
});