const multer = require("multer");
const path = require("path");

// Files are saved to server/uploads with a unique name.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../uploads"));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/webm", "audio/wav", "audio/ogg",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const IMAGE_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

const ALLOWED_EXT = new Set([
  ".jpg",".jpeg",".png",".webp",".gif",".mp4",".webm",".mov",
  ".mp3",".wav",".ogg",".pdf",".doc",".docx",".txt",
]);
const IMAGE_EXT = new Set([".jpg",".jpeg",".png",".webp",".gif"]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // max 10 MB per file
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    // allow fallback by extension for edge mime types
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`File type not allowed: ${file.mimetype} (${ext})`));
  },
});

// Image-only uploader for avatars and group pictures (max 2 MB)
const uploadImageOnly = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_MIME.has(file.mimetype)) return cb(null, true);
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Only images allowed: ${file.mimetype}`));
  },
});

module.exports = upload;
module.exports.uploadImageOnly = uploadImageOnly;
