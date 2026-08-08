const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const upload = require("../middleware/upload");
const User = require("../models/user");
const Friend = require("../models/friend");
const Conversation = require("../models/conversation");
const Message = require("../models/messages");

// Upload / change the current user's profile picture
router.post(
  "/avatar",
  authMiddleware,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const user = await User.findByIdAndUpdate(
        req.user.id,
        { avatar: `/uploads/${req.file.filename}` },
        { new: true }
      ).select("-password");

      res.json(user);
    } catch (error) {
      next(error);
    }
  }
);

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

// Delete the current user's account (and clean up everything they own)
router.delete("/me", authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Remove the user from all friend relationships
    await Friend.deleteMany({
      $or: [{ requester: userId }, { recipient: userId }],
    });

    // Forget the user in every message's read/deleted tracking
    await Message.updateMany(
      {},
      { $pull: { readBy: userId, deletedFor: userId } }
    );

    const conversations = await Conversation.find({ participants: userId });

    for (const conversation of conversations) {
      if (conversation.type === "private") {
        await Message.deleteMany({ conversationId: conversation._id });
        await conversation.deleteOne();
      } else {
        conversation.participants.pull(userId);
        conversation.favorites.pull(userId);
        conversation.pinnedBy.pull(userId);
        conversation.archivedBy.pull(userId);
        conversation.themes = conversation.themes.filter(
          (t) => t.user.toString() !== userId
        );
        conversation.mutedBy = conversation.mutedBy.filter(
          (m) => m.user.toString() !== userId
        );
        conversation.backgrounds = conversation.backgrounds.filter(
          (b) => b.user.toString() !== userId
        );
        if (conversation.admin && conversation.admin.toString() === userId) {
          conversation.admin = null;
        }
        await conversation.save();
      }
    }

    await User.findByIdAndDelete(userId);

    res.json({ message: "Account deleted" });
  } catch (error) {
    next(error);
  }
});

// Get the list of users the current user has blocked
router.get("/blocked", authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).populate(
      "blocked",
      "username avatar email"
    );

    res.json(user?.blocked || []);
  } catch (error) {
    next(error);
  }
});

// Block a user
router.post("/:id/block", authMiddleware, async (req, res, next) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.user.id) {
      return res.status(400).json({ message: "You cannot block yourself" });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    await User.findByIdAndUpdate(req.user.id, {
      $addToSet: { blocked: targetId },
    });

    res.json({ message: "User blocked" });
  } catch (error) {
    next(error);
  }
});

// Unblock a user
router.post("/:id/unblock", authMiddleware, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user.id, {
      $pull: { blocked: req.params.id },
    });

    res.json({ message: "User unblocked" });
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
