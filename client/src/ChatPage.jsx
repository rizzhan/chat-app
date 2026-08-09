import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import api, { SERVER_URL } from "./api";
import Avatar from "./Avatar";
import EmojiPicker from "./EmojiPicker";
import { EMOJIS } from "./emojis";
import GroupModal from "./GroupModal";

// Lightbox zoom preset levels (WhatsApp-style).
const LIGHTBOX_ZOOM_LEVELS = [1, 1.5, 2, 2.5, 3, 4, 5];

const nextZoomLevel = (z, dir) => {
  let idx = 0;
  for (let i = 0; i < LIGHTBOX_ZOOM_LEVELS.length; i++) {
    if (LIGHTBOX_ZOOM_LEVELS[i] <= z + 0.001) idx = i;
  }
  return LIGHTBOX_ZOOM_LEVELS[
    Math.max(0, Math.min(LIGHTBOX_ZOOM_LEVELS.length - 1, idx + dir))
  ];
};

const WAVEFORM_BARS = 32;
const RECORDING_METER_BARS = 24;

// List the microphone inputs. Labels are only exposed once mic permission has
// been granted (a first transient getUserMedia fills them in).
const enumerateMicDevices = async () => {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
};

// Pick the best input: never virtual/silent devices (Steam Streaming, Stereo
// Mix, NVIDIA Virtual, AUX jacks). Prefer a connected Bluetooth headset mic,
// otherwise the built-in microphone array, otherwise the default device.
const pickBestMic = (devices) => {
  const IGNORE = /steam|stream|stereo ?mix|virtual|wave|aux|jack|monitor|nvidia|obs|cable|voicemeter|hdmi|hd audio/i;
  const BLUETOOTH = /bluetooth|wireless|buds|earbud|headset|headphone|hands-?free|\bldac\b|\bsco\b/i;
  const BUILTIN = /microphone array|\barray\b|intel sst|realtek|built-?in|omnisonic|omni/i;
  const usable = devices.filter((d) => d.label && !IGNORE.test(d.label));
  const bt = usable.find((d) => BLUETOOTH.test(d.label));
  if (bt) return bt;
  const builtin = usable.find((d) => BUILTIN.test(d.label));
  if (builtin) return builtin;
  return usable[0] || null;
};

// Ensure device labels are available (grants mic permission on first use) and
// return the mic to record from.
const pickBestMicDevice = async () => {
  try {
    let devs = await enumerateMicDevices();
    if (devs.length === 0 || devs.some((d) => !d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await enumerateMicDevices();
    }
    return pickBestMic(devs);
  } catch {
    return null;
  }
};

// Deterministic placeholder bars shown while a real waveform is being decoded.
const fallbackWaveform = (seed, bars = WAVEFORM_BARS) => {
  let h = seed >>> 0;
  const rnd = () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return (h % 1000) / 1000;
  };
  return Array.from({ length: bars }, () => 0.25 + rnd() * 0.75);
};

// Decode the audio and compute RMS per bar so the waveform matches the real file.
const computeWaveform = async (url, bars = WAVEFORM_BARS) => {
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 44100, 44100);
    const decoded = await ctx.decodeAudioData(buf);
    const channel = decoded.getChannelData(0);
    const n = channel.length;
    const chunk = Math.max(1, Math.floor(n / bars));
    const out = [];
    for (let i = 0; i < bars; i++) {
      const start = i * chunk;
      const end = Math.min(n, start + chunk);
      let sum = 0;
      for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
      const rms = sum / (end - start);
      out.push(Math.max(0.06, Math.min(1, Math.sqrt(rms) * 2.4)));
    }
    if (ctx.close) ctx.close();
    return out;
  } catch {
    return null;
  }
};

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
  const [reactionPickerFor, setReactionPickerFor] = useState(null);
  const [forwardingMessage, setForwardingMessage] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Reply + disappearing messages UI state
  const [replyTarget, setReplyTarget] = useState(null);
  const [showDisappearPicker, setShowDisappearPicker] = useState(false);

  // Poll creation UI state
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);

  // Voice recording + view-once state
  const [recording, setRecording] = useState(false);
  const [recordingLocked, setRecordingLocked] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micSilent, setMicSilent] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [waveforms, setWaveforms] = useState({});
  const [playingVoice, setPlayingVoice] = useState(null);
  const [viewOnceMedia, setViewOnceMedia] = useState(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [pendingMedia, setPendingMedia] = useState(null);
  const [lightbox, setLightbox] = useState(null);

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

  // Profile editing (username, handle, status)
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editHandle, setEditHandle] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  // Chat lock (PIN)
  const [locked, setLocked] = useState(
    () => !!localStorage.getItem("chatLockPin")
  );
  const [hasPin, setHasPin] = useState(
    () => !!localStorage.getItem("chatLockPin")
  );
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");

  // In-chat message search (shown inside the profile modal)
  const [msgSearch, setMsgSearch] = useState("");
  const [msgMatchIndex, setMsgMatchIndex] = useState(0);

  // Chat header + extra modals
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [showMediaModal, setShowMediaModal] = useState(false);  const [showThemePicker, setShowThemePicker] = useState(false);
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

  // Voice recording refs
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingSecondsRef = useRef(0);
  const recordingTimerRef = useRef(null);
  const voiceEls = useRef({});
  const micHoldRef = useRef(null);
  const micActiveRef = useRef(false);
  const micReleasedRef = useRef(false);
  const voiceWaveRefs = useRef({});
  const voiceTimeRefs = useRef({});
  const voiceSeekRef = useRef(null);
  const micAudioCtxRef = useRef(null);
  const micAnalyserRef = useRef(null);
  const micLevelBufRef = useRef(null);
  const micMeterRafRef = useRef(null);
  const micMeterElsRef = useRef([]);
  const micSilentRef = useRef(false);
  const micSilentFramesRef = useRef(0);
  const recorderMimeRef = useRef("audio/webm");
  const micPreviewUrlRef = useRef(null);
  const micPreviewAudioRef = useRef(null);
  const previewAudioCtxRef = useRef(null);
  const previewAnalyserRef = useRef(null);
  const previewSrcRef = useRef(null);
  const previewSrcElRef = useRef(null);

  const scrollTimerRef = useRef(null);
  const lockHiddenAtRef = useRef(0);

  const filterBarRef = useRef(null);

  const filterScrollbarThumbRef = useRef(null);

  const filterScrollbarDragRef = useRef(null);

  // Lightbox zoom / pan refs
  const lightboxStageRef = useRef(null);
  const lightboxImgRef = useRef(null);
  const lightboxPointersRef = useRef(new Map());
  const lightboxDragRef = useRef(null);
  const lightboxPinchRef = useRef(null);

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
      if (reactionPickerFor && !e.target.closest(".message-actions")) {
        setReactionPickerFor(null);
      }
      if (attachMenuOpen && !e.target.closest(".attach-wrap")) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [convMenuOpen, menuOpen, reactionPickerFor, attachMenuOpen]);

  // Close the image lightbox with the Escape key.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setLightbox(null);
        setViewOnceMedia(null);
        setPendingMedia(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
      const conv = (conversationsRef.current || []).find(
        (c) => c._id === msg.conversationId
      );
      const isMentionAll =
        conv?.type === "group" && mentionsAll(msg.text);
      if (
        msg.conversationId !== selectedConvRef.current &&
        notificationsEnabledRef.current &&
        (document.hidden || isMentionAll) &&
        ("Notification" in window) &&
        Notification.permission === "granted"
      ) {
        if (!conv || !isMutedNow(conv) || isMentionAll) {
          const senderName = msg.sender?.username || "Someone";
          const title =
            isMentionAll
              ? `${conv?.name || "Group"} — ${senderName} @all`
              : conv?.type === "group"
              ? conv.name
              : senderName;
          const body =
            msg.type === "image"
              ? msg.viewOnce
                ? "📷 View-once photo"
                : "📷 Photo"
              : msg.type === "video"
              ? msg.viewOnce
                ? "🎥 View-once video"
                : "🎥 Video"
              : msg.type === "file"
              ? `📎 ${msg.file?.name || "File"}`
              : msg.type === "poll"
              ? `📊 ${msg.poll?.question || "Poll"}`
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

    // Someone reacted to a message. Update it in place.
    newSocket.on("message-reaction", (updated) => {
      if (updated.conversationId !== selectedConvRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m._id === updated._id ? updated : m))
      );
    });

    // Someone voted on a poll. Update it in place.
    newSocket.on("message-vote", (updated) => {
      if (updated.conversationId !== selectedConvRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m._id === updated._id ? updated : m))
      );
    });

    // A view-once message was opened. Show the "opened" placeholder everywhere.
    newSocket.on("message-viewed-once", (updated) => {
      if (updated.conversationId !== selectedConvRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m._id === updated._id ? updated : m))
      );
    });

    // Disappearing messages were turned on/off for a conversation.
    newSocket.on("conversation-disappear", ({ conversationId, disappearTime }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c._id === conversationId ? { ...c, disappearTime } : c
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

    // Group info changed (name, members, admins). Reload from the server.
    newSocket.on("conversation-updated", () => {
      loadConversationsRef.current?.();
    });

    // I was removed from a group. Drop it from my list.
    newSocket.on("removed-from-group", ({ conversationId }) => {
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
      newSocket.off("message-reaction");
      newSocket.off("message-vote");
      newSocket.off("message-viewed-once");
      newSocket.off("conversation-disappear");
      newSocket.off("conversation-deleted");
      newSocket.off("conversation-updated");
      newSocket.off("removed-from-group");
      newSocket.off("connect_error");
      newSocket.disconnect();
    };
  }, []);

  // Auto-lock the chat when the tab is left for more than a minute.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        lockHiddenAtRef.current = Date.now();
      } else if (
        lockHiddenAtRef.current &&
        Date.now() - lockHiddenAtRef.current > 60000
      ) {
        lockHiddenAtRef.current = 0;
        if (localStorage.getItem("chatLockPin")) {
          setPinInput("");
          setPinError("");
          setLocked(true);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Stop any pending timers when the page unmounts.
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      const r = mediaRecorderRef.current;
      if (r) {
        try {
          r.stop();
        } catch {
          /* already stopped */
        }
        mediaRecorderRef.current = null;
      }
    };
  }, []);

  // ---- Load the user's conversations ----
  const loadConversations = useCallback(async () => {
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
  }, []);

  // Always point at the latest loadConversations so socket listeners can call it.
  const loadConversationsRef = useRef(loadConversations);
  useEffect(() => {
    loadConversationsRef.current = loadConversations;
  }, [loadConversations]);

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
  }, [loadConversations]);

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

  // Disappearing chats: prune messages that have self-destructed.
  useEffect(() => {
    const prune = () => {
      const now = Date.now();
      setMessages((prev) => {
        const next = prev.filter(
          (m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now
        );
        return next.length === prev.length ? prev : next;
      });
    };
    const t = setInterval(prune, 15000);
    return () => clearInterval(t);
  }, []);

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
      .filter((m) => !m.deleted && !m.viewOnce)
      .map((m) => {
        let kind = "text";
        if (m.type === "image") kind = "image";
        else if (m.type === "video") kind = "video";
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
      : m.kind === "video"
      ? "Video"
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

    // Stop any in-progress voice recording when switching chats.
    if (recording) cancelRecording();
    setPlayingVoice(null);

    // Reset the in-chat search when moving between conversations.
    setMsgSearch("");
    setMsgMatchIndex(0);
    setReplyTarget(null);

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

    const replyId = replyTarget?._id || null;

    setNewMessage("");
    setReplyTarget(null);
    stopTyping();

    sendSocket(
      { conversationId: selectedConversation, text, replyTo: replyId },
      () =>
        sendViaApi({ text, replyTo: replyId }).catch((err) =>
          setError(err.response?.data?.message || "Failed to send message")
        )
    );
  };

  // ---- Download a file to the user's device ----
  const downloadFile = async (url, name) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch {
      setError("Could not download the file");
    }
  };

  // ---- Lightbox (WhatsApp-style image viewer with zoom + pan) ----
  const openLightbox = (url, name) =>
    setLightbox({ url, name, zoom: 1, pan: { x: 0, y: 0 } });

  const clampLightboxPan = (pan) => {
    const img = lightboxImgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    const maxX = Math.max(0, (rect.width - window.innerWidth) / 2);
    const maxY = Math.max(0, (rect.height - window.innerHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, pan?.x || 0)),
      y: Math.max(-maxY, Math.min(maxY, pan?.y || 0)),
    };
  };

  const handleLightboxWheel = useCallback((e) => {
    const stage = lightboxStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    setLightbox((prev) => {
      if (!prev) return prev;
      const z1 = prev.zoom || 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      const z2 = nextZoomLevel(z1, dir);
      if (z2 === z1) return prev;
      const p1 = prev.pan || { x: 0, y: 0 };
      const scale = z2 / z1;
      const pan = {
        x: cx - (cx - p1.x) * scale,
        y: cy - (cy - p1.y) * scale,
      };
      return {
        ...prev,
        zoom: z2,
        pan: z2 === 1 ? { x: 0, y: 0 } : clampLightboxPan(pan),
      };
    });
  }, []);

  const onLightboxPointerDown = (e) => {
    if (e.button !== 0) return;
    lightboxStageRef.current?.setPointerCapture(e.pointerId);
    lightboxPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lightboxPointersRef.current.size === 1) {
      lightboxDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origPan: { ...(lightbox?.pan || { x: 0, y: 0 }) },
        active: (lightbox?.zoom || 1) > 1,
      };
    } else if (lightboxPointersRef.current.size === 2) {
      lightboxDragRef.current = null;
      const p = [...lightboxPointersRef.current.values()];
      const dx = p[1].x - p[0].x;
      const dy = p[1].y - p[0].y;
      lightboxPinchRef.current = {
        startDist: Math.hypot(dx, dy) || 1,
        startZoom: lightbox?.zoom || 1,
        startMid: { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 },
        startPan: { ...(lightbox?.pan || { x: 0, y: 0 }) },
      };
    }
  };

  const onLightboxPointerMove = (e) => {
    const pts = lightboxPointersRef.current;
    if (!pts.has(e.pointerId)) return;
    if (pts.size === 1) {
      const drag = lightboxDragRef.current;
      if (!drag || !drag.active) return;
      setLightbox((prev) =>
        prev
          ? {
              ...prev,
              pan: clampLightboxPan({
                x: drag.origPan.x + (e.clientX - drag.startX),
                y: drag.origPan.y + (e.clientY - drag.startY),
              }),
            }
          : prev
      );
    } else if (pts.size === 2) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = lightboxPinchRef.current;
      if (!pinch) return;
      const p = [...pts.values()];
      const dx = p[1].x - p[0].x;
      const dy = p[1].y - p[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      setLightbox((prev) => {
        if (!prev) return prev;
        const zoom = Math.max(1, Math.min(5, pinch.startZoom * (dist / pinch.startDist)));
        const pan = {
          x: pinch.startPan.x + (mid.x - pinch.startMid.x),
          y: pinch.startPan.y + (mid.y - pinch.startMid.y),
        };
        return {
          ...prev,
          zoom,
          pan: zoom === 1 ? { x: 0, y: 0 } : clampLightboxPan(pan),
        };
      });
    }
  };

  const onLightboxPointerUp = (e) => {
    lightboxPointersRef.current.delete(e.pointerId);
    lightboxDragRef.current = null;
    lightboxPinchRef.current = null;
  };

  const zoomLightboxBy = (dir) => {
    setLightbox((prev) => {
      if (!prev) return prev;
      const z2 = nextZoomLevel(prev.zoom || 1, dir);
      return {
        ...prev,
        zoom: z2,
        pan: z2 === 1 ? { x: 0, y: 0 } : clampLightboxPan(prev.pan || { x: 0, y: 0 }),
      };
    });
  };

  const resetLightboxZoom = () =>
    setLightbox((prev) => (prev ? { ...prev, zoom: 1, pan: { x: 0, y: 0 } } : prev));

  const toggleLightboxZoom = () =>
    setLightbox((prev) => {
      if (!prev) return prev;
      if ((prev.zoom || 1) > 1) return { ...prev, zoom: 1, pan: { x: 0, y: 0 } };
      return { ...prev, zoom: 2, pan: { x: 0, y: 0 } };
    });

  // Non-passive wheel listener so the page doesn't scroll while zooming.
  useEffect(() => {
    const stage = lightboxStageRef.current;
    if (!stage || !lightbox) return;
    const onWheel = (e) => {
      e.preventDefault();
      handleLightboxWheel(e);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [lightbox, handleLightboxWheel]);

  // ---- Upload a file to the server (returns { url, name, size, mimeType }) ----
  const uploadFile = async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await api.post("/upload", formData);
    return res.data;
  };

  // ---- Send a document / any non-visual file ----
  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";

    if (!file || !selectedConversation) return;

    setAttachMenuOpen(false);
    setUploading(true);
    setError("");

    try {
      const meta = await uploadFile(file);
      const replyId = replyTarget?._id || null;
      const payload = {
        conversationId: selectedConversation,
        type: "file",
        file: meta,
        ...(replyId ? { replyTo: replyId } : {}),
      };

      sendSocket(
        payload,
        () =>
          sendViaApi({
            type: "file",
            file: meta,
            ...(replyId ? { replyTo: replyId } : {}),
          }).catch((err) => setError(err.response?.data?.message || "Failed to send file"))
      );
      setReplyTarget(null);
    } catch (err) {
      setError(err.response?.data?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ---- Pick an image / video: upload it, then let the user choose how to send ----
  const handleVisualSelect = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";

    if (!file || !selectedConversation) return;

    setAttachMenuOpen(false);
    setUploading(true);
    setError("");

    try {
      const meta = await uploadFile(file);
      setPendingMedia(meta);
    } catch (err) {
      setError(err.response?.data?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // Send the pending photo/video, optionally as view-once.
  const sendMedia = async (viewOnce) => {
    if (!pendingMedia || !selectedConversation) return;

    const { url, name, size, mimeType } = pendingMedia;
    const isImage = mimeType.startsWith("image/");
    const type = isImage ? "image" : "video";
    const replyId = replyTarget?._id || null;
    const file = { url, name, size, mimeType };
    const payload = {
      conversationId: selectedConversation,
      type,
      file,
      ...(viewOnce ? { viewOnce: true } : {}),
      ...(replyId ? { replyTo: replyId } : {}),
    };

    sendSocket(
      payload,
      () =>
        sendViaApi({
          type,
          file,
          ...(viewOnce ? { viewOnce: true } : {}),
          ...(replyId ? { replyTo: replyId } : {}),
        }).catch((err) => setError(err.response?.data?.message || "Failed to send media"))
    );
    setReplyTarget(null);
    setPendingMedia(null);
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

  const openEditProfile = () => {
    setEditUsername(user.username || "");
    setEditHandle((user.handle || "").replace(/^@/, ""));
    setEditStatus(user.status || "");
    setEditProfileOpen(true);
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await api.patch("/users/me", {
        username: editUsername.trim(),
        handle: editHandle.trim(),
        status: editStatus.trim(),
      });
      onUpdateUser(res.data);
      setNotice("Profile updated");
      setEditProfileOpen(false);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update profile");
    } finally {
      setSavingProfile(false);
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

  // ---- Reply / reactions / pinning ----
  const mentionsAll = (text) => /@all|@everyone/i.test(text || "");

  const replySnippet = (m) => {
    if (!m) return "";
    if (m.deleted) return "This message has been deleted";
    if (m.type === "image") return "📷 Photo";
    if (m.type === "video") return "🎥 Video";
    if (m.type === "file") return `📎 ${m.file?.name || "File"}`;
    if (m.type === "poll") return `📊 ${m.poll?.question || "Poll"}`;
    if (m.type === "voice") return "🎤 Voice message";
    return m.text;
  };

  const startReply = (m) => {
    setMenuOpen(null);
    setEditingId(null);
    setReplyTarget(m);
  };

  const jumpToMessage = (id) => {
    if (!id) return;
    setTimeout(() => {
      document
        .getElementById(`msg-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  };

  const myReaction = (m) =>
    (m.reactions || []).find(
      (r) => r.user?._id === user.id || r.user === user.id
    );

  const reactionCounts = (m) => {
    const counts = {};
    (m.reactions || []).forEach((r) => {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    });
    return counts;
  };

  const toggleReaction = async (m, emoji) => {
    setMenuOpen(null);
    try {
      const res = await api.put(`/messages/${m._id}/reactions`, { emoji });
      setMessages((prev) =>
        prev.map((x) => (x._id === m._id ? res.data : x))
      );
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update reaction");
    }
  };

  const isStarred = (m) => (m.starredBy || []).includes(user.id);

  const toggleStar = async (m) => {
    setMenuOpen(null);
    try {
      const res = await api.post(`/messages/${m._id}/star`);
      setMessages((prev) =>
        prev.map((x) => (x._id === m._id ? res.data : x))
      );
      setNotice(res.data.starredBy.includes(user.id)
        ? "Message starred"
        : "Message unstarred");
    } catch (err) {
      setError(err.response?.data?.message || "Failed to update star");
    }
  };

  // Forward a message to another conversation.
  const forwardMessageTo = async (conv) => {
    if (!forwardingMessage) return;
    try {
      const res = await api.post("/messages/forward", {
        messageId: forwardingMessage._id,
        conversationId: conv._id,
      });
      const msg = res.data;

      // If forwarding into the chat currently on screen, show it right away
      // (the socket also delivers it, so guard against duplicates).
      if (conv._id === selectedConversation) {
        setMessages((prev) =>
          prev.some((m) => m._id === msg._id) ? prev : [...prev, msg]
        );
        socketRef.current?.emit("read-messages", conv._id);
      }

      // Move the target chat to the top of the sidebar with the new preview.
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c._id === conv._id
            ? { ...c, lastMessage: msg, updatedAt: new Date().toISOString() }
            : c
        );
        return updated.sort((a, b) => {
          if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
      });

      setNotice("Message forwarded");
      setForwardingMessage(null);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to forward message");
    }
  };

  // Can this message be forwarded? (no view-once)
  const canForward = (m) =>
    !m.deleted && !m.viewOnce && ["text", "image", "file", "voice", "video"].includes(m.type);

  const formatDisappear = (s) => {
    if (s === 86400) return "24 hours";
    if (s === 604800) return "7 days";
    if (s === 7776000) return "90 days";
    return "1 day";
  };

  const setDisappearTime = async (conv, seconds) => {
    setShowDisappearPicker(false);
    setChatMenuOpen(false);
    try {
      const res = await api.post(`/conversations/${conv._id}/disappear`, {
        seconds,
      });
      applyConvUpdate(res.data);
      setNotice(
        seconds > 0
          ? `Messages will disappear after ${formatDisappear(seconds)}`
          : "Disappearing messages turned off"
      );
      // Refresh the current messages so the new expiry stamps apply.
      if (selectedConversation === conv._id) {
        const res2 = await api.get(`/messages/${conv._id}`);
        setMessages(res2.data);
      }
    } catch (err) {
      setError(
        err.response?.data?.message || "Failed to update disappearing messages"
      );
    }
  };

  // ---- Polls ----
  const createPoll = () => {
    if (!selectedConversation) return;

    const question = pollQuestion.trim();
    const options = pollOptions.map((o) => o.trim()).filter(Boolean);

    if (!question) {
      setError("Poll question is required");
      return;
    }
    if (options.length < 2) {
      setError("Add at least 2 options");
      return;
    }
    if (options.length > 10) {
      setError("Maximum 10 options");
      return;
    }

    const payload = {
      conversationId: selectedConversation,
      type: "poll",
      poll: {
        question,
        options: options.map((text) => ({ text })),
      },
    };

    sendSocket(
      payload,
      () =>
        sendViaApi(payload).catch((err) =>
          setError(err.response?.data?.message || "Failed to send poll")
        )
    );

    setPollQuestion("");
    setPollOptions(["", ""]);
    setShowPollModal(false);
  };

  const votePoll = async (m, optionIndex) => {
    try {
      const res = await api.post(`/messages/${m._id}/vote`, { optionIndex });
      setMessages((prev) =>
        prev.map((x) => (x._id === m._id ? res.data : x))
      );
    } catch (err) {
      setError(err.response?.data?.message || "Failed to vote");
    }
  };

  // ---- Voice messages ----
  const startRecording = async () => {
    try {
      setAttachMenuOpen(false);
      let stream;
      try {
        const picked = await pickBestMicDevice();
        const audio = picked ? { deviceId: { exact: picked.deviceId } } : true;
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch {
        // The picked mic failed (disconnected mid-session) - use the default.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const recorder = new MediaRecorder(stream);
      recorderMimeRef.current = recorder.mimeType || "audio/webm";
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingSecondsRef.current = 0;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        // Use the recorder's real mime type so Firefox (ogg) / Safari (m4a)
        // recordings play back instead of being labelled webm and failing.
        const mime = (recorder.mimeType || "audio/webm").split(";")[0];
        const ext = mime.includes("ogg")
          ? "ogg"
          : mime.includes("mp4")
            ? "m4a"
            : "webm";
        const blob = new Blob(recordingChunksRef.current, { type: mime });
        recordingChunksRef.current = [];
        if (blob.size > 0) sendVoice(blob, ext);
      };

      recorder.start();
      micActiveRef.current = true;
      setRecording(true);
      setRecordingSeconds(0);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);

      // Live input meter so the user can see if their mic is picking up sound.
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const actx = new AudioCtx();
          const src = actx.createMediaStreamSource(stream);
          const analyser = actx.createAnalyser();
          analyser.fftSize = 1024;
          src.connect(analyser);
          micAudioCtxRef.current = actx;
          micAnalyserRef.current = analyser;
          micLevelBufRef.current = new Uint8Array(analyser.fftSize);
          micSilentFramesRef.current = 0;
          micSilentRef.current = false;
          setMicSilent(false);
          if (actx.state === "suspended") actx.resume().catch(() => {});
          startMeterLoop();
        }
      } catch {
        /* the meter is optional */
      }

      // If the finger was already released while mic permission was pending,
      // lock the recording so it isn't silently left running.
      if (micReleasedRef.current) {
        micReleasedRef.current = false;
        setRecordingLocked(true);
      }
    } catch {
      micReleasedRef.current = false;
      setError("Microphone access denied");
    }
  };

  // Animate the recording meter bars from real mic input (direct DOM, no re-renders).
  const startMeterLoop = () => {
    cancelAnimationFrame(micMeterRafRef.current);
    let resumeTries = 0;
    const tick = () => {
      const analyser = micAnalyserRef.current;
      const buf = micLevelBufRef.current;
      if (!analyser || !buf) return;
      // Wait for the audio context to actually run (a suspended context would
      // read zeros and falsely report a silent mic).
      if (analyser.context.state !== "running") {
        if (resumeTries < 20) {
          resumeTries++;
          analyser.context.resume().catch(() => {});
        }
        micMeterRafRef.current = requestAnimationFrame(tick);
        return;
      }
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      const bars = micMeterElsRef.current;
      for (let i = 0; i < bars.length; i++) {
        const el = bars[i];
        if (!el) continue;
        const jitter = 0.55 + Math.random() * 0.45;
        el.style.height = `${Math.max(8, Math.min(100, level * 100 * jitter))}%`;
      }
      if (level < 0.02) micSilentFramesRef.current += 1;
      else micSilentFramesRef.current = 0;
      const silentNow = micSilentFramesRef.current > 40;
      if (silentNow !== micSilentRef.current) {
        micSilentRef.current = silentNow;
        setMicSilent(silentNow);
      }
      micMeterRafRef.current = requestAnimationFrame(tick);
    };
    micMeterRafRef.current = requestAnimationFrame(tick);
  };

  const stopMeter = () => {
    cancelAnimationFrame(micMeterRafRef.current);
    micMeterRafRef.current = null;
    micAnalyserRef.current = null;
    micLevelBufRef.current = null;
    micMeterElsRef.current = [];
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }
    previewAnalyserRef.current = null;
    previewSrcRef.current = null;
    previewSrcElRef.current = null;
    if (previewAudioCtxRef.current) {
      previewAudioCtxRef.current.close().catch(() => {});
      previewAudioCtxRef.current = null;
    }
    micSilentFramesRef.current = 0;
    micSilentRef.current = false;
    setMicSilent(false);
  };

  // Animate the meter bars from the preview audio's real amplitude while the
  // recorded clip is playing back (preview mode, after pausing).
  const startPreviewMeter = () => {
    cancelAnimationFrame(micMeterRafRef.current);
    const audio = micPreviewAudioRef.current;
    if (!audio || !micPreviewUrlRef.current) return;
    if (!previewAudioCtxRef.current) {
      previewAudioCtxRef.current = new AudioContext();
    }
    const ctx = previewAudioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    // Route the preview element through the graph (only once per element) so we
    // can read its amplitude; it keeps playing via the ctx destination.
    if (!previewSrcRef.current || previewSrcElRef.current !== audio) {
      const src = ctx.createMediaElementSource(audio);
      previewSrcRef.current = src;
      previewSrcElRef.current = audio;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      previewAnalyserRef.current = analyser;
      src.connect(analyser);
      analyser.connect(ctx.destination);
    }
    const analyser = previewAnalyserRef.current;
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      const an = previewAnalyserRef.current;
      if (!an) return;
      if (an.context.state === "suspended") an.context.resume().catch(() => {});
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      const bars = micMeterElsRef.current;
      for (let i = 0; i < bars.length; i++) {
        const el = bars[i];
        if (!el) continue;
        const jitter = 0.55 + Math.random() * 0.45;
        el.style.height = `${Math.max(8, Math.min(100, level * 100 * jitter))}%`;
      }
      micMeterRafRef.current = requestAnimationFrame(tick);
    };
    micMeterRafRef.current = requestAnimationFrame(tick);
  };

  const stopPreviewMeter = () => {
    cancelAnimationFrame(micMeterRafRef.current);
    micMeterRafRef.current = null;
    previewAnalyserRef.current = null;
    previewSrcRef.current = null;
    previewSrcElRef.current = null;
  };

  // Hold-to-record: press and hold the mic to record, release to send.
  const handleMicPointerDown = (e) => {
    if (recording) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    micHoldRef.current = {
      startY: e.clientY,
      startTime: Date.now(),
      cancelled: false,
    };
    startRecording();
  };

  // Slide up while holding to cancel (WhatsApp-style).
  const handleMicPointerMove = (e) => {
    const hold = micHoldRef.current;
    if (!hold || hold.cancelled || recordingLocked) return;
    if (hold.startY - e.clientY > 80) {
      hold.cancelled = true;
      cancelRecording();
    }
  };

  const handleMicPointerUp = () => {
    const hold = micHoldRef.current;
    micHoldRef.current = null;
    if (!hold || hold.cancelled) return;
    if (micActiveRef.current) {
      // A quick tap locks the recording so it can be sent/cancelled with buttons.
      if (Date.now() - hold.startTime < 300) {
        setRecordingLocked(true);
      } else {
        stopRecording();
      }
    } else {
      // Mic permission was still pending when released -> lock instead of losing it.
      micReleasedRef.current = true;
      setRecordingLocked(true);
    }
  };

  const handleMicPointerCancel = () => {
    const hold = micHoldRef.current;
    micHoldRef.current = null;
    if (hold && !hold.cancelled && !recordingLocked) {
      hold.cancelled = true;
      cancelRecording();
    }
  };

  const clearPreview = () => {
    if (micPreviewUrlRef.current) {
      URL.revokeObjectURL(micPreviewUrlRef.current);
      micPreviewUrlRef.current = null;
    }
    const audio = micPreviewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    setPreviewPlaying(false);
  };

  const pauseRecording = async () => {
    if (recordingPaused) return;
    const r = mediaRecorderRef.current;
    if (!r) return;
    // Flush the buffered audio so the preview reflects everything said so far.
    // requestData()'s dataavailable arrives asynchronously (and doesn't return
    // a real promise in all browsers), so poll until the chunk has landed.
    const sizeBefore = recordingChunksRef.current.reduce((s, c) => s + c.size, 0);
    try {
      if (typeof r.requestData === "function") r.requestData();
    } catch {
      /* requestData is optional */
    }
    await new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const size = recordingChunksRef.current.reduce((s, c) => s + c.size, 0);
        if (size > sizeBefore || Date.now() - start > 500) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    try {
      await r.pause();
    } catch {
      /* ignore */
    }
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    cancelAnimationFrame(micMeterRafRef.current);
    micMeterRafRef.current = null;
    micSilentRef.current = false;
    setMicSilent(false);
    // Build a playable clip of what's been recorded so far.
    try {
      const blob = new Blob(recordingChunksRef.current, { type: recorderMimeRef.current });
      if (micPreviewUrlRef.current) URL.revokeObjectURL(micPreviewUrlRef.current);
      micPreviewUrlRef.current = URL.createObjectURL(blob);
    } catch {
      /* preview is optional */
    }
    setRecordingPaused(true);
  };

  const resumeRecording = () => {
    if (!recordingPaused) return;
    const r = mediaRecorderRef.current;
    if (!r) return;
    // Stop any preview playback before continuing to record.
    const audio = micPreviewAudioRef.current;
    if (audio) audio.pause();
    setPreviewPlaying(false);
    try {
      r.resume();
    } catch {
      /* ignore */
    }
    recordingTimerRef.current = setInterval(() => {
      recordingSecondsRef.current += 1;
      setRecordingSeconds(recordingSecondsRef.current);
    }, 1000);
    startMeterLoop();
    setRecordingPaused(false);
  };

  const togglePreview = () => {
    const audio = micPreviewAudioRef.current;
    if (!audio || !micPreviewUrlRef.current) return;
    if (previewPlaying) {
      audio.pause();
      stopPreviewMeter();
      setPreviewPlaying(false);
    } else {
      audio.src = micPreviewUrlRef.current;
      audio.onended = () => {
        stopPreviewMeter();
        setPreviewPlaying(false);
      };
      startPreviewMeter();
      audio.play().then(() => setPreviewPlaying(true)).catch(() => {
        stopPreviewMeter();
        setPreviewPlaying(false);
      });
    }
  };

  const stopRecording = () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    stopMeter();
    clearPreview();
    setRecording(false);
    setRecordingLocked(false);
    setRecordingPaused(false);
    setRecordingSeconds(0);
    const r = mediaRecorderRef.current;
    if (r) {
      r.stop();
      mediaRecorderRef.current = null;
    }
    micActiveRef.current = false;
    micReleasedRef.current = false;
  };

  const cancelRecording = () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    stopMeter();
    clearPreview();
    recordingSecondsRef.current = 0;
    setRecording(false);
    setRecordingLocked(false);
    setRecordingPaused(false);
    setRecordingSeconds(0);
    const r = mediaRecorderRef.current;
    if (r) {
      r.ondataavailable = null;
      r.onstop = null;
      try {
        r.stop();
      } catch {
        /* ignore */
      }
      mediaRecorderRef.current = null;
    }
    micActiveRef.current = false;
    micReleasedRef.current = false;
    micHoldRef.current = null;
  };

  const sendVoice = async (blob, ext = "webm") => {
    const duration = recordingSecondsRef.current || 1;
    recordingSecondsRef.current = 0;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", blob, `voice.${ext}`);
      const res = await api.post("/upload", formData);
      const { url, name, size, mimeType } = res.data;
      const payload = {
        conversationId: selectedConversation,
        type: "voice",
        duration,
        file: { url, name, size, mimeType },
      };
      sendSocket(
        payload,
        () =>
          sendViaApi(payload).catch((err) =>
            setError(err.response?.data?.message || "Failed to send voice message")
          )
      );
    } catch (err) {
      setError(err.response?.data?.message || "Failed to send voice message");
    } finally {
      setUploading(false);
    }
  };

  const toggleVoice = (m) => {
    const audio = voiceEls.current[m._id];
    if (!audio) return;

    if (playingVoice === m._id) {
      audio.pause();
      setPlayingVoice(null);
      return;
    }

    Object.entries(voiceEls.current).forEach(([id, el]) => {
      if (id !== m._id && el) {
        el.pause();
        el.currentTime = 0;
        const wave = voiceWaveRefs.current[id];
        if (wave) setVoiceProgress(wave, 0);
      }
    });

    if (audio.ended) audio.currentTime = 0;
    setPlayingVoice(m._id);
    audio.play().catch(() => setPlayingVoice(null));
  };

  // Inset for the playhead dot: half the dot plus its accent ring, so neither
  // the dot nor the ring is ever clipped by the waveform's overflow.
  const VOICE_PLAYHEAD_PAD = 10;
  const setVoiceProgress = (wave, ratioPct) => {
    wave.style.setProperty("--play-progress", `${ratioPct}%`);
    const w = wave.clientWidth || 0;
    wave.style.setProperty(
      "--play-x",
      `${(ratioPct / 100) * Math.max(0, w - 2 * VOICE_PLAYHEAD_PAD) + VOICE_PLAYHEAD_PAD}px`
    );
  };

  // Drive the playhead smoothly (rAF) instead of jumping on timeupdate ticks.
  useEffect(() => {
    if (!playingVoice) return;
    let raf;
    const tick = () => {
      const seek = voiceSeekRef.current;
      if (!(seek && seek.dragging && seek.id === playingVoice)) {
        const audio = voiceEls.current[playingVoice];
        const wave = voiceWaveRefs.current[playingVoice];
        if (audio && wave && audio.duration) {
          setVoiceProgress(
            wave,
            Math.min(100, (audio.currentTime / audio.duration) * 100)
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playingVoice]);

  const seekVoiceTo = (wave, audio, clientX) => {
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setVoiceProgress(wave, ratio * 100);
    if (audio.duration) audio.currentTime = ratio * audio.duration;
  };

  const handleVoiceSeekStart = (m) => (e) => {
    const wave = voiceWaveRefs.current[m._id];
    const audio = voiceEls.current[m._id];
    if (!wave || !audio || !audio.duration) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    voiceSeekRef.current = { id: m._id, audio, wave, dragging: true };
    wave.classList.add("seeking");
    seekVoiceTo(wave, audio, e.clientX);
  };

  const handleVoiceSeekMove = (m) => (e) => {
    const seek = voiceSeekRef.current;
    if (!seek || seek.id !== m._id || e.buttons === 0) return;
    seekVoiceTo(seek.wave, seek.audio, e.clientX);
  };

  const handleVoiceSeekEnd = (m) => () => {
    const seek = voiceSeekRef.current;
    if (!seek || seek.id !== m._id) return;
    seek.wave.classList.remove("seeking");
    voiceSeekRef.current = null;
  };

  // Build waveform bars for voice messages (real audio, placeholder while decoding).
  useEffect(() => {
    const targets = messages.filter(
      (m) => m.type === "voice" && m.file?.url && !waveforms[m._id]
    );
    if (!targets.length) return;
    targets.forEach((m) =>
      setWaveforms((prev) =>
        prev[m._id]
          ? prev
          : {
              ...prev,
              [m._id]: fallbackWaveform(m._id.length + (m._id.charCodeAt(0) || 0)),
            }
      )
    );
    targets.forEach((m) => {
      computeWaveform(SERVER_URL + m.file.url).then((heights) => {
        if (heights) setWaveforms((prev) => ({ ...prev, [m._id]: heights }));
      });
    });
  }, [messages, waveforms]);

  const formatDuration = (s) => {
    const secs = Math.max(0, Math.round(Number(s) || 0));
    const m = Math.floor(secs / 60);
    const sec = secs % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  // ---- View-once media ----
  const openViewOnce = (m) => {
    const isVideo = m.type === "video" || m.file?.mimeType?.startsWith("video/");
    setViewOnceMedia({
      url: SERVER_URL + (m.file?.url || ""),
      isVideo,
    });
    api
      .post(`/messages/${m._id}/consume-view`)
      .then((res) => {
        setMessages((prev) =>
          prev.map((x) => (x._id === m._id ? res.data : x))
        );
      })
      .catch(() => {
        /* ignore */
      });
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
      setGroupInfoOpen(false);
      setNotice("You left the group");
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to leave group");
    }
  };

  // ---- Group admin tools ----
  const removeMember = async (conv, member) => {
    if (!window.confirm(`Remove ${member.username} from the group?`)) return;
    try {
      await api.delete(`/conversations/${conv._id}/members/${member._id}`);
      setNotice(`${member.username} removed`);
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to remove member");
    }
  };

  const promoteAdmin = async (conv, member) => {
    try {
      await api.post(`/conversations/${conv._id}/admins`, {
        userId: member._id,
        action: "promote",
      });
      setNotice(`${member.username} is now an admin`);
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to promote member");
    }
  };

  const demoteAdmin = async (conv, member) => {
    try {
      await api.post(`/conversations/${conv._id}/admins`, {
        userId: member._id,
        action: "demote",
      });
      setNotice(`${member.username} is no longer an admin`);
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to demote member");
    }
  };

  const transferOwnership = async (conv, member) => {
    if (
      !window.confirm(
        `Transfer group ownership to ${member.username}? You will become an admin.`
      )
    )
      return;
    try {
      await api.post(`/conversations/${conv._id}/transfer`, {
        userId: member._id,
      });
      setNotice(`Ownership transferred to ${member.username}`);
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to transfer ownership");
    }
  };

  const renameGroup = async (conv) => {
    const name = window.prompt("New group name", conv.name);
    if (!name || !name.trim()) return;
    try {
      await api.put(`/conversations/${conv._id}/name`, { name: name.trim() });
      setNotice("Group renamed");
      await loadConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to rename group");
    }
  };

  // ---- Chat lock (PIN) ----
  const setChatPin = () => {
    const current = localStorage.getItem("chatLockPin");

    if (current) {
      const check = window.prompt("Enter your current PIN to change it");
      if (check !== current) {
        setError("Incorrect PIN");
        return;
      }
    }

    const p1 = window.prompt("Enter a 4-6 digit PIN to lock your chat");
    if (!p1) return;
    if (!/^\d{4,6}$/.test(p1)) {
      setError("PIN must be 4-6 digits");
      return;
    }

    const p2 = window.prompt("Confirm your PIN");
    if (p1 !== p2) {
      setError("PINs do not match");
      return;
    }

    localStorage.setItem("chatLockPin", p1);
    setHasPin(true);
    setNotice("Chat PIN set");
  };

  const removeChatPin = () => {
    const current = localStorage.getItem("chatLockPin");
    if (!current) return;

    const check = window.prompt("Enter your PIN to remove the lock");
    if (check !== current) {
      setError("Incorrect PIN");
      return;
    }

    localStorage.removeItem("chatLockPin");
    setHasPin(false);
    setLocked(false);
    setPinError("");
    setNotice("Chat lock removed");
  };

  const lockNow = () => {
    if (!localStorage.getItem("chatLockPin")) {
      setChatPin();
      return;
    }
    setPinInput("");
    setPinError("");
    setLocked(true);
  };

  const unlock = () => {
    if (pinInput === localStorage.getItem("chatLockPin")) {
      setLocked(false);
      setPinInput("");
      setPinError("");
    } else {
      setPinError("Incorrect PIN");
      setPinInput("");
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

  // Messages the current user has starred in this conversation.
  const starredMessages = useMemo(
    () =>
      messages.filter(
        (m) => !m.deleted && (m.starredBy || []).includes(user.id)
      ),
    [messages, user.id]
  );

  // Chats the "Forward" modal can send to (all except the currently open one).
  const forwardTargets = useMemo(
    () =>
      conversations.filter(
        (c) => c._id !== selectedConversation && !c.isArchived
      ),
    [conversations, selectedConversation]
  );

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
  // Render text, highlighting @all mentions (and the in-chat search query).
  const renderText = (text) => {
    const segs = (text || "").split(/(@all|@everyone)/gi);
    return segs.map((seg, i) => {
      if (/^@(all|everyone)$/i.test(seg)) {
        return (
          <mark key={i} className="mention-all">
            @all
          </mark>
        );
      }
      return <Fragment key={i}>{highlight(seg)}</Fragment>;
    });
  };

  const renderContent = (m) => {
    if (m.deleted) {
      return (
        <div className="message-deleted">This message has been deleted</div>
      );
    }

    if (m.type === "image" || m.type === "video") {
      const isVideo = m.type === "video";
      const isOwn = m.sender?._id === user.id;
      if (m.viewOnce) {
        if (m.viewedOnce) {
          return (
            <div className="message-deleted view-once-opened">
              {isVideo ? "🎥 Video opened" : "📷 Photo opened"}
            </div>
          );
        }
        if (isOwn) {
          return (
            <div className="view-once-button view-once-own">
              <span className="view-once-blur" />
              <span className="view-once-label">
                {isVideo ? "🔒 View-once video" : "🔒 View-once photo"}
              </span>
            </div>
          );
        }
        return (
          <button className="view-once-button" onClick={() => openViewOnce(m)}>
            <span className="view-once-blur" />
            <span className="view-once-label">
              {isVideo ? "▶ View once" : "👁 View once"}
            </span>
          </button>
        );
      }
      if (isVideo) {
        return (
          <video
            className="message-video"
            src={SERVER_URL + m.file?.url}
            controls
            playsInline
            preload="metadata"
          />
        );
      }
      return (
        <button
          className="message-image-btn"
          onClick={() =>
            openLightbox(
              SERVER_URL + m.file?.url,
              m.file?.name || "image.png"
            )
          }
        >
          <img
            className="message-image"
            src={SERVER_URL + m.file?.url}
            alt={m.file?.name || "image"}
          />
        </button>
      );
    }

    if (m.type === "voice") {
      const wave = waveforms[m._id] || [];
      return (
        <div className="voice-message">
          <button
            className={`voice-play${playingVoice === m._id ? " playing" : ""}`}
            onClick={() => toggleVoice(m)}
          >
            {playingVoice === m._id ? "❚❚" : "▶"}
          </button>
          <div
            className={"voice-waveform" + (playingVoice === m._id ? " playing" : "")}
            onPointerDown={handleVoiceSeekStart(m)}
            onPointerMove={handleVoiceSeekMove(m)}
            onPointerUp={handleVoiceSeekEnd(m)}
            onPointerCancel={handleVoiceSeekEnd(m)}
            ref={(el) => {
              if (el) {
                voiceWaveRefs.current[m._id] = el;
                const setW = () =>
                  el.style.setProperty("--wave-width", `${el.clientWidth}px`);
                setW();
                if (!el.__ro) {
                  el.__ro = new ResizeObserver(setW);
                  el.__ro.observe(el);
                }
              } else {
                delete voiceWaveRefs.current[m._id];
              }
            }}
          >
            <div className="voice-wave-bars">
              {wave.map((h, i) => (
                <span key={i} style={{ height: `${h * 100}%` }} />
              ))}
            </div>
            <div className="voice-wave-progress">
              <div className="voice-wave-bars">
                {wave.map((h, i) => (
                  <span key={i} style={{ height: `${h * 100}%` }} />
                ))}
              </div>
            </div>
            <span className="voice-playhead" />
          </div>
          <span
            className="voice-duration"
            ref={(el) => {
              if (el) voiceTimeRefs.current[m._id] = el;
              else delete voiceTimeRefs.current[m._id];
            }}
          >
            {formatDuration(m.duration)}
          </span>
          <audio
            ref={(el) => {
              if (el) voiceEls.current[m._id] = el;
              else delete voiceEls.current[m._id];
            }}
            src={SERVER_URL + m.file?.url}
            preload="metadata"
            onTimeUpdate={(e) => {
              const t = voiceTimeRefs.current[m._id];
              const a = e.currentTarget;
              if (t && a.duration) t.textContent = formatDuration(a.currentTime);
            }}
            onEnded={() => {
              const wave = voiceWaveRefs.current[m._id];
              if (wave) setVoiceProgress(wave, 0);
              const t = voiceTimeRefs.current[m._id];
              if (t) t.textContent = formatDuration(m.duration);
              setPlayingVoice(null);
            }}
            onError={() => setPlayingVoice(null)}
          />
        </div>
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

    if (m.type === "poll" && m.poll) {
      const totalVotes = (m.poll.options || []).reduce(
        (sum, o) => sum + (o.votes?.length || 0),
        0
      );
      return (
        <div className="poll-card">
          <div className="poll-question">{m.poll.question}</div>
          <div className="poll-options">
            {m.poll.options.map((o, i) => {
              const voted = (o.votes || []).some(
                (v) => String(v?._id || v) === String(user.id)
              );
              const count = o.votes?.length || 0;
              const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
              return (
                <button
                  key={i}
                  className={"poll-option" + (voted ? " voted" : "")}
                  onClick={() => votePoll(m, i)}
                >
                  <span
                    className="poll-option-bar"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="poll-option-text">{o.text}</span>
                  <span className="poll-option-meta">
                    {voted ? "✓ " : ""}
                    {count} · {pct}%
                  </span>
                </button>
              );
            })}
          </div>
          <div className="poll-total">
            {totalVotes} vote{totalVotes === 1 ? "" : "s"}
          </div>
        </div>
      );
    }

    return <div className="message-text">{renderText(m.text)}</div>;
  };

  const previewText = (m) => {
    if (!m) return "No messages yet";
    if (m.deleted) return "This message has been deleted";
    if (m.type === "image") return m.viewOnce ? "📷 View-once photo" : "📷 Photo";
    if (m.type === "video") return m.viewOnce ? "🎥 View-once video" : "🎥 Video";
    if (m.type === "voice") return "🎤 Voice message";
    if (m.type === "file") return `📎 ${m.file?.name || "File"}`;
    if (m.type === "poll") return `📊 ${m.poll?.question || "Poll"}`;
    const prefix = (m.sender?._id === user.id ? "You: " : "") + m.text;
    return mentionsAll(m.text) ? `📣 ${prefix}` : prefix;
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
            <div className="user-status">
              {user.status || "Hey there! I am using ChatApp."}
            </div>
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
                    {u.handle && <div className="user-handle">@{u.handle}</div>}
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
                          : {
                              username: other.username,
                              avatar: other.avatar,
                              handle: other.handle,
                            }
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
                    title={isGroup ? "Group info" : "View profile"}
                    onClick={() => {
                      if (isGroup) {
                        setGroupInfoOpen(true);
                      } else {
                        setProfileFromChat(true);
                        setProfileUser(other);
                      }
                    }}
                  >
                    <Avatar
                      user={
                        isGroup
                          ? { username: conv.name }
                          : {
                              username: other.username,
                              avatar: other.avatar,
                              handle: other.handle,
                            }
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
                        {conv.disappearTime > 0 && (
                          <span
                            className="mute-indicator"
                            title={`Messages disappear after ${formatDisappear(conv.disappearTime)}`}
                          >
                            ⏳
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
                              Media, files &amp; links
                            </button>
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowStarredModal(true);
                              }}
                            >
                              ⭐ Starred messages
                            </button>
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowThemePicker(true);
                              }}
                            >
                              Change chat theme
                            </button>
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowBackgroundPicker(true);
                              }}
                            >
                              Change chat background
                            </button>
                            {isMutedNow(conv) ? (
                              <button onClick={() => unmuteConversation(conv)}>
                                Unmute notifications
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  setChatMenuOpen(false);
                                  setShowMutePicker(true);
                                }}
                              >
                                Mute notifications
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setShowDisappearPicker(true);
                              }}
                            >
                              {conv.disappearTime > 0
                                ? `Disappearing: ${formatDisappear(conv.disappearTime)}`
                                : "Disappearing messages"}
                            </button>
                            {isGroup && (
                              <button
                                onClick={() => {
                                  setChatMenuOpen(false);
                                  renameGroup(conv);
                                }}
                              >
                                Rename group
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setChatMenuOpen(false);
                                setPollQuestion("");
                                setPollOptions(["", ""]);
                                setShowPollModal(true);
                              }}
                            >
                              📊 Create poll
                            </button>
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
                                  ? "Unblock user"
                                  : "Block user"}
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
                              {m.replyTo && !m.deleted && (
                                <div
                                  className="reply-preview"
                                  onClick={() => jumpToMessage(m.replyTo._id)}
                                  title="View original message"
                                >
                                  <div className="reply-preview-name">
                                    {m.replyTo.sender?._id === user.id
                                      ? "You"
                                      : m.replyTo.sender?.username}
                                  </div>
                                  <div className="reply-preview-text">
                                    {replySnippet(m.replyTo)}
                                  </div>
                                </div>
                              )}
                              {m.forwardedFrom && !m.deleted && (
                                <div className="forwarded-label">
                                  ↪ Forwarded
                                </div>
                              )}
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
                                {isStarred(m) && (
                                  <span className="edited-label" title="Starred">
                                    ⭐
                                  </span>
                                )}
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
                                      <button onClick={() => startReply(m)}>
                                        ↩ Reply
                                      </button>
                                      {mine && canEdit(m) && (
                                        <button onClick={() => startEdit(m)}>
                                          Edit
                                        </button>
                                      )}
                                      <button
                                        onClick={() => toggleStar(m)}
                                      >
                                        {isStarred(m) ? "Unstar message" : "Star message"}
                                      </button>
                                      {canForward(m) && (
                                        <button
                                          onClick={() => {
                                            setMenuOpen(null);
                                            setForwardingMessage(m);
                                          }}
                                        >
                                          → Forward
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
                                  <div
                                    className={
                                      "message-actions" +
                                      (reactionPickerFor === m._id
                                        ? " open"
                                        : "")
                                    }
                                  >
                                    <button
                                      className="icon-button"
                                      title="Reply"
                                      onClick={() => startReply(m)}
                                    >
                                      ↩
                                    </button>
                                    {["👍", "❤️", "😂"].map((e) => (
                                      <button
                                        key={e}
                                        className="icon-button"
                                        title={`React ${e}`}
                                        onClick={() => toggleReaction(m, e)}
                                      >
                                        {e}
                                      </button>
                                    ))}
                                    <button
                                      className={
                                        "icon-button" +
                                        (reactionPickerFor === m._id
                                          ? " active"
                                          : "")
                                      }
                                      title="Add reaction"
                                      onClick={() =>
                                        setReactionPickerFor(
                                          reactionPickerFor === m._id
                                            ? null
                                            : m._id
                                        )
                                      }
                                    >
                                      +
                                    </button>
                                    {reactionPickerFor === m._id && (
                                      <div className="reaction-picker">
                                        {EMOJIS.map((e) => (
                                          <button
                                            key={e}
                                            className="emoji-item"
                                            title={`React ${e}`}
                                            onClick={() => {
                                              toggleReaction(m, e);
                                              setReactionPickerFor(null);
                                            }}
                                          >
                                            {e}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  {Object.keys(reactionCounts(m)).length > 0 && (
                                    <div className="reaction-row">
                                      {Object.entries(reactionCounts(m)).map(
                                        ([emoji, count]) => (
                                          <button
                                            key={emoji}
                                            className={
                                              "reaction-chip" +
                                              (myReaction(m)?.emoji === emoji
                                                ? " mine"
                                                : "")
                                            }
                                            onClick={() =>
                                              toggleReaction(m, emoji)
                                            }
                                            title={`${count} reaction${count > 1 ? "s" : ""}`}
                                          >
                                            <span>{emoji}</span>
                                            <span className="reaction-count">
                                              {count}
                                            </span>
                                          </button>
                                        )
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
                  <>
                    {replyTarget && (
                      <div className="reply-bar">
                        <span className="reply-bar-icon">↩</span>
                        <div className="reply-bar-info">
                          <div className="reply-bar-name">
                            {replyTarget.sender?._id === user.id
                              ? "You"
                              : replyTarget.sender?.username}
                          </div>
                          <div className="reply-bar-text">
                            {replySnippet(replyTarget)}
                          </div>
                        </div>
                        <button
                          className="reply-bar-close"
                          title="Cancel reply"
                          onClick={() => setReplyTarget(null)}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <form className="message-input-bar" onSubmit={handleSend}>
                      <div className={"chatbox" + (recording ? " recording" : "")}>
                        <EmojiPicker
                          key={recording ? "emoji-recording" : "emoji-idle"}
                          onSelect={(e) => setNewMessage((prev) => prev + e)}
                        />
                      <div className="attach-wrap">
                        <button
                          type="button"
                          className={
                            "attach-button plus-button icon-button" +
                            (uploading ? " disabled" : "")
                          }
                          title="Attach"
                          disabled={uploading}
                          onClick={() => setAttachMenuOpen((v) => !v)}
                        >
                          {uploading ? "⏳" : "+"}
                        </button>
                        {attachMenuOpen && (
                          <div className="attach-menu">
                            <label
                              className={"attach-menu-item" + (uploading ? " disabled" : "")}
                            >
                              <span className="attach-menu-icon photo">📷</span>
                              Photo
                              <input
                                type="file"
                                accept="image/*"
                                hidden
                                disabled={uploading}
                                onChange={handleVisualSelect}
                              />
                            </label>
                            <label
                              className={"attach-menu-item" + (uploading ? " disabled" : "")}
                            >
                              <span className="attach-menu-icon video">🎥</span>
                              Video
                              <input
                                type="file"
                                accept="video/*"
                                hidden
                                disabled={uploading}
                                onChange={handleVisualSelect}
                              />
                            </label>
                            <label
                              className={"attach-menu-item" + (uploading ? " disabled" : "")}
                            >
                              <span className="attach-menu-icon doc">📎</span>
                              Document
                              <input
                                type="file"
                                hidden
                                disabled={uploading}
                                onChange={handleFileSelect}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                      {recording ? (
                        <div className={`recording-bar${recordingLocked ? " locked" : ""}${micSilent ? " silent" : ""}${recordingPaused ? " paused" : ""}${previewPlaying ? " preview-playing" : ""}`}>
                          <span className={"recording-dot" + (recordingPaused ? " paused" : "")} />
                          <span className="recording-time">
                            {formatDuration(recordingSeconds)}
                          </span>
                          <div className={"recording-meter" + (recordingPaused ? " paused" : "")}>
                            {Array.from({ length: RECORDING_METER_BARS }).map((_, i) => (
                              <span
                                key={i}
                                ref={(el) => {
                                  if (el) micMeterElsRef.current[i] = el;
                                }}
                              />
                            ))}
                          </div>
                          <span className="recording-hint">
                            {recordingPaused
                              ? "Paused — listen or resume"
                              : micSilent
                                ? "🔇 No sound — check your mic"
                                : recordingLocked
                                  ? "Tap ➤ to send"
                                  : "Slide up to cancel"}
                          </span>
                          {recordingPaused && (
                            <button
                              type="button"
                              className={"recording-preview" + (previewPlaying ? " playing" : "")}
                              title="Play what you said"
                              onClick={togglePreview}
                            >
                              🔊
                            </button>
                          )}
                          <button
                            type="button"
                            className="recording-pause"
                            title={recordingPaused ? "Resume recording" : "Pause recording"}
                            onClick={recordingPaused ? resumeRecording : pauseRecording}
                          >
                            {recordingPaused ? "▶️" : "⏸"}
                          </button>
                          <button
                            type="button"
                            className="recording-cancel"
                            title="Cancel recording"
                            onClick={cancelRecording}
                          >
                            ✕
                          </button>
                          <audio ref={micPreviewAudioRef} className="recording-preview-audio" />
                        </div>
                      ) : (
                        <input
                          type="text"
                          placeholder="Type a message..."
                          value={newMessage}
                          onChange={(e) => {
                            setNewMessage(e.target.value);
                            handleTyping();
                          }}
                        />
                      )}
                      <button
                        className={`mic-button icon-button${recording ? " recording" : ""}`}
                        type="button"
                        title="Hold to record a voice message (release to send, slide up to cancel)"
                        onPointerDown={handleMicPointerDown}
                        onPointerMove={handleMicPointerMove}
                        onPointerUp={handleMicPointerUp}
                        onPointerCancel={handleMicPointerCancel}
                      >
                        🎤
                      </button>
                      <button
                        className="send-button"
                        type={recording ? "button" : "submit"}
                        title={recording ? "Send voice message" : "Send"}
                        onClick={recording ? stopRecording : undefined}
                        disabled={!recording && !newMessage.trim()}
                      >
                        {recording ? "➤" : "➤"}
                      </button>
                    </div>
                  </form>
                  </>
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
                  <span className="request-name">
                    {fr.requester.username}
                    {fr.requester.handle && (
                      <span className="user-handle"> @{fr.requester.handle}</span>
                    )}
                  </span>
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
                  <span className="request-name">
                    {friend.username}
                    {friend.handle && (
                      <span className="user-handle"> @{friend.handle}</span>
                    )}
                  </span>
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

      {groupInfoOpen && activeConv?.type === "group" && (
        (() => {
          const members = activeConv.participants || [];
          const isOwnerNow = activeConv.admin === user.id;
          const isAdminNow = activeConv.isAdmin;

          return (
            <div className="modal-overlay" onClick={() => setGroupInfoOpen(false)}>
              <div className="modal group-info-modal" onClick={(e) => e.stopPropagation()}>
                <h3>Group info</h3>
                <div className="group-info-head">
                  <Avatar user={{ username: activeConv.name }} />
                  <div className="group-info-name">
                    {activeConv.name}
                    {(isOwnerNow || isAdminNow) && (
                      <button
                        className="mini-button"
                        onClick={() => renameGroup(activeConv)}
                      >
                        Rename
                      </button>
                    )}
                  </div>
                </div>
                <div className="group-info-count">
                  {members.length} members
                  <button
                    className="mini-button"
                    onClick={() => openGroupModal("add", activeConv)}
                  >
                    ＋ Add
                  </button>
                </div>
                <div className="group-member-list">
                  {members.map((m) => {
                    const isMe = m._id === user.id;
                    const isMemberOwner = m._id === activeConv.admin;
                    const isMemberAdmin = (activeConv.admins || []).includes(
                      m._id
                    );

                    return (
                      <div className="group-member-row" key={m._id}>
                        <Avatar user={m} small />
                        <div className="group-member-info">
                          <div className="group-member-name">
                            {m.username}
                            {isMe && (
                              <span className="group-member-me"> (you)</span>
                            )}
                            {isMemberOwner && (
                              <span className="group-badge owner" title="Owner">
                                👑
                              </span>
                            )}
                            {!isMemberOwner && isMemberAdmin && (
                              <span className="group-badge" title="Admin">
                                🛡️
                              </span>
                            )}
                          </div>
                          {m.handle && (
                            <div className="user-handle">@{m.handle}</div>
                          )}
                        </div>
                        {isMe ? (
                          <button
                            className="mini-button decline"
                            onClick={() => leaveGroup(activeConv)}
                          >
                            Leave
                          </button>
                        ) : isOwnerNow ? (
                          <div className="group-member-actions">
                            {isMemberAdmin && (
                              <button
                                className="mini-button"
                                title="Remove admin"
                                onClick={() => demoteAdmin(activeConv, m)}
                              >
                                ⬇
                              </button>
                            )}
                            {!isMemberOwner && !isMemberAdmin && (
                              <button
                                className="mini-button"
                                title="Make admin"
                                onClick={() => promoteAdmin(activeConv, m)}
                              >
                                ⬆
                              </button>
                            )}
                            {!isMemberOwner && (
                              <button
                                className="mini-button"
                                title="Transfer ownership"
                                onClick={() => transferOwnership(activeConv, m)}
                              >
                                👑
                              </button>
                            )}
                            {!isMemberOwner && (
                              <button
                                className="mini-button decline"
                                title="Remove from group"
                                onClick={() => removeMember(activeConv, m)}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        ) : isAdminNow && !isMemberOwner && !isMemberAdmin ? (
                          <div className="group-member-actions">
                            <button
                              className="mini-button decline"
                              title="Remove from group"
                              onClick={() => removeMember(activeConv, m)}
                            >
                              ✕
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="modal-actions">
                  <button
                    className="auth-button"
                    onClick={() => setGroupInfoOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })()
      )}

      {showStarredModal && (
        <div className="modal-overlay" onClick={() => setShowStarredModal(false)}>
          <div className="modal starred-modal" onClick={(e) => e.stopPropagation()}>
            <h3>⭐ Starred messages</h3>
            {starredMessages.length === 0 ? (
              <div className="empty-hint">
                No starred messages yet. Use the ⭐ button on a message to save it here.
              </div>
            ) : (
              <div className="starred-list">
                {starredMessages.map((m) => (
                  <div className="starred-row" key={m._id}>
                    <Avatar user={m.sender} small />
                    <div className="starred-info">
                      <div className="starred-sender">
                        {m.sender?._id === user.id ? "You" : m.sender?.username}
                      </div>
                      <div className="starred-text">{replySnippet(m)}</div>
                    </div>
                    <span className="starred-time">{formatTime(m.createdAt)}</span>
                    <button
                      className="mini-button"
                      title="Unstar"
                      onClick={() => toggleStar(m)}
                    >
                      ⭐
                    </button>
                    <button
                      className="mini-button"
                      title="Jump to message"
                      onClick={() => {
                        setShowStarredModal(false);
                        jumpToMessage(m._id);
                      }}
                    >
                      ⤴
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="auth-button"
                onClick={() => setShowStarredModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {forwardingMessage && (
        <div className="modal-overlay" onClick={() => setForwardingMessage(null)}>
          <div className="modal forward-modal" onClick={(e) => e.stopPropagation()}>
            <h3>↪ Forward message</h3>
            {forwardTargets.length === 0 ? (
              <div className="empty-hint">No chats to forward to.</div>
            ) : (
              <div className="modal-user-list">
                {forwardTargets.map((c) => {
                  const other = otherUser(c);
                  return (
                    <button
                      key={c._id}
                      className="modal-user"
                      onClick={() => forwardMessageTo(c)}
                    >
                      <Avatar
                        user={
                          c.type === "group"
                            ? { username: c.name }
                            : {
                                username: other.username,
                                avatar: other.avatar,
                                handle: other.handle,
                              }
                        }
                        small
                      />
                      <span className="modal-user-name">
                        {c.type === "group" ? "👥 " + c.name : other.username}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="auth-button"
                onClick={() => setForwardingMessage(null)}
              >
                Cancel
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
              {profileUser.handle && (
                <div className="profile-handle">@{profileUser.handle}</div>
              )}
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
            <div className="profile-detail">
              <span>Status</span>
              <div>{profileUser.status || "Hey there! I am using ChatApp."}</div>
            </div>
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
                      {mediaList.slice(0, 6).map((m) =>
                        m.kind === "image" ? (
                          <button
                            key={m._id}
                            className="profile-media-cell media-grid-btn"
                            title={mediaTitle(m)}
                            onClick={() =>
                              openLightbox(
                                SERVER_URL + m.file?.url,
                                m.file?.name || "photo.png"
                              )
                            }
                          >
                            <img
                              src={SERVER_URL + m.file?.url}
                              alt={mediaTitle(m)}
                            />
                          </button>
                        ) : (
                          <a
                            key={m._id}
                            className="profile-media-cell"
                            href={mediaUrl(m)}
                            target="_blank"
                            rel="noreferrer"
                            title={mediaTitle(m)}
                          >
                            <span className="profile-media-icon">
                              {m.kind === "file" ? "📎" : "🔗"}
                            </span>
                          </a>
                        )
                      )}
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

      {showDisappearPicker && activeConv && (
        <div
          className="modal-overlay blur"
          onClick={() => setShowDisappearPicker(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Disappearing messages</h3>
            <p className="mute-picker-note">
              Messages in this chat will disappear after the selected time, for
              everyone.
            </p>
            <div className="mute-options">
              {[
                [0, "Off"],
                [86400, "24 hours"],
                [604800, "7 days"],
                [7776000, "90 days"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setDisappearTime(activeConv, value)}
                >
                  {activeConv.disappearTime === value ? "● " : "○ "}
                  {label}
                </button>
              ))}
            </div>
            {activeConv.disappearTime > 0 && (
              <p className="mute-picker-note" style={{ marginTop: 10 }}>
                ⏳ Currently active — new and existing messages disappear after{" "}
                {formatDisappear(activeConv.disappearTime)}.
              </p>
            )}
          </div>
        </div>
      )}

      {showPollModal && (
        <div className="modal-overlay" onClick={() => setShowPollModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create poll</h3>
            <input
              className="poll-question-input"
              type="text"
              placeholder="Ask a question..."
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              autoFocus
            />
            <div className="poll-options-list">
              {pollOptions.map((opt, i) => (
                <div className="poll-option-row" key={i}>
                  <input
                    type="text"
                    placeholder={`Option ${i + 1}`}
                    value={opt}
                    onChange={(e) => {
                      const next = [...pollOptions];
                      next[i] = e.target.value;
                      setPollOptions(next);
                    }}
                  />
                  {pollOptions.length > 2 && (
                    <button
                      className="mini-button"
                      title="Remove option"
                      onClick={() =>
                        setPollOptions(
                          pollOptions.filter((_, j) => j !== i)
                        )
                      }
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            {pollOptions.length < 10 && (
              <button
                className="auth-button poll-add-option"
                style={{ background: "var(--bg)", color: "var(--text)" }}
                onClick={() => setPollOptions([...pollOptions, ""])}
              >
                ＋ Add option
              </button>
            )}
            <div className="modal-actions">
              <button
                className="auth-button"
                style={{ background: "var(--bg)", color: "var(--text)" }}
                onClick={() => setShowPollModal(false)}
              >
                Cancel
              </button>
              <button className="auth-button" onClick={createPoll}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingMedia && (
        <div className="modal-overlay" onClick={() => setPendingMedia(null)}>
          <div className="modal media-send-modal" onClick={(e) => e.stopPropagation()}>
            <div className="media-send-header">
              <h3>{pendingMedia.mimeType.startsWith("image/") ? "Photo" : "Video"}</h3>
              <button
                className="view-once-close"
                title="Cancel"
                onClick={() => setPendingMedia(null)}
              >
                ✕
              </button>
            </div>
            {pendingMedia.mimeType.startsWith("image/") ? (
              <img
                className="media-send-preview"
                src={SERVER_URL + pendingMedia.url}
                alt="preview"
              />
            ) : (
              <video
                className="media-send-preview"
                src={SERVER_URL + pendingMedia.url}
                controls
                playsInline
              />
            )}
            <div className="media-send-actions">
              <button className="btn" onClick={() => sendMedia(false)}>
                Send as public
              </button>
              <button className="btn primary" onClick={() => sendMedia(true)}>
                Send as view once
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="modal-overlay lightbox-overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox" onClick={(e) => e.stopPropagation()}>
            <div
              ref={lightboxStageRef}
              className={`lightbox-stage${(lightbox.zoom || 1) > 1 ? " zoomed" : ""}`}
              onDoubleClick={toggleLightboxZoom}
              onPointerDown={onLightboxPointerDown}
              onPointerMove={onLightboxPointerMove}
              onPointerUp={onLightboxPointerUp}
              onPointerCancel={onLightboxPointerUp}
            >
              <img
                ref={lightboxImgRef}
                src={lightbox.url}
                alt={lightbox.name}
                draggable={false}
                style={{
                  transform: `translate(${lightbox.pan?.x || 0}px, ${
                    lightbox.pan?.y || 0
                  }px) scale(${lightbox.zoom || 1})`,
                }}
              />
            </div>
            <div className="lightbox-actions">
              <div className="lightbox-zoom-controls">
                <button
                  className="lightbox-zoom-btn"
                  title="Zoom out"
                  disabled={(lightbox.zoom || 1) <= 1}
                  onClick={() => zoomLightboxBy(-1)}
                >
                  −
                </button>
                <span className="lightbox-zoom-level">
                  {Math.round((lightbox.zoom || 1) * 100)}%
                </span>
                <button
                  className="lightbox-zoom-btn"
                  title="Zoom in"
                  disabled={(lightbox.zoom || 1) >= 5}
                  onClick={() => zoomLightboxBy(1)}
                >
                  +
                </button>
                <button
                  className="lightbox-zoom-btn lightbox-zoom-reset"
                  title="Reset zoom"
                  onClick={resetLightboxZoom}
                >
                  ⟲
                </button>
              </div>
              <button
                className="auth-button lightbox-save"
                onClick={() => downloadFile(lightbox.url, lightbox.name)}
              >
                ⬇ Save
              </button>
              <button
                className="lightbox-close"
                title="Close"
                onClick={() => setLightbox(null)}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {viewOnceMedia && (
        <div
          className="modal-overlay"
          onClick={() => setViewOnceMedia(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setViewOnceMedia(null);
          }}
        >
          <div className="view-once-viewer" onClick={(e) => e.stopPropagation()}>
            <button
              className="view-once-close"
              title="Close"
              onClick={() => setViewOnceMedia(null)}
            >
              ✕
            </button>
            {viewOnceMedia.isVideo ? (
              <video
                src={viewOnceMedia.url}
                controls
                playsInline
                autoPlay
                onContextMenu={(e) => e.preventDefault()}
              />
            ) : (
              <img
                src={viewOnceMedia.url}
                alt="View once"
                onContextMenu={(e) => e.preventDefault()}
              />
            )}
            <div className="view-once-note">
              {viewOnceMedia.isVideo
                ? "This video can only be viewed once."
                : "This photo can only be viewed once."}
            </div>
          </div>
        </div>
      )}

      {showMediaModal && activeConv && (
        <div className="modal-overlay" onClick={() => setShowMediaModal(false)}>          <div
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
                          <button
                            key={m._id}
                            className="media-grid-btn"
                            onClick={() =>
                              openLightbox(
                                SERVER_URL + m.file?.url,
                                m.file?.name || "photo.png"
                              )
                            }
                          >
                            <img
                              src={SERVER_URL + m.file?.url}
                              alt={m.file?.name || "photo"}
                            />
                          </button>
                        ))}
                    </div>
                  </>
                )}
                {mediaList.some((m) => m.kind === "video") && (
                  <>
                    <div className="media-section-title">Videos</div>
                    <div className="media-grid">
                      {mediaList
                        .filter((m) => m.kind === "video")
                        .map((m) => (
                          <video
                            key={m._id}
                            src={SERVER_URL + m.file?.url}
                            controls
                            playsInline
                            preload="metadata"
                          />
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
              <div className="settings-label">Profile</div>
              <div className="settings-row">
                <Avatar user={user} small />
                <div className="settings-sub">
                  <div>
                    {user.username}
                    {user.handle && (
                      <span className="user-handle"> @{user.handle}</span>
                    )}
                  </div>
                  <div className="settings-status">
                    {user.status || "Hey there! I am using ChatApp."}
                  </div>
                </div>
                <button className="mini-button" onClick={openEditProfile}>
                  Edit
                </button>
              </div>
              {editProfileOpen && (
                <div className="edit-profile-form">
                  <label>
                    <span>Username</span>
                    <input
                      type="text"
                      value={editUsername}
                      maxLength={20}
                      onChange={(e) => setEditUsername(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Handle</span>
                    <input
                      type="text"
                      value={editHandle}
                      maxLength={20}
                      placeholder="name"
                      onChange={(e) => setEditHandle(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>Status</span>
                    <input
                      type="text"
                      value={editStatus}
                      maxLength={100}
                      placeholder="Hey there! I am using ChatApp."
                      onChange={(e) => setEditStatus(e.target.value)}
                    />
                  </label>
                  <div className="edit-profile-actions">
                    <button
                      className="mini-button"
                      onClick={() => setEditProfileOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="mini-button accept"
                      onClick={saveProfile}
                      disabled={savingProfile}
                    >
                      {savingProfile ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="settings-section">
              <div className="settings-label">Privacy</div>
              <div className="settings-row chatlock-row">
                <div className="settings-sub">
                  <div>Chat lock (PIN)</div>
                  <div>
                    {hasPin
                      ? "Chat requires a PIN to open"
                      : "Lock the app behind a PIN"}
                  </div>
                </div>
                {hasPin ? (
                  <div className="chatlock-actions">
                    <button className="mini-button" onClick={lockNow}>
                      Lock now
                    </button>
                    <button className="mini-button" onClick={setChatPin}>
                      Change PIN
                    </button>
                    <button
                      className="mini-button decline"
                      onClick={removeChatPin}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <button className="mini-button" onClick={setChatPin}>
                    Set PIN
                  </button>
                )}
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
                      <div>
                        {bu.username}
                        {bu.handle && (
                          <span className="user-handle"> @{bu.handle}</span>
                        )}
                      </div>
                      {bu.status && <div>{bu.status}</div>}
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

      {locked && (
        <div className="lock-overlay">
          <div className="lock-card">
            <div className="lock-icon">🔒</div>
            <h2>Chat Locked</h2>
            <p>Enter your PIN to continue</p>
            <input
              className="auth-input lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              placeholder="PIN"
              value={pinInput}
              onChange={(e) =>
                setPinInput(e.target.value.replace(/\D/g, ""))
              }
              onKeyDown={(e) => e.key === "Enter" && unlock()}
              autoFocus
            />
            {pinError && <div className="auth-error">{pinError}</div>}
            <button className="auth-button" onClick={unlock}>
              Unlock
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatPage;
