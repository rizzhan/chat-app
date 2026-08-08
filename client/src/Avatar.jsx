import { SERVER_URL } from "./api";

// Shows a profile picture, or the user's initials if they have no photo.
function Avatar({ user, small, large }) {
  const name = user?.username || "?";
  const cls =
    "avatar" +
    (small ? " avatar-small" : "") +
    (large ? " avatar-large" : "");

  if (user?.avatar) {
    return <img className={cls} src={SERVER_URL + user.avatar} alt={name} />;
  }

  return <div className={cls}>{name.slice(0, 2).toUpperCase()}</div>;
}

export default Avatar;
