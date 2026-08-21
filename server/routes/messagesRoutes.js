const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Message = require("../models/messages");
const Conversation = require("../models/conversation");
const { isBlockedPair } = require("../utils/blocked");

// Load a message with everything the client needs to render it.
const populateMessage = (id) =>
  Message.findById(id)
    .populate("sender", "username avatar handle status")
    .populate("reactions.user", "username avatar handle status")
    .populate({
      path: "replyTo",
      populate: { path: "sender", select: "username avatar handle status" },
    })
    .populate({
      path: "forwardedFrom",
      populate: { path: "sender", select: "username avatar handle status" },
    });

// Send Message
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const {
      conversationId,
      text = "",
      type = "text",
      file,
      replyTo,
      poll,
      duration = 0,
      viewOnce = false,
    } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        message: "conversationId is required",
      });
    }

    const trimmedText = typeof text === "string" ? text.trim() : "";
    const hasText = trimmedText.length > 0;
    const hasFile = file && file.url;
    const isTextType = type === "text";
    const isPoll = type === "poll";
    const hasPoll =
      isPoll && poll && poll.question && Array.isArray(poll.options);

    if (!hasText && !hasFile && !hasPoll) {
      return res.status(400).json({
        message: "Message content is required",
      });
    }

    if (isTextType && !hasText) {
      return res.status(400).json({
        message: "Message text is required",
      });
    }

    // Validate poll payload (2-10 non-empty options)
    if (isPoll) {
      const question = (poll.question || "").trim();
      const options = (poll.options || [])
        .map((o) => (o && o.text ? String(o.text).trim() : ""))
        .filter(Boolean);

      if (!question) {
        return res.status(400).json({ message: "Poll question is required" });
      }
      if (options.length < 2) {
        return res.status(400).json({ message: "Add at least 2 options" });
      }
      if (options.length > 10) {
        return res.status(400).json({ message: "Maximum 10 options" });
      }
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
      text: isPoll ? "" : trimmedText,
      type: isTextType ? "text" : type,
      ...(file ? { file } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(duration ? { duration: Number(duration) } : {}),
      ...(viewOnce ? { viewOnce: true } : {}),
      // Polls store their question/options under `poll`
      ...(isPoll
        ? {
            poll: {
              question: (poll.question || "").trim(),
              multi: !!poll.multi,
              options: (poll.options || [])
                .map((o) =>
                  o && o.text ? String(o.text).trim() : ""
                )
                .filter(Boolean)
                .map((text) => ({ text, votes: [] })),
            },
          }
        : {}),
      // Disappearing chats: stamp when this message should self-destruct
      ...(conversation.disappearTime > 0
        ? {
            expiresAt: new Date(
              Date.now() + conversation.disappearTime * 1000
            ),
          }
        : {}),
    });

    // Update the conversation's last message so the sidebar can show it
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: message._id,
    });

    const populated = await populateMessage(message._id);

    res.status(201).json(populated);
  } catch (error) {
    next(error);
  }
});

// Forward a message to another conversation (text / image / file / voice only).
// View-once media cannot be forwarded.
router.post("/forward", authMiddleware, async (req, res, next) => {
  try {
    const { messageId, conversationId } = req.body;

    if (!messageId || !conversationId) {
      return res.status(400).json({
        message: "messageId and conversationId are required",
      });
    }

    const original = await Message.findById(messageId);

    if (!original) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (original.deleted) {
      return res.status(400).json({
        message: "Cannot forward a deleted message",
      });
    }

    if (original.viewOnce) {
      return res.status(400).json({
        message: "View-once messages cannot be forwarded",
      });
    }

    if (!["text", "image", "file", "voice", "video"].includes(original.type)) {
      return res.status(400).json({ message: "This message cannot be forwarded" });
    }

    // The forwarder must be a participant of the source conversation
    const source = await Conversation.findOne({
      _id: original.conversationId,
      participants: req.user.id,
    });

    if (!source) {
      return res.status(403).json({
        message: "You are not part of this conversation",
      });
    }

    // ...and of the target conversation
    const target = await Conversation.findOne({
      _id: conversationId,
      participants: req.user.id,
    });

    if (!target) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    // Blocked check for private targets
    if (target.type === "private") {
      const otherId = target.participants.find(
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
      type: original.type,
      text: original.text,
      ...(original.file && original.file.url ? { file: original.file } : {}),
      ...(original.type === "voice" ? { duration: original.duration } : {}),
      forwardedFrom: original._id,
      // Disappearing chats: stamp when the forwarded copy should self-destruct
      ...(target.disappearTime > 0
        ? {
            expiresAt: new Date(
              Date.now() + target.disappearTime * 1000
            ),
          }
        : {}),
    });

    // Update the target conversation's last message so the sidebar reflects it
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: message._id,
    });

    const populated = await populateMessage(message._id);

    // Show it live to everyone in the target conversation room
    if (req.io) {
      req.io.to(conversationId).emit("receive-message", populated);
    }

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

    // Pagination: latest `limit` messages, or the `limit` older than the
    // `before` cursor (an ObjectId). One extra row tells us if more exist.
    const PAGE = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
    const before = req.query.before;

    const baseFilter = {
      conversationId: req.params.conversationId,
      deletedFor: { $nin: [req.user.id] },
      // Skip messages that already self-destructed (disappearing chats)
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    };
    if (before) {
      baseFilter._id = { $lt: before };
    }

    const fetched = await Message.find(baseFilter)
      .populate("sender", "username avatar handle status")
      .populate("reactions.user", "username avatar handle status")
      .populate({
        path: "replyTo",
        populate: { path: "sender", select: "username avatar handle status" },
      })
      .populate({
        path: "forwardedFrom",
        populate: { path: "sender", select: "username avatar handle status" },
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(PAGE + 1);

    const hasMore = fetched.length > PAGE;
    const messages = (hasMore ? fetched.slice(0, PAGE) : fetched).reverse();

    res.json({ messages, hasMore });
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

    const populated = await populateMessage(message._id);

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

// Delete a message for everyone (sender only) â€” removes it for all participants
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
    message.reactions = [];
    message.starredBy = [];
    await message.save();

    const populated = await populateMessage(message._id);

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

// Toggle an emoji reaction on a message (add / switch / remove)
router.put("/:id/reactions", authMiddleware, async (req, res, next) => {
  try {
    const { emoji } = req.body;

    if (typeof emoji !== "string" || !emoji.trim()) {
      return res.status(400).json({ message: "emoji is required" });
    }

    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.deleted) {
      return res.status(400).json({ message: "Cannot react to a deleted message" });
    }

    // The user must be part of the conversation
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(403).json({ message: "You are not part of this conversation" });
    }

    const idx = message.reactions.findIndex(
      (r) => r.user.toString() === req.user.id
    );

    if (idx === -1) {
      message.reactions.push({ user: req.user.id, emoji: emoji.trim() });
    } else if (message.reactions[idx].emoji === emoji.trim()) {
      // Tapping the same emoji again removes it
      message.reactions.splice(idx, 1);
    } else {
      message.reactions[idx].emoji = emoji.trim();
    }

    await message.save();

    const populated = await populateMessage(message._id);

    if (req.io) {
      req.io
        .to(message.conversationId.toString())
        .emit("message-reaction", populated);
    }

    res.json(populated);
  } catch (error) {
    next(error);
  }
});

// Star / unstar a message (personal bookmark for the current user)
router.post("/:id/star", authMiddleware, async (req, res, next) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.deleted) {
      return res.status(400).json({ message: "Cannot star a deleted message" });
    }

    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(403).json({ message: "You are not part of this conversation" });
    }

    const userId = req.user.id;
    const idx = (message.starredBy || []).findIndex(
      (s) => s.toString() === userId
    );

    if (idx === -1) {
      message.starredBy.push(userId);
    } else {
      message.starredBy.splice(idx, 1);
    }

    await message.save();

    const populated = await populateMessage(message._id);

    res.json(populated);
  } catch (error) {
    next(error);
  }
});

// Vote on a poll (tapping the same option again removes the vote)
router.post("/:id/vote", authMiddleware, async (req, res, next) => {
  try {
    const optionIndex = Number(req.body.optionIndex);

    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.type !== "poll" || !message.poll) {
      return res.status(400).json({ message: "Not a poll" });
    }

    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(403).json({ message: "You are not part of this conversation" });
    }

    const options = message.poll.options;
    if (!options[optionIndex] || !options[optionIndex].text) {
      return res.status(400).json({ message: "Invalid option" });
    }

    const hadVoted = (options[optionIndex].votes || []).some(
      (v) => v.toString() === req.user.id
    );

    if (message.poll.multi) {
      // Multiple answers allowed: only toggle the clicked option.
      options[optionIndex].votes = hadVoted
        ? (options[optionIndex].votes || []).filter(
            (v) => v.toString() !== req.user.id
          )
        : [...(options[optionIndex].votes || []), req.user.id];
    } else {
      // Single answer: remove the user's vote from every option...
      message.poll.options.forEach((o) => {
        o.votes = (o.votes || []).filter((v) => v.toString() !== req.user.id);
      });

      // ...then add it back unless they were just removing their vote.
      if (!hadVoted) {
        options[optionIndex].votes.push(req.user.id);
      }
    }

    await message.save();

    const populated = await populateMessage(message._id);

    if (req.io) {
      req.io.to(message.conversationId.toString()).emit("message-vote", populated);
    }

    res.json(populated);
  } catch (error) {
    next(error);
  }
});

// Consume a view-once message: the file URL is wiped for everyone.
router.post("/:id/consume-view", authMiddleware, async (req, res, next) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.viewOnce) {
      return res.status(400).json({ message: "Not a view-once message" });
    }

    // Only the recipient(s) can open a view-once message, never the sender.
    if (message.sender && message.sender.toString() === req.user.id) {
      return res.status(403).json({
        message: "You cannot open your own view-once message",
      });
    }

    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(403).json({ message: "You are not part of this conversation" });
    }

    if (!message.viewedOnce) {
      message.viewedOnce = true;
      message.file.url = "";
      await message.save();

      const populated = await populateMessage(message._id);

      if (req.io) {
        req.io
          .to(message.conversationId.toString())
          .emit("message-viewed-once", populated);
      }
    }

    res.json(await populateMessage(message._id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
