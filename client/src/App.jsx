import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import api, { SERVER_URL } from "./api";
import { motion, AnimatePresence } from "motion/react";
import ChatPage from "./ChatPage";
import AuthPage from "./AuthPage";

function BootScreen({ progress }) {
  return (
    <motion.div
      className="app-boot app-boot-discord"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="boot-discord-bg" aria-hidden />

      <motion.div
        className="boot-discord-center"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="boot-discord-logo">बातचीत</div>
        <div className="boot-discord-dots" aria-hidden>
          <span /><span /><span />
        </div>
        <div className="boot-discord-tip">Preloading your chats…</div>
      </motion.div>
      <div className="boot-discord-bar" aria-hidden>
        <motion.div
          className="boot-discord-fill"
          initial={{ width: "0%" }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        />
      </div>
    </motion.div>
  );
}

function App() {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("user"));
    } catch {
      return null;
    }
  });

  const [dark, setDark] = useState(
    () => localStorage.getItem("theme") === "dark"
  );

  const [loggedIn, setLoggedIn] = useState(
    !!localStorage.getItem("token") && !!user
  );

  const [booting, setBooting] = useState(() => !!localStorage.getItem("token") && !!JSON.parse(localStorage.getItem("user") || "null"));
  const [bootProgress, setBootProgress] = useState(0);

  // Apply (and remember) the light/dark theme.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  // Boot sequence — preload fonts + user + conversations + avatars so pfp never flashes
  useEffect(() => {
    if (!booting) return;
    let cancelled = false;
    const bump = (v) => !cancelled && setBootProgress((p) => Math.max(p, v));

    (async () => {
      try {
        bump(10);
        // 1. fonts
        try {
          await document.fonts?.ready;
        } catch {}
        bump(25);

        const token = localStorage.getItem("token");
        if (!token) {
          bump(100);
          setTimeout(() => !cancelled && setBooting(false), 400);
          return;
        }

        // 2. reconcile user (fixes stale avatar/incognito)
        let freshUser = null;
        try {
          const cached = JSON.parse(localStorage.getItem("user") || "null");
          const decodeJwtId = (t) => {
            try {
              const payload = t.split(".")[1];
              const json = decodeURIComponent(escape(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))));
              return JSON.parse(json).id || null;
            } catch { return null; }
          };
          const tokenId = decodeJwtId(token);
          if (tokenId) {
            const res = await api.get(`/users/${tokenId}`);
            freshUser = { ...res.data, id: res.data._id };
            const cachedStr = JSON.stringify(cached);
            const freshStr = JSON.stringify(freshUser);
            if (cachedStr !== freshStr) {
              setUser(freshUser);
              localStorage.setItem("user", JSON.stringify(freshUser));
            }
          } else {
            freshUser = cached;
          }
        } catch {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          setUser(null);
          setLoggedIn(false);
          bump(100);
          setTimeout(() => !cancelled && setBooting(false), 300);
          return;
        }
        bump(50);

        // 3. conversations (for avatars)
        let convs = [];
        try {
          const r = await api.get("/conversations");
          convs = Array.isArray(r.data) ? r.data : [];
        } catch {}
        bump(70);

        // 4. preload avatar images
        const urls = new Set();
        const addUrl = (p) => {
          if (!p) return;
          const u = p.startsWith("http") ? p : SERVER_URL + p;
          urls.add(u);
        };
        if (freshUser?.avatar) addUrl(freshUser.avatar);
        convs.forEach((c) => {
          if (c.avatar) addUrl(c.avatar);
          (c.participants || []).forEach((pt) => pt.avatar && addUrl(pt.avatar));
        });
        // also preload small UI assets (favicon etc) optional

        const preload = (src) =>
          new Promise((res) => {
            const img = new Image();
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                res();
              }
            };
            img.onload = finish;
            img.onerror = finish;
            img.src = src;
            // fallback timeout so boot never hangs
            setTimeout(finish, 1200);
          });

        await Promise.all([...urls].map(preload));
        // tiny extra to let images decode
        await new Promise((r) => setTimeout(r, 250));
        bump(100);
        setTimeout(() => !cancelled && setBooting(false), 500);
      } catch {
        bump(100);
        setTimeout(() => !cancelled && setBooting(false), 400);
      }
    })();

    const safety = setTimeout(() => !cancelled && setBooting(false), 3500);
    return () => {
      cancelled = true;
      clearTimeout(safety);
    };
  }, [booting]);

  // Reconcile the cached user with the token on startup. The token's id is
  // authoritative; if localStorage.user is stale (old account id, deleted and
  // recreated account, DB switch), every "is this me?" check breaks and chats
  // can even appear as if you're talking to yourself. Align them on load, or
  // drop the session if the token's account no longer exists.
  // (Now handled by boot sequence; this keeps a live sync for tab switches)
  useEffect(() => {
    if (booting) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    const readCache = () => {
      try {
        return JSON.parse(localStorage.getItem("user"));
      } catch {
        return null;
      }
    };
    const cached = readCache();
    if (!cached) return;

    const decodeJwtId = (t) => {
      try {
        const payload = t.split(".")[1];
        const json = decodeURIComponent(
          escape(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))
        );
        return JSON.parse(json).id || null;
      } catch {
        return null;
      }
    };

    const tokenId = decodeJwtId(token);
    if (!tokenId) return;

    api
      .get(`/users/${tokenId}`)
      .then((res) => {
        const normalized = { ...res.data, id: res.data._id };
        const cachedStr = JSON.stringify(cached);
        const freshStr = JSON.stringify(normalized);
        if (cachedStr !== freshStr) {
          setUser(normalized);
          localStorage.setItem("user", JSON.stringify(normalized));
        }
      })
      .catch(() => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        setUser(null);
        setLoggedIn(false);
      });
  }, [booting]);

  // If the token expires while using the app, the api helper fires
  // an "auth-error" event and we show the login screen again.
  useEffect(() => {
    const handleAuthError = () => {
      setUser(null);
      setLoggedIn(false);
      setBooting(false);
    };

    window.addEventListener("auth-error", handleAuthError);
    return () => window.removeEventListener("auth-error", handleAuthError);
  }, []);

  const handleAuth = (user) => {
    setUser(user);
    setLoggedIn(true);
    setBootProgress(0);
    setBooting(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
    setLoggedIn(false);
    setBooting(false);
  };

  const handleUpdateUser = (newUser) => {
    const normalized = { ...newUser, id: newUser.id || newUser._id };
    setUser(normalized);
    localStorage.setItem("user", JSON.stringify(normalized));
  };

  return (
    <TooltipProvider>
      <AnimatePresence mode="wait">
        {booting ? (
          <BootScreen key="boot" progress={bootProgress} />
        ) : loggedIn ? (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <ChatPage
              user={user}
              onLogout={handleLogout}
              onUpdateUser={handleUpdateUser}
              dark={dark}
              onToggleTheme={() => setDark((d) => !d)}
            />
          </motion.div>
        ) : (
          <motion.div
            key="auth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <AuthPage onAuth={handleAuth} dark={dark} onToggleTheme={() => setDark((d) => !d)} />
          </motion.div>
        )}
      </AnimatePresence>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

export default App;
