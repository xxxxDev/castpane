const express = require('express');
const authController = require('../controllers/authController');
const { verifyToken, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/login', authController.login);
// Two-step sign-in.
router.post('/login/code', authController.loginCode);
router.post('/login/start', authController.loginStart);
router.get('/two-step', verifyToken, authController.twoStepStatus);
router.post('/two-step/setup', verifyToken, authController.twoStepSetup);
router.post('/two-step/enable', verifyToken, authController.twoStepEnable);
router.post('/two-step/disable', verifyToken, authController.twoStepDisable);
router.post('/logout', authController.logout);
router.get('/verify', authController.verifySession);
router.get('/me', verifyToken, authController.me);
router.put('/me', verifyToken, authController.updateMe);
router.post('/change-password', verifyToken, authController.changePassword);
// Passkeys.
router.post('/passkey/start', authController.passkeyStart);
router.post('/passkey/finish', authController.passkeyFinish);
router.post('/passkey/again', verifyToken, authController.passkeyAgain);
router.get('/passkeys', verifyToken, authController.listPasskeys);
router.post('/passkeys/options', verifyToken, authController.passkeyOptions);
router.post('/passkeys', verifyToken, authController.addPasskey);
router.delete('/passkeys/:id', verifyToken, authController.removePasskey);
// QR sign-in.
router.post('/qr/start', authController.qrStart);
router.get('/qr/poll', authController.qrPoll);
router.get('/qr/:id', verifyToken, authController.qrPeek);
router.post('/qr/:id/decide', verifyToken, authController.qrDecide);
router.get('/devices', verifyToken, authController.listDevices);
router.post('/devices', verifyToken, authController.bindDevice);
router.delete('/devices/:id', verifyToken, authController.removeDevice);
router.delete('/sessions/:id', verifyToken, authController.removeSession);

// One account: the setup assistant makes it (localApi.js, createFirstAdmin) and nothing
// makes another. Accounts left from a version that had several are listed, so they are
// seen, and deleted; nothing else is done to them.
router.get('/users', verifyToken, restrictTo('admin'), authController.listUsers);
router.delete('/users/:id', verifyToken, restrictTo('admin'), authController.deleteUser);

module.exports = router;
