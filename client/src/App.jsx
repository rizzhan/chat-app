import { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loggedIn, setLoggedIn] = useState(
    !!localStorage.getItem("token")
  );

  const [message, setMessage] = useState("");
  const [socketStatus, setSocketStatus] = useState("Disconnected");
  const [error, setError] = useState("");

  const [socket, setSocket] = useState(null);

  // LOGIN
  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    try {
      const res = await axios.post(
        "http://localhost:5000/api/auth/login",
        {
          email,
          password,
        }
      );

      // Save JWT
      localStorage.setItem("token", res.data.token);

      setLoggedIn(true);

      console.log("Login successful:", res.data);
    } catch (err) {
      console.error("Login error:", err);

      setError(
        err.response?.data?.message || "Login failed"
      );
    }
  };

  // SOCKET CONNECTION
  useEffect(() => {
    if (!loggedIn) return;

    const token = localStorage.getItem("token");

    if (!token) {
      console.log("No token found");
      return;
    }

    const newSocket = io("http://localhost:5000", {
      auth: {
        token: token,
      },
    });

    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("Socket connected:", newSocket.id);
      setSocketStatus("Connected");
    });

    newSocket.on("disconnect", () => {
      console.log("Socket disconnected");
      setSocketStatus("Disconnected");
    });

    newSocket.on("connect_error", (err) => {
      console.error("Socket connection error:", err.message);
      setSocketStatus("Connection failed");
    });

    return () => {
      newSocket.disconnect();
    };
  }, [loggedIn]);

  // SERVER TEST
  useEffect(() => {
    axios
      .get("http://localhost:5000/")
      .then((res) => {
        setMessage(res.data);
      })
      .catch((err) => {
        console.error(err);
      });
  }, []);

  // LOGOUT
  const handleLogout = () => {
    localStorage.removeItem("token");

    if (socket) {
      socket.disconnect();
    }

    setSocket(null);
    setLoggedIn(false);
    setSocketStatus("Disconnected");
  };

  // LOGIN SCREEN
  if (!loggedIn) {
    return (
      <div
        style={{
          padding: "40px",
          fontFamily: "Arial",
          maxWidth: "400px",
          margin: "auto",
        }}
      >
        <h1>Chat App</h1>

        <h2>Login</h2>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: "15px" }}>
            <label>Email</label>
            <br />

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              required
              style={{
                width: "100%",
                padding: "10px",
                marginTop: "5px",
              }}
            />
          </div>

          <div style={{ marginBottom: "15px" }}>
            <label>Password</label>
            <br />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              style={{
                width: "100%",
                padding: "10px",
                marginTop: "5px",
              }}
            />
          </div>

          {error && (
            <p style={{ color: "red" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            style={{
              padding: "10px 20px",
              cursor: "pointer",
            }}
          >
            Login
          </button>
        </form>

        <hr />

        <p>
          Server: {message || "Checking server..."}
        </p>
      </div>
    );
  }

  // CHAT SCREEN
  return (
    <div style={{ padding: "40px", fontFamily: "Arial" }}>
      <h1>Chat App</h1>

      <h2>Socket Status:</h2>
      <p>{socketStatus}</p>

      <h2>Message from server:</h2>
      <p>{message}</p>

      <button
        onClick={handleLogout}
        style={{
          padding: "10px 20px",
          cursor: "pointer",
        }}
      >
        Logout
      </button>
    </div>
  );
}

export default App;