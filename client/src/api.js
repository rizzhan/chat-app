import axios from "axios";

// Where the backend lives. Used for file URLs like http://localhost:5000/uploads/...
export const SERVER_URL = "http://localhost:5000";

// One place for all backend calls.
// baseURL points at our Express server.
const api = axios.create({
  baseURL: "http://localhost:5000/api",
});

// Runs before every request: adds your saved token automatically.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Runs after every response. If the server says "401" (invalid/expired token),
// log the user out and show the login screen.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.dispatchEvent(new Event("auth-error"));
    }

    return Promise.reject(error);
  }
);

export default api;
