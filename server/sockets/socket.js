const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Message = require("../models/messages");
const Conversation = require("../models/conversation");
const { isBlockedPair } = require("../utils/blocked");

const { onlineUsers, lastSeen } = require("./state");

const initSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
    },
  });

  // Socket authentication
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      socket.data.userId = decoded.id;

      next();
    } catch (error) {
      next(new Error("Invalid token"));
    }
  });

  // User connection
  io.on("connection", (socket) => {
    const userId = socket.data.userId;

    onlineUsers.set(userId, socket.id);

    // Tell every client who is currently online
    io.emit("online-users", Array.from(onlineUsers.keys()));

    console.log("User connected:", userId);

    // Join a conversation room
    socket.on("join-conversation", (conversationId) => {
      if (!conversationId) return;

      socket.join(conversationId);
      console.log(`User ${userId} joined conversation ${conversationId}`);
    });

    // User started typing in a conversation (broadcast to everyone else there)
    socket.on("typing", ({ conversationId }) => {
      if (!conversationId) return;
      socket
        .to(conversationId)
        .emit("user-typing", { conversationId, userId });
    });

    // User stopped typing
    socket.on("stop-typing", ({ conversationId }) => {
      if (!conversationId) return;
      socket
        .to(conversationId)
        .emit("user-stop-typing", { conversationId, userId });
    });

    // Send a message through Socket.IO
    socket.on("send-message", async (data, callback) => {
      try {
        const {
          conversationId,
          text = "",
          type = "text",
          file = null,
          replyTo = null,
          poll = null,
          duration = 0,
          viewOnce = false,
        } = data || {};

        if (!conversationId) {
          if (callback) callback({ error: "conversationId is required" });
          return;
        }

        const trimmedText = typeof text === "string" ? text.trim() : "";
        const hasText = trimmedText.length > 0;
        const hasFile = file && file.url;
        const isTextType = type === "text";
        const isPoll = type === "poll";
        const hasPoll =
          isPoll && poll && poll.question && Array.isArray(poll.options);

        if (!hasText && !hasFile && !hasPoll) {
          if (callback) callback({ error: "Message content is required" });
          return;
        }

        if (isTextType && !hasText) {
          if (callback) callback({ error: "Message text is required" });
          return;
        }

        if (isPoll) {
          const question = (poll.question || "").trim();
          const options = (poll.options || [])
            .map((o) => (o && o.text ? String(o.text).trim() : ""))
            .filter(Boolean);
          if (!question) {
            if (callback) callback({ error: "Poll question is required" });
            return;
          }
          if (options.length < 2 || options.length > 10) {
            if (callback)
              callback({ error: "Polls need 2-10 options" });
            return;
          }
        }

        // Make sure the sender is a participant
        const conversation = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        });

        if (!conversation) {
          if (callback) callback({ error: "Conversation not found" });
          return;
        }

        // If this is a 1-to-1 chat, block messages from a user who is blocked
        if (conversation.type === "private") {
          const otherId = conversation.participants.find(
            (p) => p.toString() !== userId
          );
          if (otherId && (await isBlockedPair(userId, otherId))) {
            if (callback)
              callback({ error: "You cannot send messages to this user" });
            return;
          }
        }

        // Save the message to MongoDB
        const message = await Message.create({
          conversationId,
          sender: userId,
          text: isPoll ? "" : trimmedText,
          type: isTextType ? "text" : type,
          ...(file ? { file } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(duration ? { duration: Number(duration) } : {}),
          ...(viewOnce ? { viewOnce: true } : {}),
          ...(isPoll
            ? {
                poll: {
                  question: (poll.question || "").trim(),
                  options: (poll.options || [])
                    .map((o) => (o && o.text ? String(o.text).trim() : ""))
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

        // Update the conversation's last message
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: message._id,
        });

        const populated = await Message.findById(message._id)
          .populate("sender", "username avatar handle status")
          .populate({
            path: "replyTo",
            populate: { path: "sender", select: "username avatar handle status" },
          })
          .populate({
            path: "forwardedFrom",
            populate: { path: "sender", select: "username avatar handle status" },
          });

        // Broadcast to everyone in that conversation room (including sender)
        io.to(conversationId).emit("receive-message", populated);

        // Confirm to the sender that the message was saved
        if (callback) callback({ success: true, message: populated });
      } catch (error) {
        console.error("Socket send-message error:", error);
        if (callback) callback({ error: "Failed to send message" });
      }
    });

    // Mark messages as read in real time (when the reader is already viewing)
    socket.on("read-messages", async (conversationId) => {
      if (!conversationId) return;

      try {
        const result = await Message.updateMany(
          {
            conversationId,
            sender: { $ne: userId },
            readBy: { $ne: userId },
          },
          { $addToSet: { readBy: userId } }
        );

        if (result.modifiedCount > 0) {
          io.to(conversationId).emit("messages-read", {
            conversationId,
            readerId: userId,
          });
        }
      } catch (error) {
        console.error("Socket read-messages error:", error);
      }
    });

    // Leave a conversation room
    socket.on("leave-conversation", (conversationId) => {
      if (!conversationId) return;

      socket.leave(conversationId);
    });

    // User disconnect
    socket.on("disconnect", () => {
      onlineUsers.delete(userId);
      lastSeen.set(userId, Date.now());

      // Tell every client who went offline, and when
      io.emit("online-users", Array.from(onlineUsers.keys()));
      io.emit("user-offline", {
        userId,
        lastSeen: lastSeen.get(userId),
      });

      console.log("User disconnected:", userId);
    });
  });

  return io;
};

module.exports = initSocket;
