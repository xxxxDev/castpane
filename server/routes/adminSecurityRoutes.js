const express = require('express');
const { verifyToken, restrictTo } = require('../middlewares/authMiddleware');
const { security } = require('../services/securityLog');
const { resolveClientIp, normalizeIp } = require('../services/clientIp');
const { audit } = require('../services/audit');

// Sign-in defence for admins (services/securityLog.js): what was tried, from where, and which addresses are blocked.
const router = express.Router();
router.use(verifyToken, restrictTo('admin'));

router.get('/', (req, res) => {
  const filter = ['all', 'fail', 'qr', 'block'].includes(req.query.filter) ? req.query.filter : 'all';
  res.json({ ...security.view({ days: 7, filter, limit: 100 }), mine: security.groupOf(resolveClientIp(req)) });
});
router.get('/source', (req, res) => {
  if (typeof req.query.group !== 'string' || !req.query.group || req.query.group.length > 64) return res.status(400).json({ message: 'group is required' });
  res.json({ ...security.source(req.query.group), mine: security.groupOf(resolveClientIp(req)) === req.query.group });
});
// Block an address by hand. Not the admin's own: that would lock them out.
router.post('/blocks', (req, res) => {
  const { hours } = req.body || {};
  if (typeof (req.body || {}).ip !== 'string' || !req.body.ip || req.body.ip.length > 64) return res.status(400).json({ message: 'ip is required' });
  // Tidied before it is compared: " 192.0.2.10" is the admin's own address too.
  const ip = normalizeIp(req.body.ip) || req.body.ip.trim();
  if (!(Number(hours) >= 1)) return res.status(400).json({ message: 'hours must be at least 1' });
  if (security.groupOf(ip) === security.groupOf(resolveClientIp(req))) return res.status(409).json({ message: 'This is the address you are using', code: 'OWN_ADDRESS' });
  try {
    const block = security.block(ip, hours, req.username);
    audit({ source: 'security', action: 'block', group: block.group, until: block.until, by: req.username });
    res.status(201).json({ block });
  } catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Error' }); }
});
router.delete('/blocks', (req, res) => {
  const group = req.query.group;
  if (typeof group !== 'string' || !group) return res.status(400).json({ message: 'group is required' });
  if (!security.unblock(group, req.username)) return res.status(404).json({ message: 'Not blocked' });
  audit({ source: 'security', action: 'unblock', group, by: req.username });
  res.json({ ok: true });
});
// Lift the protection on an account name (20 failures in an hour put it there).
router.delete('/accounts', (req, res) => {
  const name = req.query.name;
  if (typeof name !== 'string' || !name || name.length > 80) return res.status(400).json({ message: 'name is required' });
  // The day's count of wrong codes stays: a session that is guessing its own
  // account's code would otherwise lift its own limit over and over. Only the rescue script on the machine clears that too.
  if (!security.accountRelease(name, req.username, { keepDay: true })) return res.status(404).json({ message: 'Not protected' });
  audit({ source: 'security', action: 'account-release', name, by: req.username });
  res.json({ ok: true });
});

module.exports = router;
