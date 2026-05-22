require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
//  VERİTABANI KURULUMU
// ================================================================
const db = new sqlite3.Database('stok.db');

const run = (sql, params=[]) => new Promise((res,rej) => db.run(sql, params, function(e){ if(e) rej(e); else res(this); }));
const get = (sql, params=[]) => new Promise((res,rej) => db.get(sql, params, (e,r) => e ? rej(e) : res(r)));
const all = (sql, params=[]) => new Promise((res,rej) => db.all(sql, params, (e,r) => e ? rej(e) : res(r||[])));

async function initDB() {
  await run(`CREATE TABLE IF NOT EXISTS firms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    supplier_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    last_sync TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS depot_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    color TEXT NOT NULL,
    size TEXT NOT NULL,
    stock INTEGER DEFAULT 0,
    UNIQUE(model, color, size)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_id INTEGER NOT NULL,
    firm_name TEXT NOT NULL,
    barcode TEXT NOT NULL,
    product_title TEXT,
    depot_model TEXT NOT NULL,
    depot_color TEXT NOT NULL,
    depot_size TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firm_id, barcode)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_name TEXT,
    barcode TEXT,
    action TEXT,
    old_stock INTEGER,
    new_stock INTEGER,
    message TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS manual_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    depot_model TEXT NOT NULL,
    depot_color TEXT NOT NULL,
    depot_size TEXT NOT NULL,
    adjustment_type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_name TEXT NOT NULL,
    order_number TEXT NOT NULL,
    barcode TEXT NOT NULL,
    depot_model TEXT,
    depot_color TEXT,
    depot_size TEXT,
    qty INTEGER DEFAULT 1,
    status TEXT DEFAULT 'Created',
    order_date TEXT,
    processed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(firm_name, order_number, barcode)
  )`);
  console.log('Veritabanı hazır');
  await loadFirmsFromEnv();
}

async function loadFirmsFromEnv() {
  for (let i = 1; i <= 4; i++) {
    const name = process.env[`FIRM${i}_NAME`];
    const supplier_id = process.env[`FIRM${i}_SUPPLIER_ID`];
    const api_key = process.env[`FIRM${i}_API_KEY`];
    const api_secret = process.env[`FIRM${i}_API_SECRET`];
    if (name && supplier_id && api_key && api_secret) {
      try {
        await run(`INSERT OR IGNORE INTO firms (name, supplier_id, api_key, api_secret) VALUES (?, ?, ?, ?)`, [name, supplier_id, api_key, api_secret]);
      } catch(e) {}
    }
  }
}

// ================================================================
//  TRENDYOL API
// ================================================================
const BASE_URL = 'https://api.trendyol.com/sapigw/suppliers';

function trendyolHeaders(apiKey, apiSecret, supplierId) {
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `${supplierId} - SelfIntegration`
  };
}

async function fetchFirmProducts(firm) {
  const products = [];
  let page = 0;
  const size = 200;
  try {
    while (true) {
      const url = `${BASE_URL}/${firm.supplier_id}/products?page=${page}&size=${size}&approved=true`;
      const res = await axios.get(url, {
        headers: trendyolHeaders(firm.api_key, firm.api_secret, firm.supplier_id),
        timeout: 15000,
        validateStatus: () => true
      });
      if (res.status !== 200) {
        console.error(`[${firm.name}] Ürün çekme hatası: ${res.status} - ${JSON.stringify(res.data).substring(0,200)}`);
        break;
      }
      const content = res.data?.content || [];
      if (content.length === 0) break;
      for (const p of content) {
        for (const v of (p.variants || [])) {
          products.push({ barcode: v.barcode, title: p.title, stock: v.quantity || 0 });
        }
      }
      if (content.length < size) break;
      page++;
    }
  } catch (e) {
    console.error(`[${firm.name}] Ürün çekme hatası:`, e.message);
  }
  return products;
}

async function fetchNewOrders(firm) {
  try {
    const now = Date.now();
    const from = now - (10 * 60 * 1000);
    const url = `${BASE_URL}/${firm.supplier_id}/orders?status=Created&orderByField=PackageLastModifiedDate&orderByDirection=DESC&startDate=${from}&endDate=${now}&size=200`;
    const res = await axios.get(url, {
      headers: trendyolHeaders(firm.api_key, firm.api_secret, firm.supplier_id),
      timeout: 15000,
      validateStatus: () => true
    });
    if (res.status !== 200) {
      console.error(`[${firm.name}] Sipariş çekme hatası: ${res.status}`);
      return [];
    }
    return res.data?.content || [];
  } catch (e) {
    console.error(`[${firm.name}] Sipariş çekme hatası:`, e.message);
    return [];
  }
}

async function updateTrendyolStock(firm, barcode, qty) {
  try {
    const url = `${BASE_URL}/${firm.supplier_id}/products/price-and-inventory`;
    await axios.post(url, { items: [{ barcode, quantity: Math.max(0, qty) }] }, {
      headers: trendyolHeaders(firm.api_key, firm.api_secret, firm.supplier_id),
      timeout: 15000
    });
    return true;
  } catch (e) {
    console.error(`[${firm.name}] Stok güncelleme hatası (${barcode}):`, e.message);
    return false;
  }
}

// ================================================================
//  SENKRONIZASYON
// ================================================================
let isSyncing = false;

async function syncStockToAllFirms(model, color, size, newStock, note='') {
  const firms = await all('SELECT * FROM firms WHERE active=1');
  for (const firm of firms) {
    const maps = await all('SELECT * FROM mappings WHERE firm_id=? AND depot_model=? AND depot_color=? AND depot_size=? AND active=1', [firm.id, model, color, size]);
    for (const m of maps) {
      const success = await updateTrendyolStock(firm, m.barcode, newStock);
      await run('INSERT INTO sync_log (firm_name, barcode, action, new_stock, message, success) VALUES (?, ?, ?, ?, ?, ?)',
        [firm.name, m.barcode, 'sync', newStock, note, success ? 1 : 0]);
    }
  }
}

async function runSync() {
  if (isSyncing) return;
  isSyncing = true;
  console.log(`[SYNC] Başladı — ${new Date().toLocaleString('tr-TR')}`);
  const firms = await all('SELECT * FROM firms WHERE active=1');
  for (const firm of firms) {
    try {
      const orders = await fetchNewOrders(firm);
      for (const order of orders) {
        for (const line of (order.lines || [])) {
          const barcode = line.barcode;
          const qty = line.quantity || 1;
          const orderNumber = String(order.orderNumber || order.id);
          const exists = await get('SELECT id FROM orders WHERE firm_name=? AND order_number=? AND barcode=?', [firm.name, orderNumber, barcode]);
          if (exists) continue;
          const mapping = await get('SELECT * FROM mappings WHERE firm_id=? AND barcode=? AND active=1', [firm.id, barcode]);
          await run(`INSERT OR IGNORE INTO orders (firm_name, order_number, barcode, depot_model, depot_color, depot_size, qty, status, order_date, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [firm.name, orderNumber, barcode, mapping?.depot_model||null, mapping?.depot_color||null, mapping?.depot_size||null, qty, order.status||'Created', order.orderDate||new Date().toISOString(), mapping ? 0 : -1]);
          if (!mapping) { console.log(`[${firm.name}] Eşleştirme yok: ${barcode}`); continue; }
          const depot = await get('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?', [mapping.depot_model, mapping.depot_color, mapping.depot_size]);
          if (!depot) continue;
          const newStock = Math.max(0, depot.stock - qty);
          await run('UPDATE depot_products SET stock=? WHERE model=? AND color=? AND size=?', [newStock, mapping.depot_model, mapping.depot_color, mapping.depot_size]);
          await syncStockToAllFirms(mapping.depot_model, mapping.depot_color, mapping.depot_size, newStock, `Sipariş: ${orderNumber}`);
          await run('UPDATE orders SET processed=1 WHERE firm_name=? AND order_number=? AND barcode=?', [firm.name, orderNumber, barcode]);
          console.log(`[${firm.name}] Sipariş işlendi: ${barcode} — Yeni stok: ${newStock}`);
        }
      }
      await run('UPDATE firms SET last_sync=? WHERE id=?', [new Date().toISOString(), firm.id]);
    } catch (e) {
      console.error(`[${firm.name}] Sync hatası:`, e.message);
    }
  }
  isSyncing = false;
  console.log(`[SYNC] Tamamlandı — ${new Date().toLocaleString('tr-TR')}`);
}

// ================================================================
//  CRON
// ================================================================
const interval = process.env.SYNC_INTERVAL_MINUTES || 3;
cron.schedule(`*/${interval} * * * *`, runSync);
setTimeout(runSync, 30000);

// ================================================================
//  API ROUTES
// ================================================================

app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), syncing: isSyncing });
});

app.get('/api/firms', async (req, res) => {
  const firms = await all('SELECT id, name, supplier_id, active, last_sync FROM firms');
  res.json(firms);
});

app.post('/api/firms', async (req, res) => {
  const { name, supplier_id, api_key, api_secret } = req.body;
  if (!name || !supplier_id || !api_key || !api_secret) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    const r = await run('INSERT OR REPLACE INTO firms (name, supplier_id, api_key, api_secret) VALUES (?, ?, ?, ?)', [name, supplier_id, api_key, api_secret]);
    res.json({ id: r.lastID, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/firms/:id', async (req, res) => {
  const { name, supplier_id, api_key, api_secret, active } = req.body;
  const firm = await get('SELECT * FROM firms WHERE id=?', [req.params.id]);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  await run('UPDATE firms SET name=COALESCE(?,name), supplier_id=COALESCE(?,supplier_id), api_key=COALESCE(?,api_key), api_secret=COALESCE(?,api_secret), active=COALESCE(?,active) WHERE id=?',
    [name||null, supplier_id||null, api_key||null, api_secret||null, active??null, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/firms/:id/products', async (req, res) => {
  const firm = await get('SELECT * FROM firms WHERE id=?', [req.params.id]);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  const products = await fetchFirmProducts(firm);
  res.json(products);
});

app.get('/api/depot', async (req, res) => {
  const products = await all('SELECT * FROM depot_products ORDER BY model, color, size');
  res.json(products);
});

app.post('/api/depot', async (req, res) => {
  const { model, color, size, stock } = req.body;
  if (!model || !color || !size) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    await run('INSERT OR REPLACE INTO depot_products (model, color, size, stock) VALUES (?, ?, ?, ?)', [model, color, size, stock||0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/depot/adjust', async (req, res) => {
  const { model, color, size, type, qty, note } = req.body;
  const depot = await get('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?', [model, color, size]);
  if (!depot) return res.status(404).json({ error: 'Ürün bulunamadı' });
  let newStock;
  if (type === 'set') newStock = qty;
  else if (type === 'add') newStock = depot.stock + qty;
  else if (type === 'remove') newStock = Math.max(0, depot.stock - qty);
  else return res.status(400).json({ error: 'Geçersiz tip' });
  await run('UPDATE depot_products SET stock=? WHERE model=? AND color=? AND size=?', [newStock, model, color, size]);
  await run('INSERT INTO manual_adjustments (depot_model, depot_color, depot_size, adjustment_type, qty, note) VALUES (?, ?, ?, ?, ?, ?)', [model, color, size, type, qty, note||'']);
  await syncStockToAllFirms(model, color, size, newStock, note||'Manuel güncelleme');
  res.json({ ok: true, new_stock: newStock });
});

app.get('/api/mappings', async (req, res) => {
  const mappings = await all('SELECT m.*, f.name as firm_name FROM mappings m JOIN firms f ON m.firm_id=f.id ORDER BY m.firm_name, m.depot_model');
  res.json(mappings);
});

app.post('/api/mappings', async (req, res) => {
  const { firm_id, barcode, product_title, depot_model, depot_color, depot_size } = req.body;
  if (!firm_id || !barcode || !depot_model || !depot_color || !depot_size) return res.status(400).json({ error: 'Eksik bilgi' });
  const firm = await get('SELECT * FROM firms WHERE id=?', [firm_id]);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  try {
    await run('INSERT OR REPLACE INTO mappings (firm_id, firm_name, barcode, product_title, depot_model, depot_color, depot_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [firm_id, firm.name, barcode, product_title||'', depot_model, depot_color, depot_size]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mappings/:id', async (req, res) => {
  await run('UPDATE mappings SET active=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/logs', async (req, res) => {
  const logs = await all('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 200');
  res.json(logs);
});

app.post('/api/sync/run', async (req, res) => {
  res.json({ ok: true, message: 'Sync başlatıldı' });
  runSync();
});

app.get('/api/orders', async (req, res) => {
  const orders = await all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
  res.json(orders);
});

app.post('/api/sync/product', async (req, res) => {
  const { model, color, size } = req.body;
  const depot = await get('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?', [model, color, size]);
  if (!depot) return res.status(404).json({ error: 'Ürün bulunamadı' });
  await syncStockToAllFirms(model, color, size, depot.stock, 'Manuel ürün sync');
  res.json({ ok: true, synced_stock: depot.stock });
});

app.get('/api/stats', async (req, res) => {
  const totalDepot = await get('SELECT SUM(stock) as total FROM depot_products');
  const firmCount = await get('SELECT COUNT(*) as c FROM firms WHERE active=1');
  const mappingCount = await get('SELECT COUNT(*) as c FROM mappings WHERE active=1');
  const todayLogs = await get("SELECT COUNT(*) as c FROM sync_log WHERE date(created_at)=date('now')");
  const errorLogs = await get("SELECT COUNT(*) as c FROM sync_log WHERE success=0 AND date(created_at)=date('now')");
  const lastSync = await get('SELECT MAX(last_sync) as ls FROM firms');
  res.json({
    total_depot_stock: totalDepot?.total||0,
    active_firms: firmCount?.c||0,
    mappings: mappingCount?.c||0,
    syncs_today: todayLogs?.c||0,
    errors_today: errorLogs?.c||0,
    last_sync: lastSync?.ls||null
  });
});

// Test endpoint
app.post('/api/test-trendyol', async (req, res) => {
  const { supplier_id, api_key, api_secret } = req.body;
  if (!supplier_id || !api_key || !api_secret) return res.json({ error: 'Eksik bilgi' });
  try {
    const token = Buffer.from(`${api_key}:${api_secret}`).toString('base64');
    const url = `${BASE_URL}/${supplier_id}/products?page=0&size=1&approved=true`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': `${supplier_id} - SelfIntegration`
      },
      timeout: 15000,
      validateStatus: () => true
    });
    res.json({ status: response.status, statusText: response.statusText, data: typeof response.data === 'string' ? response.data.substring(0,500) : response.data });
  } catch (e) { res.json({ error: e.message }); }
});

// ================================================================
//  BAŞLAT
// ================================================================
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Trendyol Stok Senkron sistemi çalışıyor: port ${PORT}`);
    console.log(`📋 Panel: http://localhost:${PORT}`);
    console.log(`⏱  Sync aralığı: her ${interval} dakika`);
  });
});
