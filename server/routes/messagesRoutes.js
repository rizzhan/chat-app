const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Message = require("../models/messages");
const Conversation = require("../models/conversation");

// Send Message
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const { conversationId, text } = req.body;

    if (!conversationId || !text || !text.trim()) {
      return res.status(400).json({
        message: "conversationId and text are required",
      });
    }

    // Make sure the sender is a participant of this conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const message = await Message.create({
      conversationId,
      sender: req.user.id,
      text: text.trim(),
    });

    // Update the conversation's last message so the sidebar can show it
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: message._id,
    });

    const populated = await Message.findById(message._id).populate(
      "sender",
      "username avatar email"
    );

    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
});

// Get Messages for a conversation
router.get("/:conversationId", authMiddleware, async (req, res, next) => {
  try {
    // Make sure the current user is a participant of this conversation
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const messages = await Message.find({
      conversationId: req.params.conversationId,
    })
      .populate("sender", "username avatar email")
      .sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
