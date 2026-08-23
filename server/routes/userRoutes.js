const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const upload = require("../middleware/upload");
const { uploadImageOnly } = require("../middleware/upload");
const User = require("../models/user");
const Friend = require("../models/friend");
const Conversation = require("../models/conversation");
const Message = require("../models/messages");

// Upload / change the current user's profile picture
router.post(
  "/avatar",
  authMiddleware,
  uploadImageOnly.single("file"),
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

// Update the current user's profile (username, handle, status).
// Email is deliberately not editable here (and never exposed publicly).
router.patch("/me", authMiddleware, async (req, res, next) => {
  try {
    const { username, handle, status, avatar } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (avatar !== undefined) {
      // Allows removing the profile picture by sending avatar: "".
      user.avatar = String(avatar).trim();
    }

    if (username !== undefined) {
      const uname = String(username).trim();
      if (uname.length < 3 || uname.length > 20) {
        return res.status(400).json({
          message: "Username must be between 3 and 20 characters",
        });
      }
      const taken = await User.findOne({
        username: uname,
        _id: { $ne: user._id },
      });
      if (taken) {
        return res.status(400).json({ message: "Username already taken" });
      }
      user.username = uname;
    }

    if (handle !== undefined) {
      const h = String(handle).trim().replace(/^@/, "").toLowerCase();
      if (h) {
        if (!/^[a-z0-9_]{3,20}$/.test(h)) {
          return res.status(400).json({
            message: "Handle must be 3-20 characters (letters, numbers, _)",
          });
        }
        const taken = await User.findOne({
          handle: h,
          _id: { $ne: user._id },
        });
        if (taken) {
          return res.status(400).json({ message: "Handle already taken" });
        }
        user.handle = h;
      } else {
        user.handle = "";
      }
    }

    if (status !== undefined) {
      const s = String(status).trim();
      if (s.length > 100) {
        return res
          .status(400)
          .json({ message: "Status must be 100 characters or less" });
      }
      user.status = s;
    }

    await user.save();
    res.json(await User.findById(user._id).select("-password"));
  } catch (error) {
    next(error);
  }
});

// Protected profile route
router.get("/profile", authMiddleware, (req, res) => {
  res.json({
    message: "Protected route accessed",
    user: req.user,
  });
});

// Search users by username or handle (must be defined before /:id)
router.get("/search", authMiddleware, async (req, res, next) => {
  try {
    const { username } = req.query;

    if (!username || !username.trim()) {
      return res.status(400).json({
        message: "Search term is required",
      });
    }

    const term = username.trim();
    const handleTerm = term.replace(/^@/, "");

    // Escape user input so regex metacharacters (e.g. '.') don't match
    // unintended patterns in username or handle fields.
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const users = await User.find({
      $or: [
        { username: { $regex: escapeRegex(term), $options: "i" } },
        { handle: { $regex: escapeRegex(handleTerm), $options: "i" } },
      ],
      _id: { $ne: req.user.id },
    })
      .select("username avatar handle status")
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
      "username avatar handle status"
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
      "username avatar handle status"
    );

    res.json(users);
  } catch (error) {
    next(error);
  }
});

// Get user by ID (public view - email is never exposed)
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select(
      "username avatar handle status"
    );

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
