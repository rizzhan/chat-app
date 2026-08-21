import { Suspense, lazy, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import api from "./api";

const ChatPage = lazy(() => import("./ChatPage"));
const AuthPage = lazy(() => import("./AuthPage"));

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

  // Apply (and remember) the light/dark theme.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  // Reconcile the cached user with the token on startup. The token's id is
  // authoritative; if localStorage.user is stale (old account id, deleted and
  // recreated account, DB switch), every "is this me?" check breaks and chats
  // can even appear as if you're talking to yourself. Align them on load, or
  // drop the session if the token's account no longer exists.
  useEffect(() => {
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
        // Always sync — fixes stale avatar/status after the profile was
        // updated in another tab or the cached user is from an incognito
        // session that never saw the upload.
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
  }, []);

  // If the token expires while using the app, the api helper fires
  // an "auth-error" event and we show the login screen again.
  useEffect(() => {
    const handleAuthError = () => {
      setUser(null);
      setLoggedIn(false);
    };

    window.addEventListener("auth-error", handleAuthError);
    return () => window.removeEventListener("auth-error", handleAuthError);
  }, []);

  const handleAuth = (user) => {
    setUser(user);
    setLoggedIn(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
    setLoggedIn(false);
  };

  const handleUpdateUser = (newUser) => {
    // /users/avatar and PATCH /users/me return a raw Mongoose doc with `_id`
    // (no `id`), while the rest of the app expects `user.id`. Normalize here
    // so the whole UI keeps working after a profile/photo update.
    const normalized = { ...newUser, id: newUser.id || newUser._id };
    setUser(normalized);
    localStorage.setItem("user", JSON.stringify(normalized));
  };

  return (
    <TooltipProvider>
      {loggedIn ? (
        <Suspense
          fallback={
            <div className="app-loading">
              <div className="app-loading-title">बातचीत</div>
            </div>
          }
        >
          <ChatPage
            user={user}
            onLogout={handleLogout}
            onUpdateUser={handleUpdateUser}
            dark={dark}
            onToggleTheme={() => setDark((d) => !d)}
          />
        </Suspense>
      ) : (
        <Suspense
          fallback={
            <div className="app-loading">
              <div className="app-loading-title">बातचीत</div>
            </div>
          }
        >
          <AuthPage onAuth={handleAuth} dark={dark} onToggleTheme={() => setDark((d) => !d)} />
        </Suspense>
      )}
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

export default App;
