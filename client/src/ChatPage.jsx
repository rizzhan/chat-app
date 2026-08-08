import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import api, { SERVER_URL } from "./api";
import Avatar from "./Avatar";
import EmojiPicker from "./EmojiPicker";
import GroupModal from "./GroupModal";

function ChatPage({ user, onLogout, onUpdateUser, dark, onToggleTheme }) {
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [lastSeenMap, setLastSeenMap] = useState({});
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unreadMap, setUnreadMap] = useState({});
  const [typingByConv, setTypingByConv] = useState({});
  const [atBottom, setAtBottom] = useState(true);

  // Message edit / delete UI state
  const [menuOpen, setMenuOpen] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Group + friends UI state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState("create");
  const [groupModalConversation, setGroupModalConversation] = useState(null);
  const [showRequests, setShowRequests] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [friendRequests, setFriendRequests] = useState([]);
  const [friends, setFriends] = useState([]);

  // Conversation filters (All / Favorites / Unread / Groups / Archived)
  const [filter, setFilter] = useState("all");
  const [convMenuOpen, setConvMenuOpen] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [profileUser, setProfileUser] = useState(null);
  const [showScrollbar, setShowScrollbar] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState(null);

  // In-chat message search (shown inside the profile modal)
  const [msgSearch, setMsgSearch] = useState("");
  const [msgMatchIndex, setMsgMatchIndex] = useState(0);

  // Chat header + extra modals
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [showMediaModal, setShowMediaModal] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showMutePicker, setShowMutePicker] = useState(false);
  const [showBackgroundPicker, setShowBackgroundPicker] = useState(false);
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const [profileFromChat, setProfileFromChat] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem("notifications") === "on"
  );

  const socketRef = useRef(null);
  const selectedConvRef = useRef(null);
  const userRef = useRef(user);
  const conversationsRef = useRef([]);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const messagesAreaRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  const scrollTimerRef = useRef(null);

  const filterBarRef = useRef(null);

  const filterScrollbarThumbRef = useRef(null);

  const filterScrollbarDragRef = useRef(null);
  // Keep the latest values in refs so socket listeners always see them.
  useEffect(() => {
    selectedConvRef.current = selectedConversation;
  }, [selectedConversation]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Close the ⋯ dropdowns (conversation list + message actions) on outside click.
  useEffect(() => {
    const onDocClick = (e) => {
      if (convMenuOpen && !e.target.closest(".conv-menu, .conv-more")) {
        setConvMenuOpen(null);
      }
      if (menuOpen && !e.target.closest(".message-menu, .more-button")) {
        setMenuOpen(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [convMenuOpen, menuOpen]);

  // Auto-clear the green notice after 3 seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- Socket.IO connection ----
  useEffect(() => {
    const token = localStorage.getItem("token");

    const newSocket = io("http://localhost:5000", {
      auth: { token },
    });

    socketRef.current = newSocket;

    newSocket.on("connect_error", (err) => {
      setError(`Socket error: ${err.message}`);
    });

    // List of online user IDs sent by the server whenever it changes.
    newSocket.on("online-users", (ids) => {
      setOnlineUsers(new Set(ids));
    });

    // Someone went offline. Remember their last seen time.
    newSocket.on("user-offline", ({ userId, lastSeen }) => {
      setLastSeenMap((prev) => ({ ...prev, [userId]: lastSeen }));
    });

    // A message arrived in a conversation room we are in.
    newSocket.on("receive-message", (msg) => {
      // Show a desktop notification when the chat is muted/not open/backgrounded.
      if (
        msg.conversationId !== selectedConvRef.current &&
        notificationsEnabledRef.current &&
        document.hidden &&
        ("Notification" in window) &&
        Notification.permission === "granted"
      ) {
        const conv = (conversationsRef.current || []).find(
          (c) => c._id === msg.conversationId
        );
        if (!conv || !isMutedNow(conv)) {
          const senderName = msg.sender?.username || "Someone";
          const title = conv?.type === "group" ? conv.name : senderName;
          const body =
            msg.type === "image"
              ? "📷 Photo"
              : msg.type === "file"
              ? `📎 ${msg.file?.name || "File"}`
              : msg.deleted
              ? "This message has been deleted"
              : msg.text;
          try {
            const n = new Notification(title, {
              body,
              tag: msg.conversationId,
            });
            n.onclick = () => {
              window.focus();
              n.close();
            };
          } catch {
            /* notifications unavailable */
          }
        }
      }

      // If it's the conversation currently on screen, show it immediately
      // and mark it as read in real time (so the sender sees blue ticks).
      if (msg.conversationId === selectedConvRef.current) {
        setMessages((prev) => [...prev, msg]);
        newSocket.emit("read-messages", msg.conversationId);
      } else {
        setUnreadMap((prev) => ({
          ...prev,
          [msg.conversationId]: (prev[msg.conversationId] || 0) + 1,
        }));
      }

      // Update the sidebar preview and re-sort (pinned first, then newest).
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c._id === msg.conversationId
            ? { ...c, lastMessage: msg, updatedAt: new Date().toISOString() }
            : c
        );
        return updated.sort((a, b) => {
          if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
      });
    });

    // Someone started typing in a conversation we're viewing.
    newSocket.on("user-typing", ({ conversationId, userId }) => {
      if (userId === userRef.current.id) return;
      setTypingByConv((prev) => {
        const list = prev[conversationId] || [];
        if (list.includes(userId)) return prev;
        return { ...prev, [conversationId]: [...list, userId] };
      });
    });

    // Someone stopped typing.
    newSocket.on("user-stop-typing", ({ conversationId, userId }) => {
      setTypingByConv((prev) => {
        const list = (prev[conversationId] || []).filter((id) => id !== userId);
        if (!list.length) {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        }
        return { ...prev, [conversationId]: list };
      });
    });

    // A message was edited. Update it in place on every screen.
    newSocket.on("message-edited", (updated) => {
      if (updated.conversationId === selectedConvRef.current) {
        setMessages((prev) =>
          prev.map((m) => (m._id === updated._id ? updated : m))
        );
      }

      setConversations((prev) =>
        prev.map((c) =>
          c._id === updated.conversationId &&
          c.lastMessage?._id === updated._id
            ? { ...c, lastMessage: updated }
            : c
        )
      );
    });

    // A message was deleted for everyone. Replace it with the placeholder.
    newSocket.on("message-deleted", (updated) => {
      if (updated.conversationId === selectedConvRef.current) {
        setMessages((prev) =>
          prev.map((m) => (m._id === updated._id ? updated : m))
        );
      }

      setConversations((prev) =>
        prev.map((c) =>
          c._id === updated.conversationId &&
          c.lastMessage?._id === updated._id
            ? { ...c, lastMessage: updated }
            : c
        )
      );
    });

    // Someone read messages in the current conversation. Update my ticks.
    newSocket.on("messages-read", ({ conversationId, readerId }) => {
      if (conversationId !== selectedConvRef.current) return;

      setMessages((prev) =>
        prev.map((m) =>
          m.sender?._id === userRef.current.id &&
          !(m.readBy || []).includes(readerId)
            ? { ...m, readBy: [...(m.readBy || []), readerId] }
            : m
        )
      );
    });

    // A conversation was deleted by someone in it. Remove it everywhere.
    newSocket.on("conversation-deleted", ({ conversationId }) => {
      setConversations((prev) =>
        prev.filter((c) => c._id !== conversationId)
      );
      if (selectedConvRef.current === conversationId) {
        setSelectedConversation(null);
        setMessages([]);
      }
    });

    return () => {
      newSocket.off("receive-message");
      newSocket.off("online-users");
      newSocket.off("user-offline");
      newSocket.off("messages-read");
      newSocket.off("user-typing");
      newSocket.off("user-stop-typing");
      newSocket.off("message-edited");
      newSocket.off("message-deleted");
      newSocket.off("conversation-deleted");
      newSocket.off("connect_error");
      newSocket.disconnect();
    };
  }, []);

  // Stop any pending timers when the page unmounts.
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  // ---- Load the user's conversations ----
  const loadConversations = async () => {
    try {
      const res = await api.get("/conversations");
      setConversations(sortConversations(res.data));

      // Seed "last seen" times and unread counts from the conversation data.
      const seen = {};
      const unread = {};
      res.data.forEach((c) => {
        (c.participants || []).forEach((p) => {
          if (p.lastSeen) seen[p._id] = p.lastSeen;
        });
        unread[c._id] = c.unreadCount || 0;
      });
      setLastSeenMap((prev) => ({ ...prev, ...seen }));
      setUnreadMap(unread);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  };

  const loadFriendRequests = async () => {
    try {
      const res = await api.get("/friends/requests");
      setFriendRequests(res.data);
    } catch {
      /* ignore */
    }
  };

  const loadFriends = async () => {
    try {
      const res = await api.get("/friends");
      setFriends(res.data);
    } catch {
      /* ignore */
    }
  };

  const loadBlockedUsers = async () => {
    try {
      const res = await api.get("/users/blocked");
      setBlockedUsers(res.data);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadConversations();
    loadFriendRequests();
    loadFriends();
    loadBlockedUsers();
  }, []);

  // ---- Smart scrolling ----
  // Track whether the user is scrolled to the bottom of the messages area.
  useEffect(() => {
    const el = messagesAreaRef.current;
    if (!el) return;

    const onScroll = () => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };

    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [selectedConversation]);

  // Jump to the bottom when opening a conversation.
  useEffect(() => {
    const el = messagesAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedConversation]);

  // Follow new messages only when the user is already at the bottom.
  useEffect(() => {
    const el = messagesAreaRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  // ---- Helpers ----
  const otherUser = (c) => {
    const others = (c.participants || []).filter(
      (p) => p && p._id !== user.id
    );
    return others[0] || {};
  };

  const isOnline = (id) => onlineUsers.has(id);

  const isProfileBlocked = (u) =>
    u ? blockedUsers.some((b) => b._id === u._id) : false;

  // A chat is "muted now" when it has a mute entry that hasn't expired
  // (a null mutedUntil means muted forever).
  const isMutedNow = (c) =>
    !!c?.muted &&
    (!c.mutedUntil || new Date(c.mutedUntil).getTime() > Date.now());

  const applyConvUpdate = (updated) =>
    setConversations((prev) =>
      sortConversations(
        prev.map((x) => (x._id === updated._id ? updated : x))
      )
    );

  const muteConversation = async (conv, duration) => {
    setChatMenuOpen(false);
    try {
      const res = await api.post(`/conversations/${conv._id}/mute`, {
        duration,
      });
      applyConvUpdate(res.data);
      setNotice("Notifications muted");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to mute notifications");
    }
  };

  const unmuteConversation = async (conv) => {
    setChatMenuOpen(false);
    try {
      const res = await api.post(`/conversations/${conv._id}/unmute`);
      applyConvUpdate(res.data);
      setNotice("Notifications unmuted");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to unmute notifications");
    }
  };

  const setChatTheme = async (conv, theme) => {
    setShowThemePicker(false);
    try {
      const res = await api.post(`/conversations/${conv._id}/theme`, { theme });
      applyConvUpdate(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to change chat theme");
    }
  };

  const setChatBackground = async (conv, url) => {
    setShowBackgroundPicker(false);
    try {
      const res = await api.post(`/conversations/${conv._id}/background`, {
        url,
      });
      applyConvUpdate(res.data);
      setNotice(url ? "Chat background updated" : "Chat background removed");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to change chat background");
    }
  };

  const handleBackgroundUpload = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !activeConv) return;
    setBackgroundUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/upload", formData);
      await setChatBackground(activeConv, res.data.url);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to upload background");
    } finally {
      setBackgroundUploading(false);
    }
  };

  // ---- Shared media / files / links ----
  const isLinkText = (t) =>
    /\bhttps?:\/\/[^\s<>]+/.test((t || "").replace(/\n/g, " "));

  const mediaList = useMemo(() => {
    return messages
      .filter((m) => !m.deleted)
      .map((m) => {
        let kind = "text";
        if (m.type === "image") kind = "image";
        else if (m.type === "file") kind = "file";
        else if (isLinkText(m.text)) kind = "link";
        return { ...m, kind };
      })
      .filter((m) => m.kind !== "text")
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [messages]);

  const mediaUrl = (m) =>
    m.kind === "link" ? m.text : SERVER_URL + (m.file?.url || "");

  const mediaTitle = (m) =>
    m.kind === "link"
      ? m.text
      : m.kind === "file"
      ? m.file?.name || "File"
      : "Photo";

  // Shorten a message to a small window around the first match.
  const snippet = (text) => {
    const q = msgSearch.trim();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + q.length + 45);
    return (
      (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "")
    );
  };

  // Jump to a search result: close the profile, then scroll the chat.
  const jumpToMatch = (mi) => {
    const i = msgMatches.indexOf(mi);
    if (i !== -1) setMsgMatchIndex(i);
    setProfileFromChat(false);
    setProfileUser(null);
    setTimeout(() => {
      const el = document.getElementById(`msg-${messages[mi]?._id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  };

  const formatTime = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatLastSeen = (ts) => {
    if (!ts) return "Offline";
    const diff = Date.now() - ts;
    if (diff < 60000) return "Active just now";
    const d = new Date(ts);
    const today = new Date();
    const sameDay =
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear();
    if (sameDay) {
      return `Last seen at ${d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }
    return `Last seen ${d.toLocaleDateString([], {
      day: "numeric",
      month: "short",
    })}`;
  };

  const statusText = (id) => {
    if (isOnline(id)) return "Online";
    return formatLastSeen(lastSeenMap[id]);
  };

  const isRead = (m) =>
    (m.readBy || []).some((id) => id !== user.id);

  const sameDay = (a, b) => {
    if (!a || !b) return false;
    const da = new Date(a);
    const db = new Date(b);
    return (
      da.getDate() === db.getDate() &&
      da.getMonth() === db.getMonth() &&
      da.getFullYear() === db.getFullYear()
    );
  };

  const formatDay = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date();
    if (sameDay(iso, today.toISOString())) return "Today";

    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(iso, yesterday.toISOString())) return "Yesterday";

    return d.toLocaleDateString([], {
      day: "numeric",
      month: "long",
      year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
    });
  };

  const formatListTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date();
    if (sameDay(iso, today.toISOString())) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(iso, yesterday.toISOString())) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  };

  const typingText = (conv) => {
    const ids = typingByConv[conv._id] || [];
    if (!ids.length) return "";

    if (conv.type === "group") {
      const names = ids
        .map((id) =>
          (conv.participants || []).find((p) => p._id === id)?.username
        )
        .filter(Boolean);
      return (names.length ? names.join(", ") : "Someone") + " typing…";
    }
    return "typing…";
  };

  // Pinned chats stay on top, then by most recent activity.
  const sortConversations = (list) =>
    [...list].sort((a, b) => {
      if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

  // ---- Pin / archive / favorite ----
  const toggleConversationFlag = async (c, action) => {
    setConvMenuOpen(null);
    try {
      const res = await api.post(`/conversations/${c._id}/${action}`);
      setConversations((prev) =>
        sortConversations(prev.map((x) => (x._id === c._id ? res.data : x)))
      );
      if (action === "archive") {
        setNotice(res.data.isArchived ? "Chat archived" : "Chat unarchived");
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update chat");
    }
  };

  const deleteChat = async (c) => {
    setConfirmDeleteChat(null);
    setConvMenuOpen(null);
    try {
      await api.delete(`/conversations/${c._id}`);
      setConversations((prev) => prev.filter((x) => x._id !== c._id));
      if (selectedConversation === c._id) {
        setSelectedConversation(null);
        setMessages([]);
      }
      setNotice("Chat deleted");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete chat");
    }
  };

  const blockUser = async (u) => {
    try {
      await api.post(`/users/${u._id}/block`);
      setProfileUser(null);
      setProfileFromChat(false);
      await loadBlockedUsers();
      setNotice(`${u.username} blocked`);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to block user");
    }
  };

  const unblockUser = async (u) => {
    try {
      await api.post(`/users/${u._id}/unblock`);
      setProfileUser(null);
      setProfileFromChat(false);
      await loadBlockedUsers();
      setNotice(`${u.username} unblocked`);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to unblock user");
    }
  };

  // ---- Search users ----
  const handleSearch = async (e) => {
    const q = e.target.value;
    setSearch(q);

    if (!q.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const res = await api.get(
        `/users/search?username=${encodeURIComponent(q.trim())}`
      );
      setSearchResults(res.data);
    } catch {
      setSearchResults([]);
    }
  };

  // ---- Start (or reopen) a conversation with a user ----
  const startConversation = async (u) => {
    try {
      const res = await api.post("/conversations", { receiverId: u._id });
      setSearch("");
      setSearchResults([]);
      await loadConversations();
      selectConversation(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to start conversation");
    }
  };

  // ---- Select a conversation and load its messages ----
  const selectConversation = async (c) => {
    socketRef.current?.emit("leave-conversation", selectedConvRef.current);
    setSelectedConversation(c._id);
    setMessages([]);
    setError("");
    socketRef.current?.emit("join-conversation", c._id);

    // Reset the in-chat search when moving between conversations.
    setMsgSearch("");
    setMsgMatchIndex(0);

    // Opening a conversation clears its unread count.
    setUnreadMap((prev) => ({ ...prev, [c._id]: 0 }));

    try {
      const res = await api.get(`/messages/${c._id}`);
      setMessages(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load messages");
    }
  };

  // ---- Typing indicator ----
  const stopTyping = () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = null;
    if (selectedConvRef.current) {
      socketRef.current?.emit("stop-typing", {
        conversationId: selectedConvRef.current,
      });
    }
  };

  const handleTyping = () => {
    if (!selectedConvRef.current) return;
    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit("typing", { conversationId: selectedConvRef.current });
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, 1500);
  };

  // ---- Send a message ----
  const sendViaApi = async (payload) => {
    const res = await api.post("/messages", {
      conversationId: selectedConversation,
      ...payload,
    });
    setMessages((prev) => [...prev, res.data]);
  };

  const sendSocket = (payload, fallback) => {
    const socket = socketRef.current;

    if (socket && socket.connected) {
      socket.emit("send-message", payload, (res) => {
        if (res && res.error) setError(res.error);
      });
    } else {
      fallback();
    }
  };

  const handleSend = (e) => {
    e.preventDefault();
    const text = newMessage.trim();

    if (!text || !selectedConversation) return;

    setNewMessage("");
    stopTyping();

    sendSocket(
      { conversationId: selectedConversation, text },
      () =>
        sendViaApi({ text }).catch((err) =>
          setError(err.response?.data?.message || "Failed to send message")
        )
    );
  };

  // ---- Upload and send a file / image ----
  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";

    if (!file || !selectedConversation) return;

    setUploading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await api.post("/upload", formData);
      const { url, name, size, mimeType } = res.data;
      const isImage = mimeType.startsWith("image/");
      const payload = {
        conversationId: selectedConversation,
        type: isImage ? "image" : "file",
        file: { url, name, size, mimeType },
      };

      sendSocket(
        payload,
        () =>
          sendViaApi({ type: isImage ? "image" : "file", file: payload.file }).catch(
            (err) => setError(err.response?.data?.message || "Failed to send file")
          )
      );
    } catch (err) {
      setError(err.response?.data?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ---- Profile picture ----
  const handleAvatarSelect = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";

    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await api.post("/users/avatar", formData);
      onUpdateUser(res.data);
      setNotice("Profile picture updated");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update profile picture");
    }
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await api.delete("/users/me");
      onLogout();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete account");
      setDeletingAccount(false);
      setConfirmDeleteAccount(false);
    }
  };

  const toggleNotifications = async () => {
    if (
      !notificationsEnabled &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        /* older browsers */
      }
    }
    const enabled = !notificationsEnabled;
    setNotificationsEnabled(enabled);
    localStorage.setItem("notifications", enabled ? "on" : "off");
    setNotice(
      enabled ? "Desktop notifications enabled" : "Desktop notifications disabled"
    );
  };

  // ---- Edit / delete messages ----
  const canEdit = (m) =>
    m.type === "text" &&
    Date.now() - new Date(m.createdAt).getTime() < 2 * 60 * 1000;

  const startEdit = (m) => {
    setMenuOpen(null);
    setEditingId(m._id);
    setEditText(m.text || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const saveEdit = async () => {
    const text = editText.trim();
    if (!text || !editingId) return;

    try {
      const res = await api.post(`/messages/${editingId}/edit`, { text });
      setMessages((prev) =>
        prev.map((m) => (m._id === editingId ? res.data : m))
      );
      setEditingId(null);
      setEditText("");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to edit message");
    }
  };

  const deleteForMe = async (m) => {
    setMenuOpen(null);
    try {
      await api.post(`/messages/${m._id}/delete-for-me`);
      setMessages((prev) => prev.filter((x) => x._id !== m._id));
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete message");
    }
  };

  const confirmDeleteForEveryone = async () => {
    const m = confirmDelete;
    setConfirmDelete(null);
    setMenuOpen(null);
    if (!m) return;

    try {
      const res = await api.post(`/messages/${m._id}/delete-for-everyone`);
      setMessages((prev) =>
        prev.map((x) => (x._id === m._id ? res.data : x))
      );
      setConversations((prev) =>
        prev.map((c) =>
          c._id === m.conversationId && c.lastMessage?._id === m._id
            ? { ...c, lastMessage: res.data }
            : c
        )
      );
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete message");
    }
  };

  // ---- Friends ----
  const sendFriendRequest = async (u) => {
    try {
      await api.post("/friends/request", { userId: u._id });
      setNotice(`Friend request sent to ${u.username}`);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to send request");
    }
  };

  const acceptRequest = async (fr) => {
    try {
      await api.post("/friends/respond", {
        friendshipId: fr._id,
        accept: true,
      });
      setFriendRequests((prev) => prev.filter((x) => x._id !== fr._id));
      setNotice(`You are now friends with ${fr.requester.username}`);
      loadFriends();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to accept request");
    }
  };

  const declineRequest = async (fr) => {
    try {
      await api.post("/friends/respond", {
        friendshipId: fr._id,
        accept: false,
      });
      setFriendRequests((prev) => prev.filter((x) => x._id !== fr._id));
    } catch (err) {
      setError(err.response?.data?.message || "Failed to decline request");
    }
  };

  // ---- Groups ----
  const openGroupModal = (mode = "create", conv = null) => {
    setGroupModalMode(mode);
    setGroupModalConversation(conv);
    setShowGroupModal(true);
  };

  const refreshAndSelect = async (conv) => {
    setSearch("");
    setSearchResults([]);
    await loadConversations();
    selectConversation(conv);
  };

  const leaveGroup = async (conv) => {
    try {
      await api.delete(`/conversations/${conv._id}/members/${user.id}`);
      setSelectedConversation(null);
      setMessages([]);
      setNotice("You left the group");
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to leave group");
    }
  };

  // ---- In-chat message search ----
  // Indexes of the messages (in `messages`) whose text matches the query.
  const msgMatches = useMemo(() => {
    const q = msgSearch.trim().toLowerCase();
    if (!q) return [];
    return messages
      .map((m, i) => ({ m, i }))
      .filter(
        ({ m }) =>
          m.type === "text" && !m.deleted && (m.text || "").toLowerCase().includes(q)
      )
      .map(({ i }) => i);
  }, [msgSearch, messages]);

  // Wrap every occurrence of the query in a <mark> for highlighting.
  const highlight = (text) => {
    const q = msgSearch.trim();
    if (!q) return text;
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    const parts = [];
    let start = 0;
    let idx = lower.indexOf(needle, start);
    while (idx !== -1) {
      if (idx > start) parts.push(text.slice(start, idx));
      parts.push(
        <mark key={idx}>{text.slice(idx, idx + needle.length)}</mark>
      );
      start = idx + needle.length;
      idx = lower.indexOf(needle, start);
    }
    if (start < text.length) parts.push(text.slice(start));
    return parts.length ? parts : text;
  };

  // ---- Message content rendering ----
  const renderContent = (m) => {
    if (m.deleted) {
      return (
        <div className="message-deleted">This message has been deleted</div>
      );
    }

    if (m.type === "image") {
      return (
        <a href={SERVER_URL + m.file?.url} target="_blank" rel="noreferrer">
          <img
            className="message-image"
            src={SERVER_URL + m.file?.url}
            alt={m.file?.name || "image"}
          />
        </a>
      );
    }

    if (m.type === "file") {
      return (
        <a
          className="message-file"
          href={SERVER_URL + m.file?.url}
          target="_blank"
          rel="noreferrer"
        >
          📎 {m.file?.name || "File"}
        </a>
      );
    }

    return <div className="message-text">{highlight(m.text)}</div>;
  };

  const previewText = (m) => {
    if (!m) return "No messages yet";
    if (m.deleted) return "This message has been deleted";
    if (m.type === "image") return "📷 Photo";
    if (m.type === "file") return `📎 ${m.file?.name || "File"}`;
    return (m.sender?._id === user.id ? "You: " : "") + m.text;
  };

  // ---- Render ----
  const isSearching = search.trim().length > 0;

  const archived = conversations.filter((c) => c.isArchived);
  const visible = conversations.filter((c) => !c.isArchived);
  const filtered =
    filter === "unread"
      ? visible.filter((c) => (unreadMap[c._id] || 0) > 0)
      : filter === "favorites"
      ? visible.filter((c) => c.isFavorite)
      : filter === "groups"
      ? visible.filter((c) => c.type === "group")
      : filter === "archived"
      ? archived
      : visible;

  const listEmptyHint =
    filter === "archived"
      ? "No archived chats."
      : filter === "unread"
      ? "No unread chats."
      : filter === "favorites"
      ? "No favorite chats yet. Use the ⋯ menu on a chat to add it."
      : filter === "groups"
      ? "No group chats yet. Click + Group to create one."
      : "No conversations yet. Search for a user above to start chatting.";

  const updateFilterScrollbar = () => {
    const bar = filterBarRef.current;
    const thumb = filterScrollbarThumbRef.current;
    if (!bar || !thumb) return;
    const trackWidth = bar.clientWidth;
    const scrollWidth = bar.scrollWidth;
    if (scrollWidth <= trackWidth) {
      thumb.style.width = "0px";
      return;
    }
    const thumbWidth = Math.max(24, (trackWidth / scrollWidth) * trackWidth);
    const maxThumbX = trackWidth - thumbWidth;
    const maxScroll = scrollWidth - trackWidth;
    const thumbX =
      maxScroll > 0 ? (bar.scrollLeft / maxScroll) * maxThumbX : 0;
    thumb.style.width = thumbWidth + "px";
    thumb.style.transform = "translateX(" + thumbX + "px)";
  };

  useEffect(() => {
    updateFilterScrollbar();
    const onResize = () => updateFilterScrollbar();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (showScrollbar) updateFilterScrollbar();
  }, [showScrollbar]);

  useEffect(() => {
    const move = (e) => {
      if (!filterScrollbarDragRef.current) return;
      const bar = filterBarRef.current;
      const trackWidth = bar.clientWidth;
      const scrollWidth = bar.scrollWidth;
      const thumbWidth = Math.max(24, (trackWidth / scrollWidth) * trackWidth);
      const maxThumbX = trackWidth - thumbWidth;
      const dx = e.clientX - filterScrollbarDragRef.current.startX;
      bar.scrollLeft =
        filterScrollbarDragRef.current.startScrollLeft +
        (dx / maxThumbX) * (scrollWidth - trackWidth);
    };
    const up = () => {
      filterScrollbarDragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const activeConv = conversations.find((c) => c._id === selectedConversation);
  const chatTheme = activeConv?.theme || "default";

  // The profile modal shows chat features (search + media) only when it was
  // opened from the header of the currently open conversation.
  const profileShowsChatInfo =
    profileFromChat &&
    !!profileUser &&
    !!activeConv &&
    otherUser(activeConv)?._id === profileUser?._id;

  return (
    <div className="chat-page">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="app-logo">ChatApp</span>
          <div className="sidebar-actions">
            <button
              className="icon-button"
              title="Settings"
              onClick={() => setShowSettings(true)}
            >
              ⚙️
            </button>
          </div>
        </div>

        <div className="sidebar-user">
          <label className="avatar-upload" title="Change profile picture">
            <Avatar user={user} small={false} />
            <span className="avatar-overlay">📷</span>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={handleAvatarSelect}
            />
          </label>
          <div className="sidebar-user-info">
            <div className="user-name">{user.username}</div>
            <div className="user-email">{user.email}</div>
          </div>
        </div>

        <div className="sidebar-tools">
          <button className="tool-button" onClick={() => setShowFriends(true)}>
            Friends
          </button>
          <button
            className="tool-button"
            onClick={() => {
              loadFriendRequests();
              setShowRequests(true);
            }}
          >
            Requests
            {friendRequests.length > 0 && (
              <span className="badge">{friendRequests.length}</span>
            )}
          </button>
          <button
            className="tool-button"
            onClick={() => openGroupModal("create")}
          >
            + Group
          </button>
        </div>

        <div className="search-box">
          <input
            type="text"
            placeholder="Search users..."
            value={search}
            onChange={handleSearch}
          />
        </div>

        <div
          className="filter-bar-wrap"
          onMouseEnter={() => {
            clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = setTimeout(
              () => setShowScrollbar(true),
              1200
            );
          }}
          onMouseLeave={() => {
            clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = setTimeout(
              () => setShowScrollbar(false),
              500
            );
          }}
        >
          <div
            ref={filterBarRef}
            className="filter-bar"
            onScroll={updateFilterScrollbar}
          >
            {["all", "unread", "favorites", "groups", "archived"].map((f) => (
              <button
                key={f}
                className={"filter-pill" + (filter === f ? " active" : "")}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div
            className={"filter-scrollbar" + (showScrollbar ? " visible" : "")}
          >
            <div
              ref={filterScrollbarThumbRef}
              className="filter-scrollbar-thumb"
              onMouseDown={(e) => {
                e.preventDefault();
                filterScrollbarDragRef.current = {
                  startX: e.clientX,
                  startScrollLeft: filterBarRef.current.scrollLeft,
                };
              }}
            />
          </div>
        </div>

        <div className="conversation-list">
          {isSearching ? (
            searchResults.length === 0 ? (
              <div className="empty-hint">No users found.</div>
            ) : (
              searchResults.map((u) => (
                <div
                  key={u._id}
                  className="conversation-item"
                  onClick={() => startConversation(u)}
                >
                  <Avatar user={u} />
                  <div className="conversation-info">
                    <div className="conversation-name">{u.username}</div>
                    <div className="conversation-preview">Start chat</div>
                  </div>
                  <button
                    className="mini-button"
                    title="Add friend"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendFriendRequest(u);
                    }}
                  >
                    ＋
                  </button>
                </div>
              ))
            )
          ) : loading ? (
            <div className="empty-hint">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="empty-hint">{listEmptyHint}</div>
          ) : (
            filtered.map((c) => {
              const isGroup = c.type === "group";
              const other = otherUser(c);
              const typingHere = (typingByConv[c._id] || []).length > 0;
              const unread = unreadMap[c._id] || 0;

              return (
                <div key={c._id} className="conversation-item-wrap">
                  <div
                    className={
                      "conversation-item" +
                      (c._id === selectedConversation ? " active" : "")
                    }
                    onClick={() => selectConversation(c)}
                  >
                    <Avatar
                      user={
                        isGroup
                          ? { username: c.name }
                          : { username: other.username, avatar: other.avatar }
                      }
                    />
                    <div className="conversation-info">
                      <div className="conversation-name">
                        {c.isPinned && (
                          <span className="pin-indicator" title="Pinned">
                            📌
                          </span>
                        )}
                        {isGroup ? "👥 " + c.name : other.username}
                      </div>
                      <div
                        className={
                          "conversation-preview" +
                          (typingHere ? " typing-preview" : "")
                        }
                      >
                        {typingHere ? "typing…" : previewText(c.lastMessage)}
                      </div>
                    </div>
                    <div className="conversation-right">
                      <span className="conversation-time">
                        {formatListTime(c.lastMessage?.createdAt)}
                      </span>
                      {unread > 0 && (
                        <span className="unread-badge">{unread}</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="conv-more"
                    title="More options"
                    onClick={() =>
                      setConvMenuOpen(convMenuOpen === c._id ? null : c._id)
                    }
                  >
                    ⋯
                  </button>
                  {convMenuOpen === c._id && (
                    <div className="conv-menu">
                      <button onClick={() => toggleConversationFlag(c, "pin")}>
                        {c.isPinned ? "Unpin chat" : "Pin chat"}
                      </button>
                      <button
                        onClick={() => toggleConversationFlag(c, "favorite")}
                      >
                        {c.isFavorite
                          ? "Remove from favorites"
                          : "Add to favorites"}
                      </button>
                      <button
                        onClick={() => toggleConversationFlag(c, "archive")}
                      >
                        {c.isArchived ? "Unarchive chat" : "Archive chat"}
                      </button>
                      {!isGroup && (
                        <button
                          onClick={() => {
                            setConvMenuOpen(null);
                            setProfileFromChat(false);
                            setProfileUser(other);
                          }}
                        >
                          View profile
                        </button>
                      )}
                      <button
                        className="conv-menu-danger"
                        onClick={() => setConfirmDeleteChat(c)}
                      >
                        Delete chat
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <main className={"chat-main chat-theme-" + chatTheme}>
        {!selectedConversation ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔒</div>
            <div className="empty-state-title">ChatApp</div>
            <div className="empty-state-text">
              Messages are end-to-end encrypted. No one outside of this chat,
              not even ChatApp, can read or listen to them.
            </div>
          </div>
        ) : (
          (() => {
            const conv = conversations.find(
              (c) => c._id === selectedConversation
            );
            const other = conv ? otherUser(conv) : {};
            const isGroup = conv?.type === "group";
            const displayName = isGroup ? conv.name : other.username;
            const typingHere = typingText(conv);

            return (
              <>
                <header className="chat-header">
                  <div
                    className={
                      "chat-header-clickable" + (isGroup ? "" : " is-user")
                    }
                    title={isGroup ? "" : "View profile"}
                    onClick={() => {
                      if (!isGroup) {
                        setProfileFromChat(true);
                        setProfileUser(other);
                      }
                    }}
                  >
                    <Avatar
                      user={
                        isGroup
                          ? { username: conv.name }
                          : { username: other.username, avatar: other.avatar }
                      }
                    />
                    <div className="chat-header-info">
                      <div className="chat-title">
                        {displayName}
                        {isMutedNow(conv) && (
                          <span
                            className="mute-indicator"
                            title="Notifications muted"
                          >
                            🔕
                          </span>
                        )}
                      </div>
                      {typingHere ? (
                        <div className="chat-status typing-preview">
                          {typingHere}
                        </div>
                      ) : (
                        <div
                          className={
                            "chat-status" +
                            (!isGroup && isOnline(other._id) ? " online" : "")
                          }
                        >
                          {isGroup
                            ? `${conv.participants.length} members`
                            : statusText(other._id)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="chat-actions">
                    {isGroup && (
                      <>
                        <button
                          className="icon-button"
                          title="Add members"
                          onClick={() => openGroupModal("add", conv)}
                        >
                          ＋
                        </button>
                        <button
                          className="icon-button"
                          title="Leave group"
                          onClick={() => leaveGroup(conv)}
                        >
                          🚪
                        </button>
                      </>
                    )}
                    <div className="chat-menu-wrap">
                      <button
                        className="icon-button"
                        title="More options"
                        onClick={() => setChatMenuOpen((v) => !v)}
                      >
                        ⋯
                      </button>
                      {chatMenuOpen && (
                        <>
                          <div
                            className="chat-menu-backdrop"
                            onClick={() => setChatMenuOpen(false)}
                          />
                          <div className="chat-menu">
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowMediaModal(true);
                              }}
                            >
                              🖼 Media, files &amp; links
                            </button>
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowThemePicker(true);
                              }}
                            >
                              🎨 Change chat theme
                            </button>
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowBackgroundPicker(true);
                              }}
                            >
                              🖼 Change chat background
                            </button>
                            {isMutedNow(conv) ? (
                              <button onClick={() => unmuteConversation(conv)}>
                                🔔 Unmute notifications
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  setChatMenuOpen(false);
                                  setShowMutePicker(true);
                                }}
                              >
                                🔕 Mute notifications
                              </button>
                            )}
                            {!isGroup && (
                              <button
                                onClick={() => {
                                  setChatMenuOpen(false);
                                  if (isProfileBlocked(other)) {
                                    unblockUser(other);
                                  } else {
                                    blockUser(other);
                                  }
                                }}
                              >
                                {isProfileBlocked(other)
                                  ? "✅ Unblock user"
                                  : "🚫 Block user"}
                              </button>
                            )}
                            <button
                              className="conv-menu-danger"
                              onClick={() => setConfirmDeleteChat(conv)}
                            >
                              Delete chat
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </header>

                {error && <div className="error-banner">{error}</div>}
                {notice && <div className="notice-banner">{notice}</div>}

                <div
                  className="messages-area"
                  ref={messagesAreaRef}
                  style={
                    conv.background
                      ? {
                          backgroundImage: `url(${conv.background})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : undefined
                  }
                >
                  {messages.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-text">
                        No messages yet. Say hello!
                      </div>
                    </div>
                  ) : (
                    messages.map((m, i) => {
                      const mine = m.sender?._id === user.id;
                      const prev = messages[i - 1];
                      const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
                      const showSender =
                        isGroup &&
                        !mine &&
                        (!prev || prev.sender?._id !== m.sender?._id);
                      return (
                        <Fragment key={m._id}>
                          {newDay && (
                            <div className="date-separator">
                              {formatDay(m.createdAt)}
                            </div>
                          )}
                          <div
                            id={`msg-${m._id}`}
                            className={"message" + (mine ? " own" : "")}
                          >
                            {showSender && (
                              <div className="message-sender-row">
                                <Avatar user={m.sender} small />
                                <div className="message-sender">
                                  {m.sender?.username}
                                </div>
                              </div>
                            )}
                            <div className="message-bubble">
                              {editingId === m._id ? (
                                <form
                                  className="message-edit-form"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    saveEdit();
                                  }}
                                >
                                  <input
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    autoFocus
                                  />
                                  <div className="message-edit-actions">
                                    <button
                                      type="button"
                                      className="edit-cancel"
                                      onClick={cancelEdit}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="submit"
                                      className="edit-save"
                                      disabled={!editText.trim()}
                                    >
                                      Save
                                    </button>
                                  </div>
                                </form>
                              ) : (
                                renderContent(m)
                              )}
                              <div className="message-meta">
                                {m.editedAt && (
                                  <span className="edited-label">edited</span>
                                )}
                                <span className="message-time">
                                  {formatTime(m.createdAt)}
                                </span>
                                {mine && (
                                  <span
                                    className={
                                      "tick" + (isRead(m) ? " read" : "")
                                    }
                                  >
                                    ✓✓
                                  </span>
                                )}
                              </div>
                              {!m.deleted && (
                                <>
                                  <button
                                    className={
                                      "more-button" +
                                      (menuOpen === m._id ? " open" : "")
                                    }
                                    title="Actions"
                                    onClick={() =>
                                      setMenuOpen(
                                        menuOpen === m._id ? null : m._id
                                      )
                                    }
                                  >
                                    ⋯
                                  </button>
                                  {menuOpen === m._id && (
                                    <div className="message-menu">
                                      {mine && canEdit(m) && (
                                        <button onClick={() => startEdit(m)}>
                                          Edit
                                        </button>
                                      )}
                                      <button onClick={() => deleteForMe(m)}>
                                        Delete for me
                                      </button>
                                      {mine && (
                                        <button
                                          className="danger"
                                          onClick={() => {
                                            setMenuOpen(null);
                                            setConfirmDelete(m);
                                          }}
                                        >
                                          Delete for everyone
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </Fragment>
                      );
                    })
                  )}
                  {!atBottom && (
                    <button
                      className="scroll-bottom"
                      title="Jump to latest"
                      onClick={() =>
                        messagesAreaRef.current?.scrollTo({
                          top: messagesAreaRef.current.scrollHeight,
                          behavior: "smooth",
                        })
                      }
                    >
                      ↓
                    </button>
                  )}
                </div>

                {!isGroup && isProfileBlocked(other) ? (
                  <div className="message-input-bar blocked-bar">
                    <span className="blocked-bar-text">
                      🔒 You blocked this user
                    </span>
                    <button
                      className="blocked-bar-btn"
                      onClick={() => unblockUser(other)}
                    >
                      Unblock
                    </button>
                    <button
                      className="blocked-bar-btn blocked-bar-delete"
                      onClick={() => setConfirmDeleteChat(conv)}
                    >
                      Delete chat
                    </button>
                  </div>
                ) : (
                  <form className="message-input-bar" onSubmit={handleSend}>
                    <EmojiPicker
                      onSelect={(e) => setNewMessage((prev) => prev + e)}
                    />
                    <label
                      className={"icon-button" + (uploading ? " disabled" : "")}
                    >
                      {uploading ? "⏳" : "📎"}
                      <input
                        type="file"
                        hidden
                        disabled={uploading}
                        onChange={handleFileSelect}
                      />
                    </label>
                    <input
                      type="text"
                      placeholder="Type a message..."
                      value={newMessage}
                      onChange={(e) => {
                        setNewMessage(e.target.value);
                        handleTyping();
                      }}
                    />
                    <button
                      className="send-button"
                      type="submit"
                      title="Send"
                      disabled={!newMessage.trim()}
                    >
                      ➤
                    </button>
                  </form>
                )}
              </>
            );
          })()
        )}
      </main>

      {showGroupModal && (
        <GroupModal
          mode={groupModalMode}
          currentUser={user}
          conversationId={groupModalConversation?._id}
          onClose={() => setShowGroupModal(false)}
          onCreate={refreshAndSelect}
          onAddMembers={async () => {
            setShowGroupModal(false);
            await loadConversations();
            setNotice("Members added");
          }}
        />
      )}

      {showRequests && (
        <div className="modal-overlay" onClick={() => setShowRequests(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Friend Requests</h3>
            {friendRequests.length === 0 ? (
              <div className="empty-hint">No pending requests.</div>
            ) : (
              friendRequests.map((fr) => (
                <div className="request-row" key={fr._id}>
                  <Avatar user={fr.requester} small />
                  <span className="request-name">{fr.requester.username}</span>
                  <button
                    className="mini-button accept"
                    title="Accept"
                    onClick={() => acceptRequest(fr)}
                  >
                    ✓
                  </button>
                  <button
                    className="mini-button decline"
                    title="Decline"
                    onClick={() => declineRequest(fr)}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {showFriends && (
        <div className="modal-overlay" onClick={() => setShowFriends(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Friends</h3>
            {friends.length === 0 ? (
              <div className="empty-hint">
                No friends yet. Search for a user and click ＋ to add them.
              </div>
            ) : (
              friends.map(({ friendshipId, friend }) => (
                <div
                  className="request-row"
                  key={friendshipId}
                  onClick={() => {
                    setShowFriends(false);
                    setProfileFromChat(false);
                    setProfileUser(friend);
                  }}
                >
                  <Avatar user={friend} small />
                  <span className="request-name">{friend.username}</span>
                  {isOnline(friend._id) && <span className="online-dot" />}
                  <button
                    className="mini-button"
                    title="Message"
                    onClick={(e) => {
                      e.stopPropagation();
                      startConversation(friend);
                    }}
                  >
                    💬
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete message?</h3>
            <div className="empty-hint">
              This message will be deleted for everyone in the chat. This cannot
              be undone.
            </div>
            <div className="modal-actions">
              <button
                className="auth-button"
                style={{ background: "var(--bg)", color: "var(--text)" }}
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="auth-button"
                style={{ background: "var(--danger)" }}
                onClick={confirmDeleteForEveryone}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteChat && (
        <div
          className="modal-overlay"
          onClick={() => setConfirmDeleteChat(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete chat?</h3>
            <div className="empty-hint">
              This chat and all of its messages will be deleted for everyone.
              This cannot be undone.
            </div>
            <div className="modal-actions">
              <button
                className="auth-button"
                style={{ background: "var(--bg)", color: "var(--text)" }}
                onClick={() => setConfirmDeleteChat(null)}
              >
                Cancel
              </button>
              <button
                className="auth-button"
                style={{ background: "var(--danger)" }}
                onClick={() => deleteChat(confirmDeleteChat)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {profileUser && (
        <div
          className="modal-overlay"
          onClick={() => {
            setProfileUser(null);
            setProfileFromChat(false);
          }}
        >
          <div
            className="modal profile-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="profile-hero">
              <Avatar user={profileUser} large />
              <div className="profile-name">{profileUser.username}</div>
              <div
                className={
                  "profile-status" +
                  (isOnline(profileUser._id) ? " online" : "")
                }
              >
                {isOnline(profileUser._id)
                  ? "Online"
                  : formatLastSeen(lastSeenMap[profileUser._id])}
              </div>
            </div>
            {profileUser.email && (
              <div className="profile-detail">
                <span>Email</span>
                <div>{profileUser.email}</div>
              </div>
            )}
            {isProfileBlocked(profileUser) && (
              <div className="profile-detail blocked-note">
                <span>Blocked</span>
                <div>This user cannot message you while blocked.</div>
              </div>
            )}
            {profileShowsChatInfo && (
              <>
                <div className="profile-section">
                  <div className="profile-section-title">Search in chat</div>
                  <input
                    className="profile-search-input"
                    type="text"
                    placeholder="Search messages..."
                    value={msgSearch}
                    onChange={(e) => {
                      setMsgSearch(e.target.value);
                      setMsgMatchIndex(0);
                    }}
                    autoFocus
                  />
                  {msgSearch.trim() && msgMatches.length === 0 && (
                    <div className="empty-hint">No matches</div>
                  )}
                  {msgMatches.length > 0 && (
                    <div className="profile-search-results">
                      {msgMatches.slice(0, 50).map((mi, j) => {
                        const m = messages[mi];
                        return (
                          <button
                            key={m._id}
                            className={
                              "profile-search-row" +
                              (j === msgMatchIndex ? " active" : "")
                            }
                            onClick={() => jumpToMatch(mi)}
                          >
                            <span className="profile-search-sender">
                              {m.sender?._id === user.id
                                ? "You"
                                : m.sender?.username}
                            </span>
                            <span className="profile-search-snippet">
                              {highlight(snippet(m.text))}
                            </span>
                          </button>
                        );
                      })}
                      {msgMatches.length > 50 && (
                        <div className="empty-hint">
                          Showing first 50 of {msgMatches.length} matches
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="profile-section">
                  <div className="profile-section-title">
                    Media shared with {profileUser.username}
                    {mediaList.length > 6 && (
                      <button
                        className="mini-button"
                        onClick={() => {
                          setShowMediaModal(true);
                          setProfileUser(null);
                          setProfileFromChat(false);
                        }}
                      >
                        View all ({mediaList.length})
                      </button>
                    )}
                  </div>
                  {mediaList.length === 0 ? (
                    <div className="empty-hint">No media shared yet.</div>
                  ) : (
                    <div className="profile-media-grid">
                      {mediaList.slice(0, 6).map((m) => (
                        <a
                          key={m._id}
                          className="profile-media-cell"
                          href={mediaUrl(m)}
                          target="_blank"
                          rel="noreferrer"
                          title={mediaTitle(m)}
                        >
                          {m.kind === "image" ? (
                            <img
                              src={SERVER_URL + m.file?.url}
                              alt={mediaTitle(m)}
                            />
                          ) : (
                            <span className="profile-media-icon">
                              {m.kind === "file" ? "📎" : "🔗"}
                            </span>
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="modal-actions">
              {!isProfileBlocked(profileUser) && (
                <button
                  className="auth-button"
                  onClick={() => {
                    startConversation(profileUser);
                    setProfileUser(null);
                  }}
                >
                  💬 Message
                </button>
              )}
              <button
                className="auth-button"
                style={{
                  background: isProfileBlocked(profileUser)
                    ? "var(--accent)"
                    : "var(--danger)",
                }}
                onClick={() =>
                  isProfileBlocked(profileUser)
                    ? unblockUser(profileUser)
                    : blockUser(profileUser)
                }
              >
                {isProfileBlocked(profileUser) ? "Unblock" : "🚫 Block"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showThemePicker && activeConv && (
        <div className="modal-overlay" onClick={() => setShowThemePicker(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Change chat theme</h3>
            <div className="theme-swatches">
              {[
                ["default", "Default", "var(--own-bubble)"],
                ["blue", "Blue", "#2f6fed"],
                ["green", "Green", "#07a35a"],
                ["purple", "Purple", "#8e44ad"],
                ["pink", "Pink", "#d63384"],
                ["dark", "Dark", "#005c4b"],
              ].map(([value, label, color]) => (
                <button
                  key={value}
                  className={
                    "theme-swatch" + (activeConv.theme === value ? " active" : "")
                  }
                  onClick={() => setChatTheme(activeConv, value)}
                >
                  <span
                    className="theme-swatch-color"
                    style={{ background: color }}
                  />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showBackgroundPicker && activeConv && (
        <div
          className="modal-overlay"
          onClick={() => setShowBackgroundPicker(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Change chat background</h3>
            <p className="mute-picker-note">
              Pick an image from your device. It is only visible to you.
            </p>
            {activeConv.background && (
              <div className="background-preview">
                <img src={activeConv.background} alt="Chat background preview" />
              </div>
            )}
            <label
              className={
                "auth-button background-upload" +
                (backgroundUploading ? " disabled" : "")
              }
            >
              {backgroundUploading ? "⏳ Uploading..." : "📤 Upload image"}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={backgroundUploading}
                onChange={handleBackgroundUpload}
              />
            </label>
            {activeConv.background && (
              <button
                className="auth-button"
                style={{ background: "var(--danger)" }}
                onClick={() => setChatBackground(activeConv, "")}
              >
                Remove background
              </button>
            )}
          </div>
        </div>
      )}

      {showMutePicker && activeConv && (
        <div
          className="modal-overlay blur"
          onClick={() => setShowMutePicker(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Mute notifications</h3>
            <p className="mute-picker-note">
              Stop receiving desktop notifications from this chat for a while.
            </p>
            <div className="mute-options">
              <button
                onClick={() => {
                  setShowMutePicker(false);
                  muteConversation(activeConv, "8h");
                }}
              >
                🔕 For 8 hours
              </button>
              <button
                onClick={() => {
                  setShowMutePicker(false);
                  muteConversation(activeConv, "1w");
                }}
              >
                🔕 For 1 week
              </button>
              <button
                onClick={() => {
                  setShowMutePicker(false);
                  muteConversation(activeConv, "forever");
                }}
              >
                🔕 Always
              </button>
            </div>
          </div>
        </div>
      )}

      {showMediaModal && activeConv && (
        <div className="modal-overlay" onClick={() => setShowMediaModal(false)}>
          <div
            className="modal media-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="media-modal-header">
              <h3>
                {activeConv.type === "group"
                  ? activeConv.name
                  : otherUser(activeConv).username}{" "}
                · Media, files &amp; links
              </h3>
              <button
                className="msg-search-close"
                title="Close"
                onClick={() => setShowMediaModal(false)}
              >
                ✕
              </button>
            </div>
            {mediaList.length === 0 ? (
              <div className="empty-hint">Nothing shared yet.</div>
            ) : (
              <div className="media-modal-body">
                {mediaList.some((m) => m.kind === "image") && (
                  <>
                    <div className="media-section-title">Photos</div>
                    <div className="media-grid">
                      {mediaList
                        .filter((m) => m.kind === "image")
                        .map((m) => (
                          <a
                            key={m._id}
                            href={SERVER_URL + m.file?.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={SERVER_URL + m.file?.url}
                              alt={m.file?.name || "photo"}
                            />
                          </a>
                        ))}
                    </div>
                  </>
                )}
                {mediaList.some((m) => m.kind === "file") && (
                  <>
                    <div className="media-section-title">Files</div>
                    <div className="media-list">
                      {mediaList
                        .filter((m) => m.kind === "file")
                        .map((m) => (
                          <a
                            key={m._id}
                            className="media-row"
                            href={SERVER_URL + m.file?.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className="media-row-icon">📎</span>
                            <span className="media-row-name">
                              {m.file?.name || "File"}
                            </span>
                            <span className="media-row-meta">
                              {formatListTime(m.createdAt)}
                            </span>
                          </a>
                        ))}
                    </div>
                  </>
                )}
                {mediaList.some((m) => m.kind === "link") && (
                  <>
                    <div className="media-section-title">Links</div>
                    <div className="media-list">
                      {mediaList
                        .filter((m) => m.kind === "link")
                        .map((m) => (
                          <a
                            key={m._id}
                            className="media-row"
                            href={m.text}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className="media-row-icon">🔗</span>
                            <span className="media-row-name">{m.text}</span>
                            <span className="media-row-meta">
                              {formatListTime(m.createdAt)}
                            </span>
                          </a>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div
            className="modal settings-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Settings</h3>
            <div className="settings-section">
              <div className="settings-label">Appearance</div>
              <div className="theme-options">
                <button
                  className={"theme-option" + (dark ? "" : " active")}
                  onClick={() => dark && onToggleTheme()}
                >
                  ☀️ Light
                </button>
                <button
                  className={"theme-option" + (dark ? " active" : "")}
                  onClick={() => !dark && onToggleTheme()}
                >
                  🌙 Dark
                </button>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Account</div>
              <div className="settings-row">
                <Avatar user={user} small />
                <div className="settings-sub">
                  <div>{user.username}</div>
                  <div>{user.email}</div>
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Notifications</div>
              <div className="settings-row">
                <div className="settings-sub">
                  <div>Desktop notifications</div>
                  <div>
                    {notificationsEnabled
                      ? "You will be notified of new messages in background."
                      : "Off"}
                  </div>
                </div>
                <button
                  className="mini-button"
                  onClick={toggleNotifications}
                >
                  {notificationsEnabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">Blocked users</div>
              {blockedUsers.length === 0 ? (
                <div className="empty-hint">No blocked users.</div>
              ) : (
                blockedUsers.map((bu) => (
                  <div className="settings-row" key={bu._id}>
                    <Avatar user={bu} small />
                    <div className="settings-sub">
                      <div>{bu.username}</div>
                      {bu.email && <div>{bu.email}</div>}
                    </div>
                    <button
                      className="mini-button"
                      title="Unblock"
                      onClick={() => unblockUser(bu)}
                    >
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="settings-section">
              <div className="settings-label">Danger zone</div>
              {confirmDeleteAccount ? (
                <div className="settings-row settings-danger-confirm">
                  <div className="settings-sub">
                    <div>Are you sure?</div>
                    <div>Your chats, friends and account will be permanently deleted.</div>
                  </div>
                  <div className="settings-danger-actions">
                    <button
                      className="auth-button"
                      style={{ background: "var(--bg)", color: "var(--text)" }}
                      onClick={() => setConfirmDeleteAccount(false)}
                      disabled={deletingAccount}
                    >
                      Cancel
                    </button>
                    <button
                      className="auth-button"
                      style={{ background: "var(--danger)" }}
                      onClick={handleDeleteAccount}
                      disabled={deletingAccount}
                    >
                      {deletingAccount ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="danger-button"
                  onClick={() => setConfirmDeleteAccount(true)}
                >
                  Delete account
                </button>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="auth-button"
                style={{ background: "var(--danger)" }}
                onClick={onLogout}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatPage;
