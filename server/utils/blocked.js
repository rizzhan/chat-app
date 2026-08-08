const User = require("../models/user");

// Returns true when either user has blocked the other (or either is missing).
const isBlockedPair = async (aId, bId) => {
  if (!aId || !bId) return true;

  const users = await User.find({ _id: { $in: [aId, bId] } }).select("blocked");
  const a = users.find((u) => u._id.toString() === aId.toString());
  const b = users.find((u) => u._id.toString() === bId.toString());

  if (!a || !b) return true;

  const aBlocked = (a.blocked || []).map((id) => id.toString());
  const bBlocked = (b.blocked || []).map((id) => id.toString());

  return (
    aBlocked.includes(bId.toString()) || bBlocked.includes(aId.toString())
  );
};

module.exports = { isBlockedPair };
