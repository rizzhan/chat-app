const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
    registerUser,
    loginUser,
} = require("../controllers/authcontroller");

// Brute-force protection on auth — 10 attempts / 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many attempts, try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/register", authLimiter, registerUser);
router.post("/login", authLimiter, loginUser);

module.exports = router;