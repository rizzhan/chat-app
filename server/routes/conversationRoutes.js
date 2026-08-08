const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Conversation = require("../models/conversation");

// Create Conversation (returns existing conversation if it already exists)
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({
        message: "Receiver ID is required",
      });
    }

    if (receiverId === req.user.id) {
      return res.status(400).json({
        message: "You cannot start a conversation with yourself",
      });
    }

    // Prevent duplicate 1-to-1 conversations
    const existing = await Conversation.findOne({
      participants: { $all: [req.user.id, receiverId] },
    })
      .populate("participants", "username avatar email")
      .populate("lastMessage");

    if (existing) {
      return res.status(200).json(existing);
    }

    const conversation = await Conversation.create({
      participants: [req.user.id, receiverId],
    });

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar email")
      .populate("lastMessage");

    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
});

// Get all conversations for the current user
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .populate("participants", "username avatar email")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    res.json(conversations);
  } catch (error) {
    next(error);
  }
});

// Get a specific conversation (only if the current user is a participant)
router.get("/:conversationId", authMiddleware, async (req, res, next) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    })
      .populate("participants", "username avatar email")
      .populate("lastMessage");

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    res.json(conversation);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
