const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "Username is required"],
      trim: true,
      minlength: 3,
      maxlength: 20,
      unique: true,
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },

    // Unique handle (@username) used to find people. Auto-generated at signup.
    // sparse: accounts created before handles existed have no handle field.
    handle: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      default: "",
    },

    // Short profile status shown next to the user's name.
    status: {
      type: String,
      default: "",
      maxlength: 100,
      trim: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
    },

    avatar: {
      type: String,
      default: "",
    },

    // User IDs this user has blocked
    blocked: [
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

module.exports = mongoose.model("User", userSchema);