const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
    {
        // "private" = 1-to-1 chat, "group" = many people
        type: {
            type: String,
            enum: ["private", "group"],
            default: "private",
        },

        // Group name (empty for private chats)
        name: {
            type: String,
            trim: true,
            default: "",
        },

        // Who created the group (can remove members / change admins)
        admin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        // Additional group admins (the owner is stored in `admin`).
        // Admins can rename the group and remove regular members.
        admins: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        participants: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            }
        ],

        lastMessage: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Message",
            default: null,
        },

        // User IDs who added this chat to their favorites
        favorites: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // User IDs who pinned this chat (pinned chats sort to the top)
        pinnedBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // User IDs who archived this chat (hidden from the main list)
        archivedBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // Per-user chat theme choice (value stored next to the user id)
        themes: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                theme: { type: String, default: "default" },
            },
        ],

        // Per-user mute settings (until = null means muted forever)
        mutedBy: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                until: { type: Date, default: null },
            },
        ],

        // Per-user chat background image (url empty string = none)
        backgrounds: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                url: { type: String, default: "" },
            },
        ],

        // Disappearing messages: 0 = off, otherwise lifetime in seconds
        // (e.g. 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days)
        disappearTime: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Conversation", conversationSchema);
