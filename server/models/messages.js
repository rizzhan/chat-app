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

        // "text" = normal message, "image" = picture, "file" = attachment
        type: {
            type: String,
            enum: ["text", "image", "file"],
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
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Message", messageSchema);
