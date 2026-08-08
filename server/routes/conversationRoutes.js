const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Conversation = require("../models/conversation");


// Create Conversation
router.post("/", authMiddleware, async (req, res) => {
    try {
        const { receiverId } = req.body;

        if (!receiverId) {
            return res.status(400).json({
                message: "Receiver ID is required"
            });
        }

        const conversation = await Conversation.create({
            participants: [
                req.user.id,
                receiverId
            ]
        });

        res.status(201).json(conversation);

    } catch (error) {

        console.log(error);

        res.status(500).json({
            message: "Server error",
            error: error.message
        });

    }
});


// Get all conversations
router.get("/", authMiddleware, async (req, res) => {
    try {

       const conversations = await Conversation.find({
  participants: req.user.id,
})
.populate("participants", "username avatar")
.sort({ updatedAt: -1 });

        res.json(conversations);

    } catch (error) {

        res.status(500).json({
            message: "Server error",
            error: error.message
        });

    }
});


module.exports = router;