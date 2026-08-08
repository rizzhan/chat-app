const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const User = require("../models/user");

// Protected profile route
router.get("/profile", authMiddleware, (req, res) => {
  res.json({
    message: "Protected route accessed",
    user: req.user,
  });
});

// Search users by username (must be defined before /:id)
router.get("/search", authMiddleware, async (req, res, next) => {
  try {
    const { username } = req.query;

    if (!username || !username.trim()) {
      return res.status(400).json({
        message: "Search term is required",
      });
    }

    const users = await User.find({
      username: { $regex: username.trim(), $options: "i" },
      _id: { $ne: req.user.id },
    })
      .select("-password")
      .limit(20);

    res.json(users);
  } catch (error) {
    next(error);
  }
});

// Get all users (excluding the current user)
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select(
      "-password"
    );

    res.json(users);
  } catch (error) {
    next(error);
  }
});

// Get user by ID
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
