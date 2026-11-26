const crypto = require('crypto');
const MAXPHOTO = 90 * 1024;
const J = (res, code, obj) => { res.status(code).setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
async function readAll(prefix, blob) {
  const out = []; let cursor;
  do { const r = await blob.list({ prefix, cursor, limit: 200 }); out.push(...r.blobs); cursor = r.hasMore ? r.cursor : null; } while (cursor && out.length < 1000);
  return out;
}
async function load(b) { try { const r = await fetch(b.url + '?t=' + Date.now()); return await r.json(); } catch (e) { return null; } }
module.exports = async (req, res) => {
  try {
    const blob = await import('@vercel/blob');
    const a = (req.query && req.query.a) || '';
    if (a === 'list' && req.method === 'GET') {
      const bs = await readAll('t/approved/', blob);
      const items = (await Promise.all(bs.map(load))).filter(Boolean).sort((x, y) => y.ts - x.ts).slice(0, 30);
      return J(res, 200, { items });
    }
    if (a === 'submit' && req.method === 'POST') {
      const b = req.body || {};
      if (b.hp) return J(res, 200, { ok: true });
      const name = clean(b.name, 60), role = clean(b.role, 60), text = clean(b.text, 500);
      if (name.length < 2 || text.length < 10) return J(res, 400, { error: 'invalid' });
      let photo = '';
      if (b.photo) {
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.photo));
        if (!m) return J(res, 400, { error: 'photo' });
        const buf = Buffer.from(m[1], 'base64');
        if (buf.length > MAXPHOTO || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return J(res, 400, { error: 'photo' });
        photo = 'data:image/jpeg;base64,' + m[1];
      }
      const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'x').trim();
      const ih = crypto.createHash('sha256').update(ip + '|mfhub').digest('hex').slice(0, 20);
      const now = Date.now();
      const rl = await readAll('rl/' + ih + '-', blob);
      const recent = rl.filter(x => now - new Date(x.uploadedAt).getTime() < 3600e3);
      if (recent.length >= 3) return J(res, 429, { error: 'rate' });
      const pend = await readAll('t/pending/', blob);
      if (pend.length >= 100) return J(res, 429, { error: 'full' });
      const id = now.toString(36) + crypto.randomBytes(4).toString('hex');
      await blob.put('rl/' + ih + '-' + id + '.txt', '1', { access: 'public', addRandomSuffix: false, allowOverwrite: true });
      await blob.put('t/pending/' + id + '.json', JSON.stringify({ id, name, role, text, photo, ts: now }), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      return J(res, 200, { ok: true });
    }
    if (a === 'admin' && req.method === 'POST') {
      const key = process.env.ADMIN_KEY;
      if (!key) return J(res, 503, { error: 'not-configured' });
      const b = req.body || {};
      if (!eq(b.key || '', key)) { await new Promise(r => setTimeout(r, 1200)); return J(res, 401, { error: 'auth' }); }
      if (b.act === 'list') {
        const p = (await Promise.all((await readAll('t/pending/', blob)).map(load))).filter(Boolean).sort((x, y) => x.ts - y.ts);
        const ap = (await Promise.all((await readAll('t/approved/', blob)).map(load))).filter(Boolean).sort((x, y) => y.ts - x.ts);
        return J(res, 200, { pending: p, approved: ap });
      }
      const id = clean(b.id, 40);
      if (!/^[a-z0-9]+$/.test(id)) return J(res, 400, { error: 'id' });
      if (b.act === 'approve') {
        const bs = await readAll('t/pending/' + id, blob); const f = bs.find(x => x.pathname === 't/pending/' + id + '.json');
        if (!f) return J(res, 404, { error: 'nf' });
        const it = await load(f);
        await blob.put('t/approved/' + id + '.json', JSON.stringify(it), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
        await blob.del(f.url);
        return J(res, 200, { ok: true });
      }
      if (b.act === 'reject' || b.act === 'delete') {
        const folder = b.act === 'reject' ? 't/pending/' : 't/approved/';
        const bs = await readAll(folder + id, blob); const f = bs.find(x => x.pathname === folder + id + '.json');
        if (!f) return J(res, 404, { error: 'nf' });
        await blob.del(f.url);
        return J(res, 200, { ok: true });
      }
      return J(res, 400, { error: 'act' });
    }
    return J(res, 404, { error: 'nf' });
  } catch (e) { return J(res, 500, { error: 'server', m: String(e && e.message || e).slice(0, 160) }); }
};
