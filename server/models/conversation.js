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

        // Who created the group (can remove members)
        admin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

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
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Conversation", conversationSchema);
