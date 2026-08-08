const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const initSocket = require("./sockets/socket");

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
const messageRoutes = require("./routes/messagesRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const friendRoutes = require("./routes/friendRoutes");

const { notFound, errorHandler } = require("./middleware/errormiddleware");

const app = express();
const server = http.createServer(app);
const io = initSocket(server);

// Make sure the uploads folder exists for saved files
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json());

// Give API routes access to the socket server (for real-time events)
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Serve uploaded files: http://localhost:5000/uploads/<filename>
app.use("/uploads", express.static(uploadsDir));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/friends", friendRoutes);

app.get("/", (req, res) => {
  res.send("Hello from the server!");
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Wait for the database before starting the server
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
});
