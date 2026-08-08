const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();
const initSocket = require("./sockets/socket");

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
const messageRoutes = require("./routes/messagesRoutes");

const { notFound, errorHandler } = require("./middleware/errormiddleware");

const app = express();
const server = http.createServer(app);
const io = initSocket(server);

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);

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
