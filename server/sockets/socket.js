const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Message = require("../models/messages");
const Conversation = require("../models/conversation");

// Map of userId -> socketId for online users
const onlineUsers = new Map();

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

    // Send a message through Socket.IO
    socket.on("send-message", async (data, callback) => {
      try {
        const { conversationId, text } = data || {};

        if (!conversationId || !text || !text.trim()) {
          if (callback) callback({ error: "conversationId and text are required" });
          return;
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

        // Save the message to MongoDB
        const message = await Message.create({
          conversationId,
          sender: userId,
          text: text.trim(),
        });

        // Update the conversation's last message
        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: message._id,
        });

        const populated = await Message.findById(message._id).populate(
          "sender",
          "username avatar email"
        );

        // Broadcast to everyone in that conversation room (including sender)
        io.to(conversationId).emit("receive-message", populated);

        // Confirm to the sender that the message was saved
        if (callback) callback({ success: true, message: populated });
      } catch (error) {
        console.error("Socket send-message error:", error);
        if (callback) callback({ error: "Failed to send message" });
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

      // Tell every client who went offline
      io.emit("online-users", Array.from(onlineUsers.keys()));

      console.log("User disconnected:", userId);
    });
  });

  return io;
};

module.exports = initSocket;
