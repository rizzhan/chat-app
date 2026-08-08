const User = require("../models/user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Register User
const registerUser = async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Check if all fields are filled
        if (!username || !email || !password) {
            return res.status(400).json({
                message: "Please fill all fields",
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
        });

        res.status(201).json({
            message: "User registered successfully",
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
            },
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Server Error",
        });
    }
};

// Login User
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check if email and password are provided
        if (!email || !password) {
            return res.status(400).json({
                message: "Please fill all fields",
            });
        }

        // Find user
        const user = await User.findOne({ email });

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

        // Generate JWT
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(200).json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
            },
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Server Error",
        });
    }
};

module.exports = {
    registerUser,
    loginUser,
};