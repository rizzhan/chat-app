const mongoose = require("mongoose");

const friendSchema = new mongoose.Schema(
    {
        requester: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        recipient: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        status: {
            type: String,
            enum: ["pending", "accepted"],
            default: "pending",
        },
    },
    {
        timestamps: true,
    }
);

// Prevent duplicate friend relationships (in either direction)
friendSchema.index({ requester: 1, recipient: 1 }, { unique: true });

module.exports = mongoose.model("Friend", friendSchema);
