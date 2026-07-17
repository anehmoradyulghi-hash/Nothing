import express from 'express';
import crypto from 'crypto';
import db, {
  adjustBalance,
  listCardTopups, approveCardTopup, rejectCardTopup,
  adminListListings, adminListOrders, adminReleaseOrder, adminRefundOrder, adminSetListingStatus,
} from './db.js';
import { sendMessage } from './telegram.js';

const router = express.Router();

/* =========================================================================
   AUTH — simple password login, in-memory session tokens.
   For a single admin panel used by a small team this is enough; for a
   bigger team, swap this for real accounts + hashed passwords per admin.
   ========================================================================= */
const sessions = new Map(); // token -> expiryTimestamp
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiry = token && sessions.get(token);
  if (!expiry || expiry < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  sessions.set(token, Date.now() + TOKEN_TTL_MS); // sliding expiry
  next();
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_PANEL_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PANEL_PASSWORD تنظیم نشده' });
  }
  if (password !== process.env.ADMIN_PANEL_PASSWORD) {
    return res.status(401).json({ error: 'رمز عبور اشتباه است' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token });
});

router.post('/logout', requireAdminAuth, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

router.use(requireAdminAuth); // همه مسیرهای زیر نیاز به لاگین دارن

/* =========================================================================
   DASHBOARD / STATS
   ========================================================================= */
router.get('/stats', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const rialIn = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='in' AND currency='rial'`).get().s;
  const rialOut = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='out' AND currency='rial'`).get().s;
  const starsIn = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='in' AND currency='stars'`).get().s;
  const todayOrders = db.prepare(`SELECT COUNT(*) c FROM orders WHERE date(created_at) = date('now')`).get().c;
  const revenueByDay = db.prepare(`
    SELECT date(created_at) d, COALESCE(SUM(amount_rial),0) total
    FROM orders WHERE created_at >= datetime('now','-14 day')
    GROUP BY d ORDER BY d ASC
  `).all();
  const topProducts = db.prepare(`
    SELECT product_id, COUNT(*) sales, COALESCE(SUM(amount_rial),0) revenue
    FROM orders GROUP BY product_id ORDER BY revenue DESC LIMIT 5
  `).all();
  res.json({ users, orders, todayOrders, rialIn, rialOut, starsIn, revenueByDay, topProducts });
});

/* =========================================================================
   USERS
   ========================================================================= */
router.get('/users', (req, res) => {
  const { q = '', limit = 50, offset = 0 } = req.query;
  const rows = db.prepare(`
    SELECT * FROM users
    WHERE CAST(tg_id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(`%${q}%`, `%${q}%`, `%${q}%`, Number(limit), Number(offset));
  const total = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  res.json({ rows, total });
});

router.get('/users/:tgId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(req.params.tgId);
  if (!user) return res.status(404).json({ error: 'not found' });
  const orders = db.prepare('SELECT * FROM orders WHERE tg_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.tgId);
  const transactions = db.prepare('SELECT * FROM transactions WHERE tg_id = ? ORDER BY created_at DESC LIMIT 30').all(req.params.tgId);
  const referrals = db.prepare('SELECT tg_id, username, first_name, created_at FROM users WHERE referred_by = ?').all(req.params.tgId);
  res.json({ user, orders, transactions, referrals });
});

// شارژ یا کسر دستی موجودی (مثبت = شارژ، منفی = کسر)
router.post('/users/:tgId/adjust-balance', (req, res) => {
  const { currency, amount, reason } = req.body; // currency: 'rial' | 'stars'
  if (!['rial', 'stars'].includes(currency) || !Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'ورودی نامعتبر' });
  }
  const tgId = Number(req.params.tgId);
  adjustBalance(tgId, currency, amount, reason || 'اصلاح دستی توسط ادمین');
  const label = currency === 'stars' ? `${amount}⭐️` : `${amount.toLocaleString()} تومان`;
  sendMessage(tgId, `💰 موجودی شما ${amount > 0 ? 'افزایش' : 'کاهش'} یافت: ${label}\nدلیل: ${reason || 'اصلاح توسط پشتیبانی'}`).catch(() => {});
  res.json({ ok: true, user: db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) });
});

/* =========================================================================
   ORDERS
   ========================================================================= */
router.get('/orders', (req, res) => {
  const { status = '', limit = 50, offset = 0 } = req.query;
  const rows = status
    ? db.prepare(`SELECT o.*, u.username, u.first_name FROM orders o JOIN users u ON u.tg_id=o.tg_id WHERE o.status=? ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(status, Number(limit), Number(offset))
    : db.prepare(`SELECT o.*, u.username, u.first_name FROM orders o JOIN users u ON u.tg_id=o.tg_id ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(Number(limit), Number(offset));
  const total = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  res.json({ rows, total });
});

router.patch('/orders/:id', (req, res) => {
  const { status } = req.body; // pending | paid | delivered | failed
  if (!['pending', 'paid', 'delivered', 'failed'].includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (status === 'delivered') {
    sendMessage(order.tg_id, `📦 سفارش شما (#${order.id}) تحویل داده شد.`).catch(() => {});
  }
  res.json({ ok: true, order });
});

/* =========================================================================
   PRODUCTS
   ========================================================================= */
router.get('/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY category, name').all());
});

router.post('/products', (req, res) => {
  const { id, category, name, description, price_rial, image_url } = req.body;
  if (!id || !category || !name || !price_rial) return res.status(400).json({ error: 'فیلدهای ضروری خالی است' });
  db.prepare('INSERT INTO products (id, category, name, description, price_rial, image_url) VALUES (?,?,?,?,?,?)')
    .run(id, category, name, description || '', price_rial, image_url || null);
  res.json({ ok: true });
});

router.patch('/products/:id', (req, res) => {
  const { name, description, price_rial, category, active, image_url } = req.body;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE products SET name=?, description=?, price_rial=?, category=?, active=?, image_url=? WHERE id=?`)
    .run(name ?? p.name, description ?? p.description, price_rial ?? p.price_rial, category ?? p.category, active ?? p.active, image_url ?? p.image_url, req.params.id);
  res.json({ ok: true });
});

router.delete('/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* =========================================================================
   TRANSACTIONS
   ========================================================================= */
router.get('/transactions', (req, res) => {
  const { limit = 80, offset = 0 } = req.query;
  const rows = db.prepare(`
    SELECT t.*, u.username, u.first_name FROM transactions t
    JOIN users u ON u.tg_id = t.tg_id
    ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset));
  res.json(rows);
});

/* =========================================================================
   REFERRALS — top referrers by number of invites and commission paid
   ========================================================================= */
router.get('/referrals', (req, res) => {
  const rows = db.prepare(`
    SELECT u.tg_id, u.username, u.first_name,
      (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.tg_id) AS invited_count,
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.tg_id = u.tg_id AND t.reason LIKE 'پورسانت%'),0) AS commission_earned
    FROM users u
    WHERE invited_count > 0
    ORDER BY commission_earned DESC LIMIT 50
  `).all();
  res.json(rows);
});

/* =========================================================================
   TASKS — مدیریت تسک‌ها (اضافه/ویرایش/حذف) از پنل ادمین
   ========================================================================= */
router.get('/tasks', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM task_completions c WHERE c.task_id = t.id) AS completions
    FROM tasks t ORDER BY t.created_at DESC
  `).all();
  res.json(rows);
});
router.post('/tasks', (req, res) => {
  const { id, title, description, type, channel_username, link, reward_rial, reward_stars } = req.body;
  if (!id || !title || !type) return res.status(400).json({ error: 'فیلدهای ضروری خالی است' });
  db.prepare(`INSERT INTO tasks (id, title, description, type, channel_username, link, reward_rial, reward_stars) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, title, description || '', type, channel_username || null, link || null, reward_rial || 0, reward_stars || 0);
  res.json({ ok: true });
});
router.patch('/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  db.prepare(`UPDATE tasks SET title=?, description=?, type=?, channel_username=?, link=?, reward_rial=?, reward_stars=?, active=? WHERE id=?`)
    .run(b.title ?? t.title, b.description ?? t.description, b.type ?? t.type, b.channel_username ?? t.channel_username,
         b.link ?? t.link, b.reward_rial ?? t.reward_rial, b.reward_stars ?? t.reward_stars, b.active ?? t.active, req.params.id);
  res.json({ ok: true });
});
router.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* =========================================================================
   CARD-TO-CARD TOP-UPS — تایید/رد درخواست‌های شارژ کارت‌به‌کارت
   ========================================================================= */
router.get('/card-topups', (req, res) => {
  const { status = '' } = req.query;
  res.json(listCardTopups(status || null));
});
router.post('/card-topups/:id/approve', (req, res) => {
  try {
    const row = approveCardTopup(Number(req.params.id));
    sendMessage(row.tg_id, `✅ درخواست شارژ کارت‌به‌کارت شما تایید شد.\nمبلغ ${row.amount_rial.toLocaleString()} تومان به کیف‌پولت اضافه شد.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/card-topups/:id/reject', (req, res) => {
  try {
    const row = rejectCardTopup(Number(req.params.id), req.body?.note);
    sendMessage(row.tg_id, `❌ درخواست شارژ کارت‌به‌کارت شما رد شد.${req.body?.note ? `\nدلیل: ${req.body.note}` : ''}`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
   MARKETPLACE — نظارت بر آگهی‌ها و سفارش‌های مارکت گیفت (پی‌توپی)
   ========================================================================= */
router.get('/market/listings', (req, res) => res.json(adminListListings()));
router.patch('/market/listings/:id', (req, res) => {
  const { status } = req.body;
  if (!['active', 'reserved', 'sold', 'cancelled'].includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  adminSetListingStatus(Number(req.params.id), status);
  res.json({ ok: true });
});
router.get('/market/orders', (req, res) => res.json(adminListOrders()));
router.post('/market/orders/:id/release', (req, res) => {
  try {
    const order = adminReleaseOrder(Number(req.params.id));
    sendMessage(order.seller_tg_id, `✅ ادمین سفارش #${order.id} رو تایید کرد.\nمبلغ ${(order.price_rial - order.fee_rial).toLocaleString()} تومان به کیف‌پولت واریز شد.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/market/orders/:id/refund', (req, res) => {
  try {
    const order = adminRefundOrder(Number(req.params.id));
    sendMessage(order.buyer_tg_id, `↩️ سفارش #${order.id} توسط ادمین لغو شد و مبلغ ${order.price_rial.toLocaleString()} تومان به کیف‌پولت برگشت.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
