import { create } from 'zustand';
import { login as apiLogin } from '../api/endpoints';
import { setToken, clearToken } from '../api/client';

const STORAGE_KEY_TOKEN = 'mycelium_token';
const STORAGE_KEY_USER = 'mycelium_user';

interface User {
  username: string;
  display_name: string;
  role: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: null,
  user: null,
  isAuthenticated: false,

  login: async (username: string, password: string) => {
    const res = await apiLogin(username, password);
    const { token, user } = res;

    setToken(token);
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    set({ token, user, isAuthenticated: true });
  },

  logout: () => {
    clearToken();
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);

    set({ token: null, user: null, isAuthenticated: false });
  },

  hydrate: () => {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const userJson = localStorage.getItem(STORAGE_KEY_USER);

    if (token && userJson) {
      try {
        const user: User = JSON.parse(userJson);
        setToken(token);
        set({ token, user, isAuthenticated: true });
      } catch {
        // Corrupted user data — clear everything
        localStorage.removeItem(STORAGE_KEY_TOKEN);
        localStorage.removeItem(STORAGE_KEY_USER);
      }
    }
  },
}));
