// Studio auth/user routes — extracted verbatim from mycelium.js (god-file
// decomposition, 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendEmail, templatePasswordReset } from '../email.js';
import {
  getStudioUserByUsername, getStudioUserById, createStudioUser,
  listStudioUsers, updateStudioUser, deleteStudioUser, getDB,
} from '../db.js';

export function registerStudioRoutes(router, deps) {
  const {
    asyncHandler, checkAdmin, emitEvent, getAdminDisplayName, parseIntParam,
    getStudioUser, isAdminKey, loginLimiter, rateLimit,
    JWT_SECRET, STUDIO_JWT_EXPIRY, BCRYPT_ROUNDS_PASSWORD,
  } = deps;

  // ======== STUDIO AUTH ========

  // Login — returns JWT
  router.post('/studio/login', loginLimiter, asyncHandler(async function (req, res) {
    var username = (req.body.username || '').trim().toLowerCase();
    var password = req.body.password || '';
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    var user = getStudioUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    var token = jwt.sign({
      studioUser: true,
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    }, JWT_SECRET, { expiresIn: STUDIO_JWT_EXPIRY });
    res.json({
      token: token,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
    });
  }));

  // Who am I
  router.get('/studio/me', asyncHandler(function (req, res) {
    var user = getStudioUser(req);
    if (!user) {
      // Check admin key
      var key = req.headers['x-admin-key'];
      if (isAdminKey(key)) return res.json({ id: 0, username: 'admin', display_name: 'Admin', role: 'admin' });
      return res.status(401).json({ error: 'Not authenticated' });
    }
    var dbUser = getStudioUserById(user.userId);
    if (!dbUser) return res.status(401).json({ error: 'User not found' });
    res.json(dbUser);
  }));

  // Register new studio user (admin only)
  router.post('/studio/users', asyncHandler(async function (req, res) {
    if (!checkAdmin(req, res)) return;
    var username = (req.body.username || '').trim().toLowerCase();
    var password = req.body.password || '';
    var displayName = (req.body.display_name || '').trim();
    var role = req.body.role || 'admin';
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'username, password, and display_name are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (getStudioUserByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    var hash = await bcrypt.hash(password, BCRYPT_ROUNDS_PASSWORD);
    var id = createStudioUser(username, displayName, hash, role);
    emitEvent('user_created', getAdminDisplayName(req), null, 'Studio user created: ' + displayName + ' (' + username + ')');
    res.json({ id: id, username: username, display_name: displayName, role: role });
  }));

  // List studio users (admin only)
  router.get('/studio/users', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    res.json(listStudioUsers());
  }));

  // Update studio user (admin only)
  router.put('/studio/users/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var user = getStudioUserById(parseIntParam(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    var fields = {};
    if (req.body.role !== undefined) fields.role = req.body.role;
    if (req.body.display_name !== undefined) fields.display_name = req.body.display_name;
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });
    updateStudioUser(user.id, fields);
    res.json({ ok: true, id: user.id, username: user.username, ...fields });
  }));

  // Update studio user password (admin only)
  router.put('/studio/users/:id/password', asyncHandler(async function (req, res) {
    if (!checkAdmin(req, res)) return;
    var user = getStudioUserById(parseIntParam(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    var newPassword = req.body.password || '';
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
    updateStudioUser(user.id, { password_hash: hash });
    res.json({ ok: true, username: user.username });
  }));

  // Delete studio user (admin only)
  router.delete('/studio/users/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var user = getStudioUserById(parseIntParam(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    deleteStudioUser(user.id);
    res.json({ ok: true, deleted: user.username });
  }));

  // ======== PASSWORD RESET (public, rate-limited) ========

  // Ensure password_resets table exists (inline migration pattern, same as waitlist)
  try {
    getDB().prepare(`CREATE TABLE IF NOT EXISTS password_resets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT NOT NULL,
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  } catch (e) { /* already exists */ }

  var forgotPasswordLimiter = rateLimit(function (req) { return 'forgot:' + (req.body.email || '').toLowerCase(); }, 3, 15 * 60 * 1000);
  var resetPasswordLimiter = rateLimit(function (req) { return 'reset:' + (req.ip || req.connection.remoteAddress); }, 5, 15 * 60 * 1000);

  // POST /studio/forgot-password — request password reset email
  router.post('/studio/forgot-password', forgotPasswordLimiter, asyncHandler(async function (req, res) {
    var email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    // Always return 200 (no user enumeration)
    var GENERIC = { ok: true, message: 'If that email is associated with an account, a reset link has been sent.' };
    // Find operator by email → get their studio_user_id
    var db = getDB();
    var operator = db.prepare('SELECT * FROM operators WHERE LOWER(email) = ? AND status = ?').get(email, 'active');
    if (!operator || !operator.studio_user_id) return res.json(GENERIC);
    var studioUser = getStudioUserById(operator.studio_user_id);
    if (!studioUser) return res.json(GENERIC);
    // Generate secure token (48 hex chars), store SHA-256 hash
    var token = crypto.randomBytes(32).toString('hex');
    var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    var expiresMinutes = 30;
    var expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (email, token_hash, expires_at) VALUES (?, ?, ?)').run(email, tokenHash, expiresAt);
    // Build reset URL (dashboard handles the UI)
    var resetUrl = 'https://mycelium.fyi/studio/#/reset-password?token=' + token;
    sendEmail(templatePasswordReset(email, studioUser.display_name, resetUrl, expiresMinutes));
    res.json(GENERIC);
  }));

  // POST /studio/reset-password — validate token and set new password
  router.post('/studio/reset-password', resetPasswordLimiter, asyncHandler(async function (req, res) {
    var token = (req.body.token || '').trim();
    var newPassword = req.body.password || '';
    if (!token) return res.status(400).json({ error: 'token is required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    var db = getDB();
    var row = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')").get(tokenHash);
    if (!row) return res.status(400).json({ error: 'Invalid or expired reset token' });
    // Find operator → studio user
    var operator = db.prepare('SELECT * FROM operators WHERE LOWER(email) = ?').get(row.email);
    if (!operator || !operator.studio_user_id) return res.status(400).json({ error: 'Account not found' });
    var studioUser = getStudioUserById(operator.studio_user_id);
    if (!studioUser) return res.status(400).json({ error: 'Account not found' });
    // Update password (bcrypt 10 rounds for human passwords)
    var hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS_PASSWORD);
    updateStudioUser(studioUser.id, { password_hash: hash });
    // Mark token as used
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    emitEvent('password_reset', '__system__', null, 'Password reset for ' + studioUser.display_name + ' (' + studioUser.username + ')');
    res.json({ ok: true, message: 'Password has been reset. You can now log in.' });
  }));
}
