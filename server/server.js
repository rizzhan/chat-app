const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const initSocket = require("./sockets/socket");

// Fail fast if secrets are weak / missing — prevents shipping MySuperSecretKey123 to prod
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("❌ JWT_SECRET must be at least 32 characters. Generate with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
  process.exit(1);
}

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

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // allow /uploads to be loaded
  contentSecurityPolicy: false, // keep permissive for dev; tighten in prod with custom CSP
}));
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://localhost:5174,http://localhost:3000")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / mobile
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));
// Generic API rate limiter — 200 req / 15 min per IP
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

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
