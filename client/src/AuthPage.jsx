import { useState } from "react";
import api from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "motion/react";
import { Moon, Sun, Sparkles } from "lucide-react";

function AuthPage({ onAuth, dark, onToggleTheme }) {
  const [mode, setMode] = useState("login"); // "login" or "register"
  const [username, setUsername] = useState("");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [spot, setSpot] = useState({ x: 50, y: 50 });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (mode === "register" && password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const url = mode === "login" ? "/auth/login" : "/auth/register";
      const body =
        mode === "login"
          ? { email, password }
          : { username, email, password, handle };

      const res = await api.post(url, body);

      // Save the token and user so they survive a page refresh.
      localStorage.setItem("token", res.data.token);
      localStorage.setItem("user", JSON.stringify(res.data.user));

      onAuth(res.data.user);
    } catch (err) {
      setError(err.response?.data?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const onMouseMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setSpot({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
  };

  return (
    <div
      className="auth-page"
      onMouseMove={onMouseMove}
      style={{ "--mx": `${spot.x}%`, "--my": `${spot.y}%` }}
    >
      <div className="auth-bg" aria-hidden>
        <div className="auth-grid" />
        <div className="auth-spotlight" />
        <div className="auth-orb auth-orb-a" />
        <div className="auth-orb auth-orb-b" />
        <div className="auth-orb auth-orb-c" />
        <div className="auth-orb auth-orb-d" />
        <div className="auth-particles">
          {Array.from({ length: 18 }).map((_, i) => (
            <span key={i} className="auth-particle" style={{ "--d": `${(i * 1.3) % 9}s`, "--x": `${(i * 37) % 100}%` }} />
          ))}
        </div>
        <div className="auth-shooting-stars" aria-hidden>
          <span className="shooting-star" />
          <span className="shooting-star s2" />
          <span className="shooting-star s3" />
        </div>
        <div className="auth-light-rays" aria-hidden>
          <span className="sun-ray r1" />
          <span className="sun-ray r2" />
          <span className="sun-ray r3" />
          <span className="sun-pulse" />
        </div>
        <div className="auth-light-bubbles" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="light-bubble" style={{ "--d": `${(i * 1.7) % 8}s`, "--x": `${10 + (i * 17) % 80}%` }} />
          ))}
        </div>
        <div className="auth-floats">
          <div className="auth-float auth-float-1">👋 hey, you there?</div>
          <div className="auth-float auth-float-2">बातचीत • online ✓</div>
          <div className="auth-float auth-float-3">✨ new message <span className="typing-dots"><i/><i/><i/></span></div>
          <div className="auth-float auth-float-4">💬 say hello!</div>
        </div>
      </div>

      <motion.button
        className="auth-theme-toggle"
        onClick={onToggleTheme}
        aria-label={dark ? "Switch to light" : "Switch to dark"}
        title={dark ? "Light mode" : "Dark mode"}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92, rotate: 12 }}
        transition={{ type: "spring", stiffness: 400, damping: 18 }}
      >
        <span className="auth-toggle-glow" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={dark ? "moon" : "sun"}
            initial={{ rotate: -90, scale: 0, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: 90, scale: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="auth-toggle-icon"
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </motion.span>
        </AnimatePresence>
      </motion.button>

      <div
        className="auth-card-wrap"
        style={{
          transform: `perspective(900px) rotateX(${(spot.y - 50) * -0.06}deg) rotateY(${(spot.x - 50) * 0.09}deg)`,
          transition: "transform 0.15s ease-out",
        }}
      >
        <motion.div
          className="auth-card"
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
        <div className="auth-beam" aria-hidden />
        <div className="auth-card-sparkle" aria-hidden><Sparkles size={14} /></div>
        <h1 className="auth-title">बातचीत</h1>
        <p className="auth-subtitle">
          {mode === "login"
            ? "Welcome back! Log in to continue."
            : "Create an account to start chatting."}
        </p>

        <form onSubmit={handleSubmit}>
          <AnimatePresence mode="popLayout">
            {mode === "register" && (
              <motion.div key="u" initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: -8, height: 0 }} transition={{ duration: 0.28 }}>
                <Input className="auth-input h-auto" type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="popLayout">
            {mode === "register" && (
              <motion.div key="h" initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: -8, height: 0 }} transition={{ duration: 0.28, delay: 0.04 }}>
                <Input className="auth-input h-auto" type="text" placeholder="Handle (optional, e.g. @coolguy)" value={handle} onChange={(e) => setHandle(e.target.value)} />
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
            <Input className="auth-input h-auto" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            <Input className="auth-input h-auto" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </motion.div>

          <AnimatePresence mode="popLayout">
            {mode === "register" && (
              <motion.div key="c" initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: -8, height: 0 }} transition={{ duration: 0.28, delay: 0.02 }}>
                <Input className="auth-input h-auto" type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </motion.div>
            )}
          </AnimatePresence>

          {error && <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="auth-error">{error}</motion.div>}

          <Button className="auth-button h-auto w-full" type="submit" disabled={loading}>
            <span className="auth-btn-text">
              {loading ? "Please wait..." : mode === "login" ? "Log In" : "Create Account"}
            </span>
            <span className="auth-btn-shimmer" aria-hidden />
          </Button>
        </form>

        <button
          className="auth-toggle"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login"
            ? "Need an account? Register"
            : "Already have an account? Log in"}
        </button>
        </motion.div>
      </div>
    </div>
  );
}

export default AuthPage;
