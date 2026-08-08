const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const User = require("../models/user");


// Protected profile route
router.get("/profile", authMiddleware, (req, res) => {
    res.json({
        message: "Protected route accessed",
        user: req.user
    });
});


// Get all users
router.get("/", authMiddleware, async (req, res) => {
    try {
        const users = await User.find().select("-password");

        res.json(users);

    } catch (error) {
        res.status(500).json({
            message: "Server error"
        });
    }
});


module.exports = router;