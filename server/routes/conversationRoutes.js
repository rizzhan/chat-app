const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authmiddleware");
const Conversation = require("../models/conversation");
const Message = require("../models/messages");
const { isBlockedPair } = require("../utils/blocked");
const { onlineUsers, lastSeen } = require("../sockets/state");

// Add online + last seen info to each participant, plus the current user's
// per-chat flags (favorite / pinned / archived).
const enrich = (conversations, unreadMap = {}, userId) =>
  conversations.map((c) => {
    const obj = c.toObject();
    obj.unreadCount = unreadMap[c._id.toString()] || 0;

    const uid = userId ? userId.toString() : "";
    const has = (arr) => (arr || []).some((id) => id.toString() === uid);
    obj.isFavorite = has(obj.favorites);
    obj.isPinned = has(obj.pinnedBy);
    obj.isArchived = has(obj.archivedBy);
    delete obj.favorites;
    delete obj.pinnedBy;
    delete obj.archivedBy;

    const themeEntry = (obj.themes || []).find(
      (t) => t.user && t.user.toString() === uid
    );
    obj.theme = themeEntry ? themeEntry.theme : "default";
    delete obj.themes;

    const muteEntry = (obj.mutedBy || []).find(
      (m) => m.user && m.user.toString() === uid
    );
    obj.muted = !!muteEntry;
    obj.mutedUntil = muteEntry ? muteEntry.until || null : null;
    delete obj.mutedBy;

    const bgEntry = (obj.backgrounds || []).find(
      (b) => b.user && b.user.toString() === uid
    );
    obj.background = bgEntry ? bgEntry.url || "" : "";
    delete obj.backgrounds;

    obj.participants = (obj.participants || []).map((p) => ({
      ...p,
      online: onlineUsers.has(p._id.toString()),
      lastSeen: lastSeen.get(p._id.toString()) || null,
    }));

    obj.isOwner = obj.admin ? obj.admin.toString() === uid : false;
    obj.isAdmin =
      obj.isOwner ||
      (obj.admins || []).some((a) => a.toString() === uid);

    return obj;
  });

// Group role helpers
const isOwner = (c, id) => !!c.admin && c.admin.toString() === String(id);
const isParticipant = (c, id) =>
  (c.participants || []).some((p) => p.toString() === String(id));
const isAdminUser = (c, id) =>
  isOwner(c, id) || (c.admins || []).some((a) => a.toString() === String(id));

// Count unread messages per conversation for a user
const getUnreadMap = async (conversationIds, userId) => {
  if (!conversationIds.length) return {};

  // Aggregation $match does NOT cast strings to ObjectIds, so do it manually.
  const oid = new mongoose.Types.ObjectId(userId);

  const unread = await Message.aggregate([
    {
      $match: {
        conversationId: { $in: conversationIds },
        sender: { $nin: [oid] },
        readBy: { $nin: [oid] },
      },
    },
    { $group: { _id: "$conversationId", count: { $sum: 1 } } },
  ]);

  const map = {};
  unread.forEach((u) => {
    map[u._id.toString()] = u.count;
  });
  return map;
};

// Create a private conversation (returns the existing one if it already exists)
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

    if (await isBlockedPair(req.user.id, receiverId)) {
      return res.status(403).json({
        message: "You cannot start a conversation with this user",
      });
    }

    // Prevent duplicate 1-to-1 conversations
    const existing = await Conversation.findOne({
      type: "private",
      participants: { $all: [req.user.id, receiverId] },
    })
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    if (existing) {
      return res.status(200).json(enrich([existing], {}, req.user.id)[0]);
    }

    const conversation = await Conversation.create({
      participants: [req.user.id, receiverId],
    });

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.status(201).json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Create a group conversation
router.post("/group", authMiddleware, async (req, res, next) => {
  try {
    const { name, participantIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        message: "Group name is required",
      });
    }

    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        message: "Select at least one member",
      });
    }

    // Combine the creator + selected members, remove duplicates
    const participants = [...new Set([req.user.id, ...participantIds])];

    if (participants.length < 2) {
      return res.status(400).json({
        message: "Select at least one other member",
      });
    }

    const conversation = await Conversation.create({
      type: "group",
      name: name.trim(),
      admin: req.user.id,
      participants,
    });

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.status(201).json(enrich([populated], {}, req.user.id)[0]);
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
      .populate("participants", "username avatar handle status")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    const unreadMap = await getUnreadMap(
      conversations.map((c) => c._id),
      req.user.id
    );

    res.json(enrich(conversations, unreadMap, req.user.id));
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
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    res.json(enrich([conversation], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Add a member to a group
router.post("/:conversationId/members", authMiddleware, async (req, res, next) => {
  try {
    const { userId } = req.body;
    const conversation = await Conversation.findById(req.params.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Not a group conversation" });
    }

    const isMember = conversation.participants.some(
      (p) => p.toString() === req.user.id
    );

    if (!isMember) {
      return res.status(403).json({ message: "You are not a member" });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    if (conversation.participants.some((p) => p.toString() === userId)) {
      return res.status(400).json({ message: "Already a member" });
    }

    conversation.participants.push(userId);
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    req.io?.to(conversation._id.toString()).emit("conversation-updated", {
      conversationId: conversation._id.toString(),
    });

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Remove a member from a group
// - Any member can leave themselves
// - Admins / owner can remove regular members
// - The owner leaving hands ownership to another admin/member first
router.delete("/:conversationId/members/:userId", authMiddleware, async (req, res, next) => {
  try {
    const conversation = await Conversation.findById(req.params.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Not a group conversation" });
    }

    const targetId = req.params.userId;
    const isSelf = targetId === req.user.id;
    const targetIsOwner = isOwner(conversation, targetId);
    const targetIsAdmin = isAdminUser(conversation, targetId);

    if (!isParticipant(conversation, targetId)) {
      return res.status(400).json({ message: "Not a member" });
    }

    if (!isSelf) {
      // Removing someone else requires owner or admin
      if (!isAdminUser(conversation, req.user.id)) {
        return res.status(403).json({
          message: "Only group admins can remove members",
        });
      }

      // Admins cannot remove the owner or other admins
      if (targetIsOwner || targetIsAdmin) {
        return res.status(403).json({
          message: "You cannot remove the owner or another admin",
        });
      }
    }

    // Leaving admins lose their admin status
    conversation.admins = (conversation.admins || []).filter(
      (a) => a.toString() !== targetId
    );

    conversation.participants = conversation.participants.filter(
      (p) => p.toString() !== targetId
    );

    // If the owner left, hand ownership to the first admin / member
    if (targetIsOwner) {
      const nextOwner =
        (conversation.admins && conversation.admins[0]) ||
        conversation.participants[0];
      conversation.admin = nextOwner || null;
      if (nextOwner) {
        conversation.admins = (conversation.admins || []).filter(
          (a) => a.toString() !== nextOwner.toString()
        );
      }
    }

    await conversation.save();

    // Kick the removed user out of the socket room and tell them
    const removedSocketId = onlineUsers.get(targetId);
    if (removedSocketId) {
      const removedSocket = req.io?.sockets.sockets.get(removedSocketId);
      removedSocket?.leave(conversation._id.toString());
      req.io?.to(removedSocketId).emit("removed-from-group", {
        conversationId: conversation._id.toString(),
      });
    }

    // Tell everyone still in the group that its info changed
    req.io?.to(conversation._id.toString()).emit("conversation-updated", {
      conversationId: conversation._id.toString(),
    });

    res.json({ message: "Member removed" });
  } catch (error) {
    next(error);
  }
});

// Rename a group (owner or admin)
router.put("/:conversationId/name", authMiddleware, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Group name is required" });
    }

    const conversation = await Conversation.findById(req.params.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Not a group conversation" });
    }

    if (!isAdminUser(conversation, req.user.id)) {
      return res.status(403).json({
        message: "Only group admins can rename the group",
      });
    }

    conversation.name = name.trim();
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    req.io?.to(conversation._id.toString()).emit("conversation-updated", {
      conversationId: conversation._id.toString(),
    });

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Promote or demote an admin (owner only)
router.post("/:conversationId/admins", authMiddleware, async (req, res, next) => {
  try {
    const { userId, action } = req.body;
    const conversation = await Conversation.findById(req.params.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Not a group conversation" });
    }

    if (!isOwner(conversation, req.user.id)) {
      return res.status(403).json({
        message: "Only the group owner can change admins",
      });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    if (!isParticipant(conversation, userId)) {
      return res.status(400).json({ message: "User is not a member" });
    }

    if (isOwner(conversation, userId)) {
      return res.status(400).json({ message: "The owner is already the group owner" });
    }

    conversation.admins = conversation.admins || [];

    if (action === "promote") {
      if (conversation.admins.some((a) => a.toString() === userId)) {
        return res.status(400).json({ message: "Already an admin" });
      }
      conversation.admins.push(userId);
    } else if (action === "demote") {
      conversation.admins = conversation.admins.filter(
        (a) => a.toString() !== userId
      );
    } else {
      return res.status(400).json({ message: "action must be promote or demote" });
    }

    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    req.io?.to(conversation._id.toString()).emit("conversation-updated", {
      conversationId: conversation._id.toString(),
    });

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Transfer group ownership (owner only; old owner stays as an admin)
router.post("/:conversationId/transfer", authMiddleware, async (req, res, next) => {
  try {
    const { userId } = req.body;
    const conversation = await Conversation.findById(req.params.conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Not a group conversation" });
    }

    if (!isOwner(conversation, req.user.id)) {
      return res.status(403).json({
        message: "Only the group owner can transfer ownership",
      });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    if (!isParticipant(conversation, userId)) {
      return res.status(400).json({ message: "User is not a member" });
    }

    if (isOwner(conversation, userId)) {
      return res.status(400).json({ message: "That user already owns the group" });
    }

    // New owner takes over; previous owner keeps admin rights
    conversation.admins = (conversation.admins || []).filter(
      (a) => a.toString() !== userId
    );
    conversation.admins.push(req.user.id);
    conversation.admin = userId;

    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    req.io?.to(conversation._id.toString()).emit("conversation-updated", {
      conversationId: conversation._id.toString(),
    });

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Toggle a per-user flag on a conversation (pinned / archived / favorite)
const toggleFlag = async (req, res, next, field) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const arr = conversation[field];
    const idx = arr.findIndex((id) => id.toString() === req.user.id);

    if (idx === -1) {
      arr.push(req.user.id);
    } else {
      arr.splice(idx, 1);
    }

    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
};

// Delete a conversation (and all of its messages)
router.delete("/:conversationId", authMiddleware, async (req, res, next) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    await Message.deleteMany({ conversationId: conversation._id });
    await conversation.deleteOne();

    // Tell everyone still in that room to remove it from their sidebar
    req.io
      ?.to(conversation._id.toString())
      .emit("conversation-deleted", { conversationId: conversation._id.toString() });

    res.json({ message: "Conversation deleted" });
  } catch (error) {
    next(error);
  }
});

// Pin / unpin a chat
router.post("/:conversationId/pin", authMiddleware, (req, res, next) =>
  toggleFlag(req, res, next, "pinnedBy")
);

// Archive / unarchive a chat
router.post("/:conversationId/archive", authMiddleware, (req, res, next) =>
  toggleFlag(req, res, next, "archivedBy")
);

// Add to / remove from favorites
router.post("/:conversationId/favorite", authMiddleware, (req, res, next) =>
  toggleFlag(req, res, next, "favorites")
);

// Set the chat theme for the current user
router.post("/:conversationId/theme", authMiddleware, async (req, res, next) => {
  try {
    const { theme } = req.body;
    const valid = ["default", "blue", "green", "purple", "pink", "dark"];

    if (!valid.includes(theme)) {
      return res.status(400).json({ message: "Invalid theme" });
    }

    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    conversation.themes = conversation.themes.filter(
      (t) => t.user.toString() !== req.user.id
    );
    if (theme !== "default") {
      conversation.themes.push({ user: req.user.id, theme });
    }
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Set the chat background image for the current user (url "" = remove it)
router.post("/:conversationId/background", authMiddleware, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (typeof url !== "string") {
      return res.status(400).json({ message: "url is required" });
    }

    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    conversation.backgrounds = conversation.backgrounds.filter(
      (b) => b.user.toString() !== req.user.id
    );
    if (url.trim()) {
      conversation.backgrounds.push({ user: req.user.id, url: url.trim() });
    }
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Mute notifications for this chat ("8h", "1w" or "forever")
router.post("/:conversationId/mute", authMiddleware, async (req, res, next) => {
  try {
    const { duration } = req.body;
    const now = Date.now();
    const until =
      duration === "8h"
        ? new Date(now + 8 * 60 * 60 * 1000)
        : duration === "1w"
        ? new Date(now + 7 * 24 * 60 * 60 * 1000)
        : duration === "forever"
        ? null
        : undefined;

    if (until === undefined) {
      return res.status(400).json({ message: "Invalid mute duration" });
    }

    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    conversation.mutedBy = conversation.mutedBy.filter(
      (m) => m.user.toString() !== req.user.id
    );
    conversation.mutedBy.push({ user: req.user.id, until });
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Unmute notifications for this chat
router.post("/:conversationId/unmute", authMiddleware, async (req, res, next) => {  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      participants: req.user.id,
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    conversation.mutedBy = conversation.mutedBy.filter(
      (m) => m.user.toString() !== req.user.id
    );
    await conversation.save();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "username avatar handle status")
      .populate("lastMessage");

    res.json(enrich([populated], {}, req.user.id)[0]);
  } catch (error) {
    next(error);
  }
});

// Turn disappearing messages on/off for a chat (0 = off, otherwise seconds)
router.post(
  "/:conversationId/disappear",
  authMiddleware,
  async (req, res, next) => {
    try {
      const { seconds } = req.body;
      const valid = [0, 86400, 604800, 7776000]; // off, 24h, 7d, 90d

      if (!valid.includes(Number(seconds))) {
        return res.status(400).json({ message: "Invalid disappearing time" });
      }

      const conversation = await Conversation.findOne({
        _id: req.params.conversationId,
        participants: req.user.id,
      });

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      conversation.disappearTime = Number(seconds);
      await conversation.save();

      const convId = conversation._id.toString();

      if (Number(seconds) > 0) {
        // Give existing messages an expiry too, so everything disappears.
        const expiry = new Date(Date.now() + Number(seconds) * 1000);
        await Message.updateMany(
          { conversationId: convId, expiresAt: null },
          { expiresAt: expiry }
        );
      } else {
        await Message.updateMany({ conversationId: convId }, { expiresAt: null });
      }

      // Tell the other participants so their header shows the new setting
      if (req.io) {
        req.io.to(convId).emit("conversation-disappear", {
          conversationId: convId,
          disappearTime: conversation.disappearTime,
        });
      }

      const populated = await Conversation.findById(conversation._id)
        .populate("participants", "username avatar handle status")
        .populate("lastMessage");

      res.json(enrich([populated], {}, req.user.id)[0]);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
