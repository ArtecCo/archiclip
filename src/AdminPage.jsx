import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  writeBatch
} from "firebase/firestore";
import { auth, db } from "./firebase";

const BATCH_SIZE = 500;

export default function AdminPage() {
  const [user, setUser] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [expiredCount, setExpiredCount] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAdmin(false);
      setChecking(true);

      if (!currentUser) {
        setChecking(false);
        return;
      }

      try {
        const adminSnapshot = await getDoc(
          doc(db, "admins", currentUser.uid)
        );
        setIsAdmin(adminSnapshot.exists() && adminSnapshot.data().enabled === true);
      } catch (err) {
        console.error("Admin check failed:", err);
        setError("Could not verify admin access.");
      } finally {
        setChecking(false);
      }
    });

    return unsubscribe;
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setPassword("");
    } catch (err) {
      console.error("Admin login failed:", err);
      setError("Invalid email or password.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setError("");
    setMessage("");
    await signOut(auth);
  }

  async function findExpired() {
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const snapshot = await getDocs(
        query(
          collection(db, "clips"),
          where("expiresAt", "<=", Date.now()),
          limit(BATCH_SIZE)
        )
      );

      setExpiredCount(snapshot.size);
      setMessage(
        snapshot.size === 0
          ? "No expired clips found."
          : `Found ${snapshot.size} expired clip${snapshot.size === 1 ? "" : "s"} in the next cleanup batch.`
      );
    } catch (err) {
      console.error("Expired clip query failed:", err);
      setError("Could not query expired clips. Check your Firestore rules.");
    } finally {
      setLoading(false);
    }
  }

  async function clearExpired() {
    setError("");
    setMessage("");
    setExpiredCount(null);
    setLoading(true);

    let deleted = 0;

    try {
      while (true) {
        const snapshot = await getDocs(
          query(
            collection(db, "clips"),
            where("expiresAt", "<=", Date.now()),
            limit(BATCH_SIZE)
          )
        );

        if (snapshot.empty) break;

        const batch = writeBatch(db);

        snapshot.docs.forEach((clip) => {
          batch.delete(clip.ref);
        });

        await batch.commit();
        deleted += snapshot.size;
      }

      setExpiredCount(0);
      setMessage(
        deleted === 0
          ? "No expired clips needed to be deleted."
          : `Deleted ${deleted} expired clip${deleted === 1 ? "" : "s"}.`
      );
    } catch (err) {
      console.error("Expired clip cleanup failed:", err);
      setError(
        deleted > 0
          ? `Cleanup stopped after deleting ${deleted} clips.`
          : "Cleanup failed. Check your Firestore rules."
      );
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return <AdminShell><p>Checking admin access…</p></AdminShell>;
  }

  if (!user) {
    return (
      <AdminShell>
        <div className="admin-badge">ARCHICLIP ADMIN</div>
        <h1>Admin login</h1>
        <p className="admin-muted">
          Sign in with the administrator Firebase account.
        </p>

        <form className="admin-form" onSubmit={handleLogin}>
          <label htmlFor="admin-email">Email</label>
          <input
            id="admin-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          {error && <div className="admin-error">{error}</div>}

          <button className="primary-button create-button" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </AdminShell>
    );
  }

  if (!isAdmin) {
    return (
      <AdminShell>
        <div className="admin-badge">ACCESS DENIED</div>
        <h1>Not an administrator</h1>
        <p className="admin-muted">
          This Firebase account is authenticated but has not been granted
          ArchiClip admin access.
        </p>
        <button className="primary-button" onClick={handleLogout}>
          Sign out
        </button>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <div className="admin-topbar">
        <div>
          <div className="admin-badge">ARCHICLIP ADMIN</div>
          <h1>Clip cleanup</h1>
        </div>
        <button className="secondary-button" onClick={handleLogout}>
          Sign out
        </button>
      </div>

      <p className="admin-muted">
        Permanently delete clips whose expiration time has passed.
      </p>

      <div className="admin-stat">
        <span>Expired clips found</span>
        <strong>{expiredCount ?? "—"}</strong>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {message && <div className="admin-success">{message}</div>}

      <div className="admin-actions">
        <button
          className="secondary-button"
          onClick={findExpired}
          disabled={loading}
        >
          Check expired
        </button>

        <button
          className="primary-button"
          onClick={clearExpired}
          disabled={loading}
        >
          {loading ? "Cleaning…" : "Delete expired clips"}
        </button>
      </div>

      <div className="admin-warning">
        <strong>This is permanent.</strong> Deleted clips cannot be restored.
      </div>
    </AdminShell>
  );
}

function AdminShell({ children }) {
  return (
    <div className="app admin-app">
      <main className="container admin-container">
        <header className="header">
          <button
            className="logo"
            aria-label="ArchiClip home"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            <img
              className="logo-image"
              src="/archiclip-logo.svg"
              alt=""
              aria-hidden="true"
            />
            <span>ArchiClip</span>
          </button>
          <span className="header-tag">Administration</span>
        </header>

        <section className="card admin-card">{children}</section>
      </main>
    </div>
  );
}
