const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

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

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET
      );

      socket.user = decoded;

      next();
    } catch (error) {
      next(new Error("Invalid token"));
    }
  });

  // User connection
  io.on("connection", (socket) => {
    onlineUsers.set(socket.user.id, socket.id);

    console.log("User connected:", socket.user.id);
    console.log("Online users:", onlineUsers);

    // User disconnect
    socket.on("disconnect", () => {
      onlineUsers.delete(socket.user.id);

      console.log("User disconnected:", socket.user.id);
      console.log("Online users:", onlineUsers);
    });
  });

  return io;
};

module.exports = initSocket;