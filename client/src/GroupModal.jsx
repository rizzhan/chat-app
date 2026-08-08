import { useState } from "react";
import api from "./api";
import Avatar from "./Avatar";

function GroupModal({ mode, currentUser, conversationId, onClose, onCreate, onAddMembers }) {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async (e) => {
    const q = e.target.value;
    setSearch(q);

    if (!q.trim()) {
      setResults([]);
      return;
    }

    try {
      const res = await api.get(
        `/users/search?username=${encodeURIComponent(q.trim())}`
      );
      setResults(res.data.filter((u) => u._id !== currentUser.id));
    } catch {
      setResults([]);
    }
  };

  const toggle = (u) => {
    setSelected((prev) =>
      prev.some((x) => x._id === u._id)
        ? prev.filter((x) => x._id !== u._id)
        : [...prev, u]
    );
  };

  const submit = async () => {
    if (selected.length === 0) {
      setError("Select at least one member");
      return;
    }

    if (mode === "create" && !name.trim()) {
      setError("Group name is required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      if (mode === "create") {
        const res = await api.post("/conversations/group", {
          name: name.trim(),
          participantIds: selected.map((u) => u._id),
        });
        onCreate(res.data);
      } else {
        for (const u of selected) {
          await api.post(`/conversations/${conversationId}/members`, {
            userId: u._id,
          });
        }
        onAddMembers();
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "create" ? "New Group" : "Add Members"}</h3>

        {mode === "create" && (
          <input
            className="auth-input"
            placeholder="Group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}

        <input
          className="auth-input"
          placeholder="Search users..."
          value={search}
          onChange={handleSearch}
        />

        {selected.length > 0 && (
          <div className="selected-members">
            {selected.map((u) => (
              <span
                className="chip"
                key={u._id}
                onClick={() => toggle(u)}
              >
                {u.username} ✕
              </span>
            ))}
          </div>
        )}

        <div className="modal-user-list">
          {results.map((u) => {
            const isSel = selected.some((x) => x._id === u._id);
            return (
              <button
                key={u._id}
                className={"modal-user" + (isSel ? " selected" : "")}
                onClick={() => toggle(u)}
              >
                <Avatar user={u} small />
                <span className="modal-user-name">{u.username}</span>
                <span>{isSel ? "✓" : "+"}</span>
              </button>
            );
          })}
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="modal-actions">
          <button
            className="auth-button"
            onClick={submit}
            disabled={loading}
          >
            {loading
              ? "Please wait..."
              : mode === "create"
                ? "Create Group"
                : "Add Members"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default GroupModal;
