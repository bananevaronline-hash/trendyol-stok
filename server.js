require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
//  VERİTABANI KURULUMU
// ================================================================
const db = new Database('stok.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS firms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    supplier_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    last_sync TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS depot_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    color TEXT NOT NULL,
    size TEXT NOT NULL,
    stock INTEGER DEFAULT 0,
    UNIQUE(model, color, size)
  );

  CREATE TABLE IF NOT EXISTS mappings (
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
    UNIQUE(firm_id, barcode),
    FOREIGN KEY(firm_id) REFERENCES firms(id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firm_name TEXT,
    barcode TEXT,
    action TEXT,
    old_stock INTEGER,
    new_stock INTEGER,
    message TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS manual_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    depot_model TEXT NOT NULL,
    depot_color TEXT NOT NULL,
    depot_size TEXT NOT NULL,
    adjustment_type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
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
  );
`);

// .env'den firma bilgilerini yükle
function loadFirmsFromEnv() {
  for (let i = 1; i <= 4; i++) {
    const name = process.env[`FIRM${i}_NAME`];
    const supplier_id = process.env[`FIRM${i}_SUPPLIER_ID`];
    const api_key = process.env[`FIRM${i}_API_KEY`];
    const api_secret = process.env[`FIRM${i}_API_SECRET`];
    if (name && supplier_id && api_key && api_secret) {
      try {
        db.prepare(`INSERT OR IGNORE INTO firms (name, supplier_id, api_key, api_secret) VALUES (?, ?, ?, ?)`).run(name, supplier_id, api_key, api_secret);
      } catch(e) {}
    }
  }
}
loadFirmsFromEnv();

// ================================================================
//  TRENDYOL API HELPERs
// ================================================================
function trendyolHeaders(apiKey, apiSecret, supplierId) {
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `${supplierId} - SelfIntegration`
  };
}

const BASE_URL = 'https://api.trendyol.com/sapigw/suppliers';

// Firmanın ürünlerini çek (sayfalı)
async function fetchFirmProducts(firm) {
  const products = [];
  let page = 0;
  const size = 200;
  try {
    while (true) {
      const url = `${BASE_URL}/${firm.supplier_id}/products?page=${page}&size=${size}&approved=true`;
      const res = await axios.get(url, {
        headers: trendyolHeaders(firm.api_key, firm.api_secret, firm.supplier_id),
        timeout: 15000
      });
      const content = res.data?.content || [];
      if (content.length === 0) break;
      for (const p of content) {
        for (const v of (p.variants || [])) {
          products.push({
            barcode: v.barcode,
            title: p.title,
            stock: v.quantity || 0,
            product_main_id: p.productMainId
          });
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

// Firmanın son siparişlerini çek
async function fetchNewOrders(firm) {
  try {
    const now = Date.now();
    const from = now - (10 * 60 * 1000); // son 10 dakika
    const url = `${BASE_URL}/${firm.supplier_id}/orders?status=Created&orderByField=PackageLastModifiedDate&orderByDirection=DESC&startDate=${from}&endDate=${now}&size=200`;
    const res = await axios.get(url, {
      headers: trendyolHeaders(firm.api_key, firm.api_secret, firm.supplier_id),
      timeout: 15000
    });
    return res.data?.content || [];
  } catch (e) {
    console.error(`[${firm.name}] Sipariş çekme hatası:`, e.message);
    return [];
  }
}

// Trendyol'a stok güncelleme gönder
async function updateTrendyolStock(firm, barcode, qty) {
  try {
    const url = `${BASE_URL}/${firm.supplier_id}/products/price-and-inventory`;
    const payload = {
      items: [{
        barcode: barcode,
        quantity: Math.max(0, qty)
      }]
    };
    await axios.post(url, payload, {
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
//  ANA SENKRONIZASYON MOTORU
// ================================================================
let isSyncing = false;

async function runSync() {
  if (isSyncing) {
    console.log('[SYNC] Önceki sync hâlâ devam ediyor, atlanıyor...');
    return;
  }
  isSyncing = true;
  console.log(`[SYNC] Başladı — ${new Date().toLocaleString('tr-TR')}`);

  const firms = db.prepare('SELECT * FROM firms WHERE active = 1').all();

  for (const firm of firms) {
    try {
      // Siparişleri çek
      const orders = await fetchNewOrders(firm);

      for (const order of orders) {
        for (const line of (order.lines || [])) {
          const barcode = line.barcode;
          const qty = line.quantity || 1;
          const orderNumber = String(order.orderNumber || order.id);

          // Daha önce işlendi mi?
          const exists = db.prepare('SELECT id FROM orders WHERE firm_name=? AND order_number=? AND barcode=?').get(firm.name, orderNumber, barcode);
          if (exists) continue;

          // Eşleştirme var mı?
          const mapping = db.prepare('SELECT * FROM mappings WHERE firm_id=? AND barcode=? AND active=1').get(firm.id, barcode);

          db.prepare(`INSERT OR IGNORE INTO orders (firm_name, order_number, barcode, depot_model, depot_color, depot_size, qty, status, order_date, processed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            firm.name, orderNumber, barcode,
            mapping?.depot_model || null,
            mapping?.depot_color || null,
            mapping?.depot_size || null,
            qty, order.status || 'Created',
            order.orderDate || new Date().toISOString(),
            mapping ? 0 : -1 // -1 = eşleştirme yok
          );

          if (!mapping) {
            console.log(`[${firm.name}] Eşleştirme yok: ${barcode}`);
            continue;
          }

          // Depo stokunu düş
          const depot = db.prepare('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?').get(mapping.depot_model, mapping.depot_color, mapping.depot_size);
          if (!depot) continue;

          const newStock = Math.max(0, depot.stock - qty);
          db.prepare('UPDATE depot_products SET stock=? WHERE model=? AND color=? AND size=?').run(newStock, mapping.depot_model, mapping.depot_color, mapping.depot_size);

          // Tüm firmalara güncelle
          await syncStockToAllFirms(mapping.depot_model, mapping.depot_color, mapping.depot_size, newStock, firm.name, orderNumber);

          // Siparişi işlendi olarak işaretle
          db.prepare('UPDATE orders SET processed=1 WHERE firm_name=? AND order_number=? AND barcode=?').run(firm.name, orderNumber, barcode);

          console.log(`[${firm.name}] Sipariş işlendi: ${barcode} — Yeni stok: ${newStock}`);
        }
      }

      db.prepare('UPDATE firms SET last_sync=? WHERE id=?').run(new Date().toISOString(), firm.id);

    } catch (e) {
      console.error(`[${firm.name}] Sync hatası:`, e.message);
    }
  }

  isSyncing = false;
  console.log(`[SYNC] Tamamlandı — ${new Date().toLocaleString('tr-TR')}`);
}

// Tüm firmalara belirli bir ürünün stokunu güncelle
async function syncStockToAllFirms(model, color, size, newStock, skipFirmName = null, note = '') {
  const firms = db.prepare('SELECT * FROM firms WHERE active = 1').all();
  for (const firm of firms) {
    const mappings = db.prepare('SELECT * FROM mappings WHERE firm_id=? AND depot_model=? AND depot_color=? AND depot_size=? AND active=1').all(firm.id, model, color, size);
    for (const m of mappings) {
      const success = await updateTrendyolStock(firm, m.barcode, newStock);
      db.prepare('INSERT INTO sync_log (firm_name, barcode, action, new_stock, message, success) VALUES (?, ?, ?, ?, ?, ?)').run(
        firm.name, m.barcode, skipFirmName ? 'order_sync' : 'manual_sync', newStock,
        skipFirmName ? `Sipariş: ${note}` : note, success ? 1 : 0
      );
    }
  }
}

// ================================================================
//  CRON — Her 3 dakikada çalış
// ================================================================
const interval = process.env.SYNC_INTERVAL_MINUTES || 3;
cron.schedule(`*/${interval} * * * *`, runSync);

// İlk çalıştırma (30 saniye sonra)
setTimeout(runSync, 30000);

// ================================================================
//  API ROUTES
// ================================================================

// Sağlık kontrolü
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), syncing: isSyncing });
});

// Firmalar
app.get('/api/firms', (req, res) => {
  const firms = db.prepare('SELECT id, name, supplier_id, active, last_sync FROM firms').all();
  res.json(firms);
});

app.post('/api/firms', (req, res) => {
  const { name, supplier_id, api_key, api_secret } = req.body;
  if (!name || !supplier_id || !api_key || !api_secret) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    const r = db.prepare('INSERT OR REPLACE INTO firms (name, supplier_id, api_key, api_secret) VALUES (?, ?, ?, ?)').run(name, supplier_id, api_key, api_secret);
    res.json({ id: r.lastInsertRowid, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/firms/:id', (req, res) => {
  const { name, supplier_id, api_key, api_secret, active } = req.body;
  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.params.id);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  db.prepare('UPDATE firms SET name=COALESCE(?,name), supplier_id=COALESCE(?,supplier_id), api_key=COALESCE(?,api_key), api_secret=COALESCE(?,api_secret), active=COALESCE(?,active) WHERE id=?')
    .run(name, supplier_id, api_key, api_secret, active, req.params.id);
  res.json({ ok: true });
});

// Firma ürünlerini Trendyol'dan çek
app.get('/api/firms/:id/products', async (req, res) => {
  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(req.params.id);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  const products = await fetchFirmProducts(firm);
  res.json(products);
});

// Depo ürünleri
app.get('/api/depot', (req, res) => {
  const products = db.prepare('SELECT * FROM depot_products ORDER BY model, color, size').all();
  res.json(products);
});

app.post('/api/depot', (req, res) => {
  const { model, color, size, stock } = req.body;
  if (!model || !color || !size) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    db.prepare('INSERT OR REPLACE INTO depot_products (model, color, size, stock) VALUES (?, ?, ?, ?)').run(model, color, size, stock || 0);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toplu depo ürünü ekle (panelden import)
app.post('/api/depot/bulk', (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ error: 'Geçersiz veri' });
  const insert = db.prepare('INSERT OR REPLACE INTO depot_products (model, color, size, stock) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((items) => { for (const p of items) insert.run(p.model, p.color, p.size, p.stock || 0); });
  tx(products);
  res.json({ ok: true, count: products.length });
});

// Manuel stok ayarı (iade / yeni mal)
app.post('/api/depot/adjust', async (req, res) => {
  const { model, color, size, type, qty, note } = req.body;
  // type: 'add' (iade/yeni mal) veya 'set' (manuel set)
  const depot = db.prepare('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?').get(model, color, size);
  if (!depot) return res.status(404).json({ error: 'Ürün bulunamadı' });

  let newStock;
  if (type === 'set') newStock = qty;
  else if (type === 'add') newStock = depot.stock + qty;
  else if (type === 'remove') newStock = Math.max(0, depot.stock - qty);
  else return res.status(400).json({ error: 'Geçersiz tip' });

  db.prepare('UPDATE depot_products SET stock=? WHERE model=? AND color=? AND size=?').run(newStock, model, color, size);
  db.prepare('INSERT INTO manual_adjustments (depot_model, depot_color, depot_size, adjustment_type, qty, note) VALUES (?, ?, ?, ?, ?, ?)').run(model, color, size, type, qty, note || '');

  // Tüm firmalara güncelle
  await syncStockToAllFirms(model, color, size, newStock, null, note || 'Manuel güncelleme');

  res.json({ ok: true, new_stock: newStock });
});

// Eşleştirmeler
app.get('/api/mappings', (req, res) => {
  const mappings = db.prepare('SELECT m.*, f.name as firm_name FROM mappings m JOIN firms f ON m.firm_id=f.id ORDER BY m.firm_name, m.depot_model').all();
  res.json(mappings);
});

app.post('/api/mappings', (req, res) => {
  const { firm_id, barcode, product_title, depot_model, depot_color, depot_size } = req.body;
  if (!firm_id || !barcode || !depot_model || !depot_color || !depot_size) return res.status(400).json({ error: 'Eksik bilgi' });
  const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(firm_id);
  if (!firm) return res.status(404).json({ error: 'Firma bulunamadı' });
  try {
    db.prepare('INSERT OR REPLACE INTO mappings (firm_id, firm_name, barcode, product_title, depot_model, depot_color, depot_size) VALUES (?, ?, ?, ?, ?, ?, ?)').run(firm_id, firm.name, barcode, product_title || '', depot_model, depot_color, depot_size);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/mappings/:id', (req, res) => {
  db.prepare('UPDATE mappings SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Sync log
app.get('/api/logs', (req, res) => {
  const logs = db.prepare('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(logs);
});

// Manuel sync tetikle
app.post('/api/sync/run', async (req, res) => {
  res.json({ ok: true, message: 'Sync başlatıldı' });
  runSync();
});

// Siparişler
app.get('/api/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
  res.json(orders);
});

// Tüm firmalara belirli ürünün stokunu zorla güncelle
app.post('/api/sync/product', async (req, res) => {
  const { model, color, size } = req.body;
  const depot = db.prepare('SELECT * FROM depot_products WHERE model=? AND color=? AND size=?').get(model, color, size);
  if (!depot) return res.status(404).json({ error: 'Ürün bulunamadı' });
  await syncStockToAllFirms(model, color, size, depot.stock, null, 'Manuel ürün sync');
  res.json({ ok: true, synced_stock: depot.stock });
});

// Özet istatistikler
app.get('/api/stats', (req, res) => {
  const totalDepot = db.prepare('SELECT SUM(stock) as total FROM depot_products').get();
  const firmCount = db.prepare('SELECT COUNT(*) as c FROM firms WHERE active=1').get();
  const mappingCount = db.prepare('SELECT COUNT(*) as c FROM mappings WHERE active=1').get();
  const todayLogs = db.prepare("SELECT COUNT(*) as c FROM sync_log WHERE date(created_at)=date('now')").get();
  const errorLogs = db.prepare("SELECT COUNT(*) as c FROM sync_log WHERE success=0 AND date(created_at)=date('now')").get();
  const lastSync = db.prepare('SELECT MAX(last_sync) as ls FROM firms').get();
  res.json({
    total_depot_stock: totalDepot?.total || 0,
    active_firms: firmCount?.c || 0,
    mappings: mappingCount?.c || 0,
    syncs_today: todayLogs?.c || 0,
    errors_today: errorLogs?.c || 0,
    last_sync: lastSync?.ls || null
  });
});

// ================================================================
//  SUNUCU BAŞLAT
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Trendyol Stok Senkron sistemi çalışıyor: port ${PORT}`);
  console.log(`📋 Panel: http://localhost:${PORT}`);
  console.log(`⏱  Sync aralığı: her ${interval} dakika`);
});
