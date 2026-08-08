const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Message = require("../models/messages");
const Conversation = require("../models/conversation");
const { isBlockedPair } = require("../utils/blocked");

// Send Message
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const { conversationId, text = "", type = "text", file } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        message: "conversationId is required",
      });
    }

    const trimmedText = typeof text === "string" ? text.trim() : "";
    const hasText = trimmedText.length > 0;
    const hasFile = file && file.url;
    const isTextType = type === "text";

    if (!hasText && !hasFile) {
      return res.status(400).json({
        message: "Message content is required",
      });
    }

    if (isTextType && !hasText) {
      return res.status(400).json({
        message: "Message text is required",
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

    // If this is a 1-to-1 chat, block messages from a user who is blocked
    if (conversation.type === "private") {
      const otherId = conversation.participants.find(
        (p) => p.toString() !== req.user.id
      );
      if (otherId && (await isBlockedPair(req.user.id, otherId))) {
        return res.status(403).json({
          message: "You cannot send messages to this user",
        });
      }
    }

    const message = await Message.create({
      conversationId,
      sender: req.user.id,
      text: trimmedText,
      type: isTextType ? "text" : type,
      ...(file ? { file } : {}),
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

// Get Messages for a conversation (also marks them as read)
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

    // Mark incoming messages as read by the current user (before fetching,
    // so the response already includes the updated readBy).
    const result = await Message.updateMany(
      {
        conversationId: req.params.conversationId,
        sender: { $ne: req.user.id },
        readBy: { $ne: req.user.id },
      },
      { $addToSet: { readBy: req.user.id } }
    );

    // Tell the other participants (in real time) that these were read
    if (result.modifiedCount > 0 && req.io) {
      req.io.to(req.params.conversationId).emit("messages-read", {
        conversationId: req.params.conversationId,
        readerId: req.user.id,
      });
    }

    const messages = await Message.find({
      conversationId: req.params.conversationId,
      deletedFor: { $nin: [req.user.id] },
    })
      .populate("sender", "username avatar email")
      .sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    next(error);
  }
});

// Edit a message (sender only, text only, within 2 minutes of sending)
router.post("/:id/edit", authMiddleware, async (req, res, next) => {
  try {
    const { text } = req.body;
    const trimmed = typeof text === "string" ? text.trim() : "";

    if (!trimmed) {
      return res.status(400).json({ message: "Message text is required" });
    }

    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.sender.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only edit your own messages",
      });
    }

    if (message.type !== "text") {
      return res.status(400).json({ message: "Only text messages can be edited" });
    }

    const age = Date.now() - new Date(message.createdAt).getTime();
    if (age > 2 * 60 * 1000) {
      return res.status(400).json({
        message: "Messages can only be edited within 2 minutes",
      });
    }

    message.text = trimmed;
    message.editedAt = Date.now();
    await message.save();

    const populated = await Message.findById(message._id).populate(
      "sender",
      "username avatar email"
    );

    // Tell everyone in the conversation about the edit
    if (req.io) {
      req.io
        .to(message.conversationId.toString())
        .emit("message-edited", populated);
    }

    res.json(populated);
  } catch (error) {
    next(error);
  }
});

// Delete a message for everyone (sender only) — removes it for all participants
router.post("/:id/delete-for-everyone", authMiddleware, async (req, res, next) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.sender.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only delete your own messages",
      });
    }

    const conversationId = message.conversationId.toString();

    // Mark as deleted and wipe the content. The message stays in the DB so
    // everyone sees the "This message has been deleted" placeholder.
    message.deleted = true;
    message.text = "";
    message.file = { url: "", name: "", size: 0, mimeType: "" };
    message.editedAt = null;
    await message.save();

    const populated = await Message.findById(message._id).populate(
      "sender",
      "username avatar email"
    );

    // Show the placeholder on everyone's screen in real time
    if (req.io) {
      req.io.to(conversationId).emit("message-deleted", populated);
    }

    res.json(populated);
  } catch (error) {
    next(error);
  }
});

// Delete a message for the current user only (any participant)
router.post("/:id/delete-for-me", authMiddleware, async (req, res, next) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    // The user must be part of the conversation
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(403).json({
        message: "You are not part of this conversation",
      });
    }

    await Message.findByIdAndUpdate(message._id, {
      $addToSet: { deletedFor: req.user.id },
    });

    res.json({ message: "Message deleted for you" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
