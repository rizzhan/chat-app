const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Message = require("../models/messages");

// Send Message
router.post("/", authMiddleware, async (req, res) => {
    try {
        const { conversationId, text } = req.body;

        const message = await Message.create({
            conversationId,
            sender: req.user.id,
            text,
        });

        res.status(201).json(message);
    } catch (error) {
        console.log(error);
        res.status(500).json({
            message: "Server error",
        });
    }
});

// Get Messages
router.get("/:conversationId", authMiddleware, async (req, res) => {
    try {
        const messages = await Message.find({
  conversationId: req.params.conversationId,
})
  .populate("sender", "username avatar")
  .sort({ createdAt: 1 });
        res.status(200).json(messages);
    } catch (error) {
        console.log(error);
        res.status(500).json({
            message: "Server error",
        });
    }
});

module.exports = router;