import { useEffect, useState } from "react";
import AuthPage from "./AuthPage";
import ChatPage from "./ChatPage";

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
    setUser(newUser);
    localStorage.setItem("user", JSON.stringify(newUser));
  };

  return loggedIn ? (
    <ChatPage
      user={user}
      onLogout={handleLogout}
      onUpdateUser={handleUpdateUser}
      dark={dark}
      onToggleTheme={() => setDark((d) => !d)}
    />
  ) : (
    <AuthPage onAuth={handleAuth} />
  );
}

export default App;
