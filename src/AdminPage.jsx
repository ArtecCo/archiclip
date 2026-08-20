import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  query,
  serverTimestamp,
  where,
  writeBatch
} from "firebase/firestore";
import { auth, db } from "./firebase";

const CLEANUP_BATCH_SIZE = 499;

const EXPIRY_TYPES = [
  ["1m", "1 minute"],
  ["5m", "5 minutes"],
  ["10m", "10 minutes"],
  ["30m", "30 minutes"],
  ["1h", "1 hour"],
  ["6h", "6 hours"],
  ["12h", "12 hours"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["forever", "Forever"]
];

const metricsRef = doc(db, "adminMetrics", "global");

const EMPTY_METRICS = {
  current: 0,
  expired: 0,
  totalCreated: 0,
  totalDeleted: 0,
  byExpiry: [],
  legacy: 0,
  lastCleanupAt: null
};

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
  const [metrics, setMetrics] = useState(EMPTY_METRICS);

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
        setIsAdmin(
          adminSnapshot.exists() &&
            adminSnapshot.data().enabled === true
        );
      } catch (err) {
        console.error("Admin check failed:", err);
        setError("Could not verify admin access.");
      } finally {
        setChecking(false);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (isAdmin) {
      refreshMetrics();
    }
  }, [isAdmin]);

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

  async function refreshMetrics() {
    setError("");
    setLoading(true);

    try {
      const now = Date.now();
      const clipsRef = collection(db, "clips");

      const [totalSnapshot, expiredSnapshot, storedMetricsSnapshot] =
        await Promise.all([
          getCountFromServer(clipsRef),
          getCountFromServer(
            query(clipsRef, where("expiresAt", "<=", now))
          ),
          getDoc(metricsRef)
        ]);

      const totalCurrent = totalSnapshot.data().count;
      const expired = expiredSnapshot.data().count;
      const storedMetrics = storedMetricsSnapshot.exists()
        ? storedMetricsSnapshot.data()
        : {};
      const totalDeleted = Number(storedMetrics.totalDeleted || 0);

      const byExpiry = await Promise.all(
        EXPIRY_TYPES.map(async ([key, label]) => {
          const snapshot = await getCountFromServer(
            query(clipsRef, where("expirationType", "==", key))
          );

          return {
            key,
            label,
            count: snapshot.data().count
          };
        })
      );

      const knownStored = byExpiry.reduce(
        (sum, item) => sum + item.count,
        0
      );
      const legacy = Math.max(0, totalCurrent - knownStored);

      setExpiredCount(expired);
      setMetrics({
        current: totalCurrent,
        expired,
        totalCreated: totalCurrent + totalDeleted,
        totalDeleted,
        byExpiry,
        legacy,
        lastCleanupAt: storedMetrics.lastCleanupAt || null
      });
    } catch (err) {
      console.error("Metrics refresh failed:", err);
      setError(
        "Could not load metrics. Check your Firestore rules."
      );
    } finally {
      setLoading(false);
    }
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
          limit(CLEANUP_BATCH_SIZE)
        )
      );

      setExpiredCount(snapshot.size);
      setMessage(
        snapshot.size === 0
          ? "No expired clips found."
          : `Found ${snapshot.size} expired clip${
              snapshot.size === 1 ? "" : "s"
            } in the next cleanup batch.`
      );
    } catch (err) {
      console.error("Expired clip query failed:", err);
      setError(
        "Could not query expired clips. Check your Firestore rules."
      );
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
            limit(CLEANUP_BATCH_SIZE)
          )
        );

        if (snapshot.empty) break;

        const batch = writeBatch(db);

        snapshot.docs.forEach((clip) => {
          batch.delete(clip.ref);
        });

        batch.set(
          metricsRef,
          {
            totalDeleted: increment(snapshot.size),
            lastCleanupAt: serverTimestamp()
          },
          { merge: true }
        );

        await batch.commit();
        deleted += snapshot.size;
      }

      setExpiredCount(0);
      setMessage(
        deleted === 0
          ? "No expired clips needed to be deleted."
          : `Deleted ${deleted} expired clip${
              deleted === 1 ? "" : "s"
            }.`
      );

      await refreshMetrics();
    } catch (err) {
      console.error("Expired clip cleanup failed:", err);
      setError(
        deleted > 0
          ? `Cleanup stopped after deleting ${deleted} clips.`
          : "Cleanup failed. Check your Firestore rules."
      );
      await refreshMetrics();
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
          <h1>Dashboard</h1>
        </div>
        <button className="secondary-button" onClick={handleLogout}>
          Sign out
        </button>
      </div>

      <p className="admin-muted">
        Monitor ArchiClip usage and permanently remove expired clips.
      </p>

      <div className="admin-metrics-grid">
        <MetricCard
          label="Total created"
          value={metrics.totalCreated}
          detail="Current + deleted"
        />
        <MetricCard
          label="Currently stored"
          value={metrics.current}
          detail="In Firestore"
        />
        <MetricCard
          label="Total deleted"
          value={metrics.totalDeleted}
          detail="Admin cleanup"
        />
        <MetricCard
          label="Expired pending"
          value={metrics.expired}
          detail="Unavailable to users"
        />
      </div>

      <section className="admin-section">
        <div className="admin-section-heading">
          <div>
            <h2>Clips by expiry</h2>
            <p>Currently stored clips grouped by their selected expiry period.</p>
          </div>
          <button
            className="secondary-button admin-refresh"
            onClick={refreshMetrics}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="expiry-grid">
          {metrics.byExpiry.map((item) => (
            <div className="expiry-row" key={item.key}>
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </div>
          ))}

          <div className="expiry-row expiry-row-muted">
            <span>Expired / awaiting cleanup</span>
            <strong>{metrics.expired}</strong>
          </div>

          {metrics.legacy > 0 && (
            <div className="expiry-row expiry-row-muted">
              <span>Legacy / unspecified</span>
              <strong>{metrics.legacy}</strong>
            </div>
          )}
        </div>
      </section>

      <section className="admin-section cleanup-section">
        <div className="admin-section-heading">
          <div>
            <h2>Cleanup</h2>
            <p>
              Expired clips are already inaccessible. Cleanup permanently
              removes them from Firestore.
            </p>
          </div>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {message && <div className="admin-success">{message}</div>}

        <div className="admin-stat">
          <span>Expired clips ready for deletion</span>
          <strong>{expiredCount ?? metrics.expired}</strong>
        </div>

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

        {metrics.lastCleanupAt && (
          <p className="admin-last-cleanup">
            Last cleanup: {formatDate(metrics.lastCleanupAt)}
          </p>
        )}
      </section>
    </AdminShell>
  );
}

function MetricCard({ label, value, detail }) {
  return (
    <div className="admin-metric-card">
      <span>{label}</span>
      <strong>{Number(value || 0).toLocaleString()}</strong>
      <small>{detail}</small>
    </div>
  );
}

function formatDate(value) {
  if (!value) return "—";

  const date =
    typeof value.toDate === "function"
      ? value.toDate()
      : new Date(value);

  return date.toLocaleString();
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
