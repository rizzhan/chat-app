// Shared state between the socket layer and the API routes.
// Maps userId -> value.
const onlineUsers = new Map(); // userId -> socketId
const lastSeen = new Map(); // userId -> timestamp (ms)

module.exports = { onlineUsers, lastSeen };
