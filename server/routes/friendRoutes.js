const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authmiddleware");
const Friend = require("../models/friend");
const { isBlockedPair } = require("../utils/blocked");

// Send a friend request
router.post("/request", authMiddleware, async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ message: "You cannot add yourself" });
    }

    if (await isBlockedPair(req.user.id, userId)) {
      return res.status(403).json({
        message: "You cannot send a friend request to this user",
      });
    }

    const existing = await Friend.findOne({
      $or: [
        { requester: req.user.id, recipient: userId },
        { requester: userId, recipient: req.user.id },
      ],
    });

    if (existing) {
      if (existing.status === "accepted") {
        return res.status(400).json({ message: "Already friends" });
      }
      return res.status(400).json({ message: "Friend request already exists" });
    }

    const friend = await Friend.create({
      requester: req.user.id,
      recipient: userId,
    });

    res.status(201).json(friend);
  } catch (error) {
    next(error);
  }
});

// Get accepted friends
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const friends = await Friend.find({
      status: "accepted",
      $or: [{ requester: req.user.id }, { recipient: req.user.id }],
    })
      .populate("requester", "username avatar email")
      .populate("recipient", "username avatar email");

    const result = friends.map((f) => {
      const mine = f.requester._id.toString() === req.user.id;
      return {
        friendshipId: f._id,
        friend: mine ? f.recipient : f.requester,
      };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get incoming pending friend requests
router.get("/requests", authMiddleware, async (req, res, next) => {
  try {
    const requests = await Friend.find({
      recipient: req.user.id,
      status: "pending",
    }).populate("requester", "username avatar email");

    res.json(requests);
  } catch (error) {
    next(error);
  }
});

// Accept or decline a friend request (friendshipId + accept: true/false)
router.post("/respond", authMiddleware, async (req, res, next) => {
  try {
    const { friendshipId, accept } = req.body;

    const friendRequest = await Friend.findById(friendshipId);

    if (!friendRequest) {
      return res.status(404).json({ message: "Friend request not found" });
    }

    if (friendRequest.recipient.toString() !== req.user.id) {
      return res.status(403).json({ message: "This is not your request" });
    }

    if (!accept) {
      await Friend.findByIdAndDelete(friendshipId);
      return res.json({ message: "Request declined" });
    }

    friendRequest.status = "accepted";
    await friendRequest.save();

    res.json({ message: "Friend request accepted", friendshipId });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
