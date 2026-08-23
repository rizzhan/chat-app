const User = require("../models/user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const validator = require("validator");

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || "1d" });
};

// Make a unique handle from a username (e.g. "John Doe" -> "johndoe").
// Appends a number if the handle is already taken.
const generateHandle = async (base) => {
  const cleaned = (base || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 15);

  let handle = cleaned || "user";

  for (let i = 0; i < 25; i++) {
    if (!(await User.findOne({ handle }))) return handle;
    handle = `${cleaned || "user"}${Math.floor(100 + Math.random() * 900)}`;
  }

  return handle;
};

// Register User
const registerUser = async (req, res, next) => {
  try {
    let { username, email, password, handle } = req.body;

    // Type guard: all fields must be strings
    if (typeof username !== "string" || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "All fields must be text" });
    }
    if (handle !== undefined && typeof handle !== "string") {
      return res.status(400).json({ message: "Handle must be text" });
    }

    // Check if all fields are filled
    if (!username || !email || !password) {
      return res.status(400).json({
        message: "Please fill all fields",
      });
    }

    username = username.trim();
    email = email.trim().toLowerCase();
    if (handle) handle = handle.trim().toLowerCase();

    // Validate username length
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({
        message: "Username must be between 3 and 20 characters",
      });
    }

    // Validate handle format (optional field, else auto-generated)
    if (handle) {
      handle = handle.replace(/^@/, "");
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
        return res.status(400).json({
          message: "Handle must be 3-20 characters (letters, numbers, _)",
        });
      }
      if (await User.findOne({ handle })) {
        return res.status(400).json({
          message: "Handle already taken",
        });
      }
    }

    // Validate email format
    if (!validator.isEmail(email)) {
      return res.status(400).json({
        message: "Please provide a valid email",
      });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    // Check if email already exists
    const emailExists = await User.findOne({ email });

    if (emailExists) {
      return res.status(400).json({
        message: "Email already registered",
      });
    }

    // Check if username already exists
    const usernameExists = await User.findOne({ username });

    if (usernameExists) {
      return res.status(400).json({
        message: "Username already taken",
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      handle: handle || (await generateHandle(username)),
    });

    // Auto-login after registration
    const token = generateToken(user._id);

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        handle: user.handle,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Login User
const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Type guard: fields must be strings
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "All fields must be text" });
    }

    // Check if email and password are provided
    if (!email || !password) {
      return res.status(400).json({
        message: "Please fill all fields",
      });
    }

    // Find user
    const user = await User.findOne({ email: email.trim().toLowerCase() });

    if (!user) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    // Backfill a handle for accounts created before handles existed.
    if (!user.handle) {
      user.handle = await generateHandle(user.username);
      await user.save();
    }

    // Generate JWT
    const token = generateToken(user._id);

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        handle: user.handle,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerUser,
  loginUser,
};
