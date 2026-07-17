import 'dotenv/config';
import express from 'express';
import {
  sendMessage, answerPreCheckoutQuery, answerCallbackQuery, createStarsInvoiceLink,
  setWebhook, validateInitData, isChannelMember,
} from './telegram.js';
import { requestPayment, verifyPayment } from './gateway.js';
import db, {
  getOrCreateUser, getUser, adjustBalance, payReferralCommission,
  createOrder, getProduct,
  settleStake, pendingStakeReward, stakeDeposit, stakeWithdraw,
  listActiveTasks, isTaskDone, completeTask,
  createCardTopup,
  createListing, listActiveListings, myListings, cancelListing, buyListing,
  myPurchases, mySales, confirmOrderReceipt, disputeOrder,
} from './db.js';
import adminRouter from './admin.js';

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('✅ starkadeh backend is running'));

// لینک‌های عمومی کانال/چت که مینی‌اپ برای دکمه‌های صفحه بازی‌ها ازش استفاده می‌کنه
app.get('/api/config', (req, res) => {
  res.json({
    channel: process.env.REQUIRED_CHANNEL || process.env.COMMUNITY_CHANNEL || null,
    chat: process.env.COMMUNITY_CHAT || null,
  });
});

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const isAdmin = (id) => ADMIN_IDS.includes(Number(id));

/* =========================================================================
   MIDDLEWARE: every /api/* call from the Mini App must carry a valid
   Telegram initData string in the "X-Init-Data" header. This is how we
   know WHO is calling us without any separate login system.
   ========================================================================= */
async function requireTelegramAuth(req, res, next) {
  const initData = req.headers['x-init-data'];
  if (!initData) return res.status(401).json({ error: 'no init data' });
  const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'invalid init data' });

  const params = new URLSearchParams(initData);
  const startParam = params.get('start_param'); // carries ref_XXXXX if opened via referral link
  req.dbUser = getOrCreateUser(tgUser, startParam);

  // جوین اجباری کانال (اگه تو Variables تنظیم شده باشه)
  if (process.env.REQUIRED_CHANNEL) {
    const joined = await isChannelMember(process.env.REQUIRED_CHANNEL, tgUser.id);
    if (!joined) {
      return res.status(403).json({ error: 'join_required', channel: process.env.REQUIRED_CHANNEL });
    }
  }
  next();
}

/* =========================================================================
   MINI APP API
   ========================================================================= */

// current user + balances
app.get('/api/me', requireTelegramAuth, (req, res) => {
  res.json({
    tg_id: req.dbUser.tg_id,
    username: req.dbUser.username,
    first_name: req.dbUser.first_name,
    balance_rial: req.dbUser.balance_rial,
    balance_stars: req.dbUser.balance_stars,
    ref_code: req.dbUser.ref_code,
  });
});

// product catalog
app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1').all();
  res.json(rows);
});

// helper: validate a cart items array against the real DB prices (never trust client prices)
function priceCart(items) {
  let total = 0;
  const resolved = [];
  for (const { productId, qty } of items) {
    const product = getProduct(productId);
    if (!product) throw new Error('product not found: ' + productId);
    const q = Math.max(1, Number(qty) || 1);
    total += product.price_rial * q;
    resolved.push({ product, qty: q });
  }
  return { total, resolved };
}

// checkout: pay with wallet balance (rial) — items: [{productId, qty}], note: آیدی گیرنده/اکانت مقصد
app.post('/api/checkout/wallet', requireTelegramAuth, (req, res) => {
  const { items, note } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'سبد خرید خالی است' });

  let total, resolved;
  try { ({ total, resolved } = priceCart(items)); }
  catch (e) { return res.status(404).json({ error: e.message }); }

  const user = getUser(req.dbUser.tg_id);
  if (user.balance_rial < total) return res.status(400).json({ error: 'موجودی کیف‌پول کافی نیست' });

  adjustBalance(user.tg_id, 'rial', -total, 'خرید از فروشگاه (کیف‌پول)');
  resolved.forEach(({ product, qty }) => {
    createOrder(user.tg_id, product.id, qty, product.price_rial * qty, 'wallet', note || null);
  });
  payReferralCommission(user.tg_id, total);

  sendMessage(user.tg_id, `✅ سفارش شما ثبت شد.\nمبلغ: ${total.toLocaleString()} تومان${note ? `\nمقصد: ${note}` : ''}`).catch(() => {});
  res.json({ ok: true, total });
});

// checkout: pay with Telegram Stars -> returns an invoice link, Mini App opens it with Telegram.WebApp.openInvoice()
app.post('/api/checkout/stars-invoice', requireTelegramAuth, async (req, res) => {
  const { items, note } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'سبد خرید خالی است' });

  let resolved;
  try { ({ resolved } = priceCart(items)); }
  catch (e) { return res.status(404).json({ error: e.message }); }

  const RIAL_PER_STAR = 385; // نرخ تبدیل داخلی خودتان - قابل تنظیم

  // هر کالا یک خط قیمت جدا در فاکتور استارز می‌شود؛ تلگرام خودش جمع می‌زند
  const prices = resolved.map(({ product, qty }) => ({
    label: `${product.name} ×${qty}`,
    amount: Math.ceil((product.price_rial * qty) / RIAL_PER_STAR),
  }));
  const payload = JSON.stringify({
    tg_id: req.dbUser.tg_id,
    items: resolved.map(({ product, qty }) => ({ productId: product.id, qty })),
    note: note || null,
  });

  const link = await createStarsInvoiceLink({
    title: 'خرید از استارکده',
    description: resolved.map(({ product, qty }) => `${product.name} ×${qty}`).join('، '),
    payload,
    prices,
  });
  res.json({ invoiceLink: link, totalStars: prices.reduce((s, p) => s + p.amount, 0) });
});

// checkout / topup: pay with rial payment gateway -> returns redirect URL
app.post('/api/gateway/start', requireTelegramAuth, async (req, res) => {
  const { purpose, amountRial, items, note } = req.body; // purpose: "topup" | "order"
  let amount = amountRial;
  let purposeTag = 'topup';

  if (purpose === 'order') {
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'سبد خرید خالی است' });
    let total;
    try { ({ total } = priceCart(items)); }
    catch (e) { return res.status(404).json({ error: e.message }); }
    amount = total;
    purposeTag = `order:${JSON.stringify({ items, note: note || null })}`;
  }

  if (!amount || amount < 1000) return res.status(400).json({ error: 'مبلغ نامعتبر است' });

  const { authority, payUrl } = await requestPayment({
    amountRial: amount,
    description: purpose === 'topup' ? 'شارژ کیف‌پول استارکده' : 'خرید از استارکده',
  });

  db.prepare(`INSERT INTO gateway_payments (authority, tg_id, amount_rial, purpose) VALUES (?,?,?,?)`)
    .run(authority, req.dbUser.tg_id, amount, purposeTag);

  res.json({ payUrl });
});

// user's own transaction history (wallet page)
app.get('/api/wallet/transactions', requireTelegramAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE tg_id = ? ORDER BY created_at DESC LIMIT 40').all(req.dbUser.tg_id);
  res.json(rows);
});

// user's own order history (profile page)
app.get('/api/orders', requireTelegramAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE tg_id = ? ORDER BY created_at DESC LIMIT 30').all(req.dbUser.tg_id);
  res.json(rows);
});

// referral stats + invited list for the current user
app.get('/api/referral', requireTelegramAuth, (req, res) => {
  const invited = db.prepare('SELECT tg_id, username, first_name, created_at FROM users WHERE referred_by = ?').all(req.dbUser.tg_id);
  const totalEarned = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE tg_id = ? AND reason LIKE 'پورسانت%'`).get(req.dbUser.tg_id).s;
  res.json({
    ref_code: req.dbUser.ref_code,
    invited_count: invited.length,
    total_earned: totalEarned,
    invited,
  });
});

/* =========================================================================
   DAILY WHEEL — چرخ شانس رایگان روزانه (بدون شرط‌بندی، فقط جایزه رایگان)
   ========================================================================= */
const WHEEL_REWARDS = [0, 2000, 5000, 5000, 10000, 20000, 50000]; // تومان — قابل تنظیم
const WHEEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

app.get('/api/wheel/status', requireTelegramAuth, (req, res) => {
  const user = getUser(req.dbUser.tg_id);
  const last = user.last_spin_at ? new Date(user.last_spin_at + 'Z').getTime() : 0;
  const nextAt = last + WHEEL_COOLDOWN_MS;
  res.json({ canSpin: Date.now() >= nextAt, nextSpinAt: nextAt, rewards: WHEEL_REWARDS });
});
app.post('/api/wheel/spin', requireTelegramAuth, (req, res) => {
  const user = getUser(req.dbUser.tg_id);
  const last = user.last_spin_at ? new Date(user.last_spin_at + 'Z').getTime() : 0;
  if (Date.now() < last + WHEEL_COOLDOWN_MS) return res.status(400).json({ error: 'فردا دوباره امتحان کن' });

  const reward = WHEEL_REWARDS[Math.floor(Math.random() * WHEEL_REWARDS.length)];
  db.prepare(`UPDATE users SET last_spin_at = datetime('now') WHERE tg_id = ?`).run(user.tg_id);
  if (reward > 0) adjustBalance(user.tg_id, 'rial', reward, 'جایزه چرخ شانس روزانه');
  res.json({ reward });
});

/* =========================================================================
   STAKING — کاربر بخشی از موجودی ریالی رو قفل می‌کنه و APR سالانه می‌گیره
   ========================================================================= */
const STAKE_APR = Number(process.env.STAKE_APR || 38);           // درصد سالانه
const STAKE_CAP_RIAL = Number(process.env.STAKE_CAP_RIAL || 50000000); // سقف استیک هر کاربر

app.get('/api/stake', requireTelegramAuth, (req, res) => {
  const user = getUser(req.dbUser.tg_id);
  res.json({
    staked_rial: user.staked_rial,
    pending_reward: pendingStakeReward(user, STAKE_APR),
    apr: STAKE_APR,
    cap_rial: STAKE_CAP_RIAL,
  });
});
app.post('/api/stake/deposit', requireTelegramAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount < 1000) return res.status(400).json({ error: 'مبلغ نامعتبر است' });
  try {
    stakeDeposit(req.dbUser.tg_id, amount, STAKE_APR, STAKE_CAP_RIAL);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/stake/withdraw', requireTelegramAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount < 1000) return res.status(400).json({ error: 'مبلغ نامعتبر است' });
  try {
    stakeWithdraw(req.dbUser.tg_id, amount, STAKE_APR);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* =========================================================================
   TASKS — تسک‌های قابل مدیریت از پنل ادمین
   ========================================================================= */
app.get('/api/tasks', requireTelegramAuth, (req, res) => {
  const tasks = listActiveTasks().map(t => ({ ...t, done: isTaskDone(req.dbUser.tg_id, t.id) }));
  res.json(tasks);
});
app.post('/api/tasks/:id/claim', requireTelegramAuth, async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND active = 1').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'تسک پیدا نشد' });
  if (isTaskDone(req.dbUser.tg_id, task.id)) return res.status(400).json({ error: 'قبلاً این تسک رو انجام دادی' });

  if (task.type === 'join_channel') {
    const joined = await isChannelMember(task.channel_username, req.dbUser.tg_id);
    if (!joined) return res.status(400).json({ error: 'هنوز عضو کانال نشدی' });
  }
  completeTask(req.dbUser.tg_id, task);
  res.json({ ok: true });
});

/* =========================================================================
   CARD-TO-CARD TOP-UP — کاربر مبلغ رو خودش کارت‌به‌کارت می‌کنه و کد رهگیری
   وارد می‌کنه، ادمین از پنل تایید/رد می‌کنه (شارژ فقط بعد از تایید انجام می‌شود)
   ========================================================================= */
app.get('/api/topup/card-info', requireTelegramAuth, (req, res) => {
  res.json({
    cardNumber: process.env.CARD_NUMBER || '',
    cardHolder: process.env.CARD_HOLDER || '',
  });
});

app.post('/api/topup/card-request', requireTelegramAuth, (req, res) => {
  const { amountRial, cardLast4, trackCode, note } = req.body;
  const amount = Number(amountRial);
  if (!amount || amount < 1000) return res.status(400).json({ error: 'مبلغ نامعتبر است' });
  if (!trackCode || !String(trackCode).trim()) return res.status(400).json({ error: 'کد رهگیری تراکنش را وارد کن' });
  if (!process.env.CARD_NUMBER) return res.status(400).json({ error: 'شماره کارت هنوز توسط پشتیبانی تنظیم نشده' });

  const id = createCardTopup(req.dbUser.tg_id, amount, cardLast4 || null, String(trackCode).trim(), note || null);

  ADMIN_IDS.forEach(adminId => {
    sendMessage(adminId, `💳 درخواست شارژ کارت‌به‌کارت جدید #${id}\nکاربر: ${req.dbUser.first_name || ''} (${req.dbUser.tg_id})\nمبلغ: ${amount.toLocaleString()} تومان\nکد رهگیری: ${trackCode}`).catch(() => {});
  });

  res.json({ ok: true, id });
});

app.get('/api/topup/card-requests', requireTelegramAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM card_topups WHERE tg_id = ? ORDER BY created_at DESC LIMIT 20').all(req.dbUser.tg_id);
  res.json(rows);
});

/* =========================================================================
   P2P GIFT MARKETPLACE — کاربرها گیفت پروفایل تلگرام خودشون رو مستقیم به هم
   می‌فروشن (مثل پرتال). پول خریدار تا تایید دریافت گیفت نزد سیستم امانت می‌مونه.
   ========================================================================= */
const MARKET_FEE_PERCENT = Number(process.env.MARKET_FEE_PERCENT || 5);

app.get('/api/market/listings', requireTelegramAuth, (req, res) => {
  res.json(listActiveListings(req.dbUser.tg_id));
});
app.post('/api/market/listings', requireTelegramAuth, (req, res) => {
  const { title, description, priceRial, imageUrl } = req.body;
  const price = Number(priceRial);
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'نام گیفت را وارد کن' });
  if (!price || price < 1000) return res.status(400).json({ error: 'قیمت نامعتبر است' });
  const id = createListing(req.dbUser.tg_id, String(title).trim(), description || null, price, imageUrl || null);
  res.json({ ok: true, id });
});
app.get('/api/market/my-listings', requireTelegramAuth, (req, res) => {
  res.json(myListings(req.dbUser.tg_id));
});
app.delete('/api/market/listings/:id', requireTelegramAuth, (req, res) => {
  try { cancelListing(Number(req.params.id), req.dbUser.tg_id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/market/listings/:id/buy', requireTelegramAuth, (req, res) => {
  try {
    const { orderId, listing } = buyListing(Number(req.params.id), req.dbUser.tg_id, MARKET_FEE_PERCENT);
    sendMessage(listing.seller_tg_id, `🎁 آگهی «${listing.title}» شما فروخته شد!\nگیفت رو مستقیم توی تلگرام برای خریدار بفرست. بعد از دریافت، خریدار توی اپ تایید می‌کنه تا مبلغ (منهای کارمزد) به کیف‌پولت واریز بشه.\nسفارش: #${orderId}`).catch(() => {});
    res.json({ ok: true, orderId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/market/my-purchases', requireTelegramAuth, (req, res) => {
  res.json(myPurchases(req.dbUser.tg_id));
});
app.get('/api/market/my-sales', requireTelegramAuth, (req, res) => {
  res.json(mySales(req.dbUser.tg_id));
});
app.post('/api/market/orders/:id/confirm', requireTelegramAuth, (req, res) => {
  try {
    const order = confirmOrderReceipt(Number(req.params.id), req.dbUser.tg_id);
    sendMessage(order.seller_tg_id, `✅ خریدار دریافت گیفت رو تایید کرد.\nمبلغ ${(order.price_rial - order.fee_rial).toLocaleString()} تومان به کیف‌پولت واریز شد.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/market/orders/:id/dispute', requireTelegramAuth, (req, res) => {
  try {
    const order = disputeOrder(Number(req.params.id), req.dbUser.tg_id);
    ADMIN_IDS.forEach(adminId => sendMessage(adminId, `⚠️ اعتراض روی سفارش مارکت گیفت #${order.id} ثبت شد. لطفاً از پنل بررسی کن.`).catch(() => {}));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// gateway calls this URL back after the user finishes paying (set as ZARINPAL_CALLBACK_URL)
app.get('/gateway/verify', async (req, res) => {
  const { Authority, Status } = req.query;
  const record = db.prepare('SELECT * FROM gateway_payments WHERE authority = ?').get(Authority);
  if (!record) return res.status(404).send('پرداخت پیدا نشد');

  if (Status !== 'OK') {
    db.prepare(`UPDATE gateway_payments SET status = 'failed' WHERE authority = ?`).run(Authority);
    return res.send('پرداخت لغو شد. می‌توانید این صفحه را ببندید و به ربات بازگردید.');
  }

  const { ok, refId } = await verifyPayment({ authority: Authority, amountRial: record.amount_rial });
  if (!ok) {
    db.prepare(`UPDATE gateway_payments SET status = 'failed' WHERE authority = ?`).run(Authority);
    return res.send('تایید پرداخت ناموفق بود.');
  }

  db.prepare(`UPDATE gateway_payments SET status = 'paid' WHERE authority = ?`).run(Authority);

  if (record.purpose === 'topup') {
    adjustBalance(record.tg_id, 'rial', record.amount_rial, 'شارژ کیف‌پول از درگاه', refId);
    sendMessage(record.tg_id, `✅ کیف‌پول شما به مبلغ ${record.amount_rial.toLocaleString()} تومان شارژ شد.`);
  } else if (record.purpose.startsWith('order:')) {
    const { items, note } = JSON.parse(record.purpose.slice('order:'.length));
    items.forEach(({ productId, qty }) => {
      const product = getProduct(productId);
      if (product) createOrder(record.tg_id, productId, qty, product.price_rial * qty, 'gateway', note || null);
    });
    payReferralCommission(record.tg_id, record.amount_rial);
    sendMessage(record.tg_id, `✅ پرداخت شما تایید شد و سفارش ثبت گردید.${note ? `\nمقصد: ${note}` : ''}`);
  }

  res.send('پرداخت با موفقیت انجام شد ✅ می‌توانید به ربات بازگردید.');
});

/* =========================================================================
   TELEGRAM WEBHOOK — receives all bot updates (messages + payments)
   ========================================================================= */
app.post('/telegram-webhook', async (req, res) => {
  // امنیت: تلگرام هدر secret token شما را در هر درخواست برمی‌گرداند
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // پاسخ فوری به تلگرام؛ پردازش را بعد از آن انجام می‌دهیم

  const update = req.body;

  // 1) کاربر ربات را استارت کرده -> پیام خوش‌آمد + دکمه باز کردن مینی‌اپ
  if (update.message?.text?.startsWith('/start')) {
    const chatId = update.message.chat.id;
    const refParam = update.message.text.split(' ')[1]; // مثلاً ref_123456 — دیگه پیشوند رو حذف نمی‌کنیم چون دقیقاً با ref_code دیتابیس باید یکی باشه
    getOrCreateUser(update.message.from, refParam);

    if (process.env.REQUIRED_CHANNEL) {
      const joined = await isChannelMember(process.env.REQUIRED_CHANNEL, update.message.from.id);
      if (!joined) {
        await sendMessage(chatId, `برای استفاده از ربات، اول باید عضو کانال ما بشی:`, {
          reply_markup: { inline_keyboard: [
            [{ text: '📢 عضویت در کانال', url: `https://t.me/${process.env.REQUIRED_CHANNEL.replace('@','')}` }],
            [{ text: '✅ عضو شدم، بررسی کن', callback_data: 'check_join' }],
          ] },
        });
        return;
      }
    }

    await sendMessage(chatId, 'به <b>استارکده</b> خوش اومدی ✨\nاز دکمه پایین فروشگاه رو باز کن:', {
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 باز کردن فروشگاه', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]],
      },
    });
    return;
  }

  // 1b) دکمه «عضو شدم، بررسی کن»
  if (update.callback_query?.data === 'check_join') {
    answerCallbackQuery(update.callback_query.id).catch(() => {});
    const chatId = update.callback_query.message.chat.id;
    const joined = !process.env.REQUIRED_CHANNEL || await isChannelMember(process.env.REQUIRED_CHANNEL, update.callback_query.from.id);
    if (joined) {
      await sendMessage(chatId, 'عضویت تایید شد ✅ از دکمه پایین فروشگاه رو باز کن:', {
        reply_markup: { inline_keyboard: [[{ text: '🛍 باز کردن فروشگاه', web_app: { url: process.env.PUBLIC_URL + '/miniapp' } }]] },
      });
    } else {
      await sendMessage(chatId, '❌ هنوز عضو کانال نشدی.');
    }
    return;
  }

  // 2) دستورات مدیریتی ادمین در چت با ربات
  if (update.message?.text && isAdmin(update.message.from.id)) {
    const [cmd, ...args] = update.message.text.trim().split(' ');
    const chatId = update.message.chat.id;

    if (cmd === '/stats') {
      const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      const rialIn = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='in' AND currency='rial'`).get().s;
      const orders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
      await sendMessage(chatId, `📊 آمار کلی\nکاربران: ${users}\nسفارش‌ها: ${orders}\nمجموع واریزی: ${rialIn.toLocaleString()} تومان`);
    }

    if (cmd === '/addbalance' && args.length === 2) {
      const [targetId, amount] = args;
      adjustBalance(Number(targetId), 'rial', Number(amount), 'شارژ دستی توسط ادمین');
      await sendMessage(chatId, `✅ ${amount} تومان به کیف‌پول ${targetId} اضافه شد.`);
      await sendMessage(Number(targetId), `💰 مبلغ ${Number(amount).toLocaleString()} تومان توسط پشتیبانی به کیف‌پول شما اضافه شد.`);
    }
  }

  // 3) پیش از پرداخت استارز -> باید طی ۱۰ ثانیه تایید شود
  if (update.pre_checkout_query) {
    await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
    return;
  }

  // 4) پرداخت استارز با موفقیت انجام شد -> تحویل کالا / شارژ موجودی
  if (update.message?.successful_payment) {
    const sp = update.message.successful_payment;
    const payload = JSON.parse(sp.invoice_payload);

    let names = [];
    payload.items.forEach(({ productId, qty }) => {
      const product = getProduct(productId);
      if (!product) return;
      createOrder(payload.tg_id, productId, qty, product.price_rial * qty, 'stars', payload.note || null);
      names.push(`${product.name} ×${qty}`);
    });
    const totalRial = payload.items.reduce((s, { productId, qty }) => {
      const p = getProduct(productId);
      return s + (p ? p.price_rial * qty : 0);
    }, 0);
    payReferralCommission(payload.tg_id, totalRial);

    await sendMessage(payload.tg_id, `✅ پرداخت با ${sp.total_amount}⭐️ موفق بود.\nسفارش: ${names.join('، ')}${payload.note ? `\nمقصد: ${payload.note}` : ''}`);
  }
});

/* =========================================================================
   SERVE THE MINI APP FRONTEND (the HTML file from earlier)
   ========================================================================= */
app.use('/miniapp', express.static('public')); // put starkadeh-miniapp.html as public/index.html
app.use('/admin/api', adminRouter);            // admin panel API (password protected, see admin.js)
app.use('/admin', express.static('admin-panel')); // admin panel frontend (admin-panel/index.html)

app.listen(process.env.PORT || 3000, async () => {
  console.log(`🚀 server running on port ${process.env.PORT || 3000}`);
  if (process.env.PUBLIC_URL) {
    const r = await setWebhook(`${process.env.PUBLIC_URL}/telegram-webhook`, process.env.WEBHOOK_SECRET);
    console.log('webhook set:', r.ok);
  }
});
