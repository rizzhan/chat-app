const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
        },

        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        // "text" = normal message, "image" = picture, "video" = video clip,
        // "file" = attachment, "poll" = poll message, "voice" = voice note
        type: {
            type: String,
            enum: ["text", "image", "file", "poll", "voice", "video"],
            default: "text",
        },

        // The text itself (or a caption). Empty for images/files.
        text: {
            type: String,
            trim: true,
            default: "",
        },

        // Uploaded file information (for image/file messages)
        file: {
            url: { type: String, default: "" },
            name: { type: String, default: "" },
            size: { type: Number, default: 0 },
            mimeType: { type: String, default: "" },
        },

        // User IDs who have seen this message
        readBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // When the sender edited the message (null = never edited)
        editedAt: {
            type: Date,
            default: null,
        },

        // True when deleted for everyone (kept in DB to show a placeholder)
        deleted: {
            type: Boolean,
            default: false,
        },

        // User IDs who deleted this message for themselves
        deletedFor: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // Emoji reactions (one per user per message)
        reactions: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                emoji: { type: String, default: "" },
            },
        ],

        // The message this one is a reply to (null = not a reply)
        replyTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Message",
            default: null,
        },

        // The original message this one was forwarded from (null = not a forward)
        forwardedFrom: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Message",
            default: null,
        },

        // User IDs who starred this message (starring is personal)
        starredBy: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        // When the message disappears (null = never). Used by disappearing chats.
        expiresAt: {
            type: Date,
            default: null,
        },

        // Poll data (for type "poll" messages)
        poll: {
            question: { type: String, trim: true, default: "" },
            multi: { type: Boolean, default: false },
            options: [
                {
                    text: { type: String, trim: true, default: "" },
                    votes: [
                        {
                            type: mongoose.Schema.Types.ObjectId,
                            ref: "User",
                        },
                    ],
                },
            ],
        },

        // Voice note length in seconds (for type "voice" messages)
        duration: {
            type: Number,
            default: 0,
        },

        // View-once media: the file is wiped after someone opens it
        viewOnce: {
            type: Boolean,
            default: false,
        },

        // True once someone has opened the view-once media
        viewedOnce: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Message", messageSchema);
