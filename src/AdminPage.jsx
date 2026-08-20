import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, doc, getCountFromServer, getDocs, getDoc, limit, query, serverTimestamp, setDoc, where, writeBatch } from "firebase/firestore";
import { auth, db } from "./firebase";

const CLEANUP_BATCH_SIZE = 499;
const EXPIRY_TYPES = [["1m", "1 minute"], ["5m", "5 minutes"], ["10m", "10 minutes"], ["30m", "30 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["12h", "12 hours"], ["24h", "24 hours"], ["7d", "7 days"], ["forever", "Forever"]];
const metricsRef = doc(db, "adminMetrics", "global");
const EMPTY_METRICS = { current: 0, expired: 0, totalCreated: 0, totalDeleted: 0, byExpiry: [], legacy: 0, lastCleanupAt: null };

export default function AdminPage() {
  const [user, setUser] = useState(undefined), [isAdmin, setIsAdmin] = useState(false), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [loading, setLoading] = useState(false), [checking, setChecking] = useState(true), [message, setMessage] = useState(""), [error, setError] = useState(""), [expiredCount, setExpiredCount] = useState(null), [metrics, setMetrics] = useState(EMPTY_METRICS);

  useEffect(() => onAuthStateChanged(auth, async (currentUser) => {
    setUser(currentUser); setIsAdmin(false); setChecking(true);
    if (!currentUser) return setChecking(false);
    try {
      const snap = await getDoc(doc(db, "admins", currentUser.uid));
      setIsAdmin(snap.exists() && snap.data().enabled === true);
    } catch (err) { console.error(err); setError("Could not verify admin access."); }
    finally { setChecking(false); }
  }), []);

  useEffect(() => { if (isAdmin) refreshMetrics(); }, [isAdmin]);

  async function handleLogin(event) {
    event.preventDefault(); setError(""); setMessage(""); setLoading(true);
    try { await signInWithEmailAndPassword(auth, email.trim(), password); setPassword(""); }
    catch (err) { console.error(err); setError("Invalid email or password."); }
    finally { setLoading(false); }
  }

  async function handleLogout() { setError(""); setMessage(""); await signOut(auth); }

  async function refreshMetrics() {
    setError(""); setLoading(true);
    try {
      const clipsRef = collection(db, "clips"), eventsRef = collection(db, "clipCreationEvents"), now = Date.now();
      const [currentSnap, expiredSnap, historicalSnap, deletedSnap] = await Promise.all([
        getCountFromServer(clipsRef),
        getCountFromServer(query(clipsRef, where("expiresAt", "<=", now))),
        getCountFromServer(eventsRef),
        getDoc(metricsRef)
      ]);
      const current = currentSnap.data().count;
      const expired = expiredSnap.data().count;
      const historicalEvents = historicalSnap.data().count;
      const stored = deletedSnap.exists() ? deletedSnap.data() : {};
      const totalDeleted = Number(stored.totalDeleted || 0);

      // Every deleted clip was once a created clip. Current clips are the other side
      // of that lifetime total. Creation events may also exist, so use the largest
      // reliable figure rather than double-counting tracked events.
      const totalCreated = Math.max(historicalEvents, current + totalDeleted);

      const byExpiry = await Promise.all(EXPIRY_TYPES.map(async ([key, label]) => ({
        key,
        label,
        count: (await getCountFromServer(query(eventsRef, where("expirationType", "==", key)))).data().count
      })));
      const knownHistorical = byExpiry.reduce((sum, item) => sum + item.count, 0);
      const legacy = Math.max(0, totalCreated - knownHistorical);

      setExpiredCount(expired);
      setMetrics({ current, expired, totalCreated, totalDeleted, byExpiry, legacy, lastCleanupAt: stored.lastCleanupAt || null });
    } catch (err) { console.error(err); setError("Could not load metrics. Check your Firestore rules."); }
    finally { setLoading(false); }
  }

  async function backfillExistingClips() {
    setError(""); setMessage(""); setLoading(true);
    try {
      const snapshot = await getDocs(collection(db, "clips"));
      let added = 0;
      for (let start = 0; start < snapshot.docs.length; start += CLEANUP_BATCH_SIZE) {
        const batch = writeBatch(db);
        const page = snapshot.docs.slice(start, start + CLEANUP_BATCH_SIZE);
        for (const clip of page) {
          const data = clip.data();
          const eventRef = doc(db, "clipCreationEvents", clip.id);
          batch.set(eventRef, { code: clip.id, createdAt: data.createdAt || serverTimestamp(), expirationType: data.expirationType || "legacy", expirationLabel: data.expirationLabel || "Legacy / unspecified" }, { merge: true });
        }
        await batch.commit();
        added += page.length;
      }
      setMessage(`Historical baseline updated for ${added} stored clip${added === 1 ? "" : "s"}.`);
      await refreshMetrics();
    } catch (err) { console.error(err); setError("Could not backfill existing clips. Check your Firestore rules."); }
    finally { setLoading(false); }
  }

  async function findExpired() {
    setError(""); setMessage(""); setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "clips"), where("expiresAt", "<=", Date.now()), limit(CLEANUP_BATCH_SIZE)));
      setExpiredCount(snap.size); setMessage(snap.size === 0 ? "No expired clips found." : `Found ${snap.size} expired clip${snap.size === 1 ? "" : "s"} in the next cleanup batch.`);
    } catch (err) { console.error(err); setError("Could not query expired clips. Check your Firestore rules."); }
    finally { setLoading(false); }
  }

  async function clearExpired() {
    setError(""); setMessage(""); setExpiredCount(null); setLoading(true); let deleted = 0;
    try {
      while (true) {
        const snap = await getDocs(query(collection(db, "clips"), where("expiresAt", "<=", Date.now()), limit(CLEANUP_BATCH_SIZE)));
        if (snap.empty) break;
        const batch = writeBatch(db);
        snap.docs.forEach((clip) => batch.delete(clip.ref));
        await batch.commit(); deleted += snap.size;
      }
      if (deleted > 0) {
        const currentMetrics = await getDoc(metricsRef);
        const oldDeleted = currentMetrics.exists() ? Number(currentMetrics.data().totalDeleted || 0) : 0;
        await setDoc(metricsRef, { totalDeleted: oldDeleted + deleted, lastCleanupAt: serverTimestamp() }, { merge: true });
      }
      setExpiredCount(0); setMessage(deleted === 0 ? "No expired clips needed to be deleted." : `Deleted ${deleted} expired clip${deleted === 1 ? "" : "s"}.`); await refreshMetrics();
    } catch (err) { console.error(err); setError(deleted > 0 ? `Cleanup stopped after deleting ${deleted} clips.` : "Cleanup failed. Check your Firestore rules."); await refreshMetrics(); }
    finally { setLoading(false); }
  }

  if (checking) return <AdminShell><p>Checking admin access…</p></AdminShell>;
  if (!user) return <AdminShell><div className="admin-badge">ARCHICLIP ADMIN</div><h1>Admin login</h1><p className="admin-muted">Sign in with the administrator Firebase account.</p><form className="admin-form" onSubmit={handleLogin}><label htmlFor="admin-email">Email</label><input id="admin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /><label htmlFor="admin-password">Password</label><input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />{error && <div className="admin-error">{error}</div>}<button className="primary-button create-button" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button></form></AdminShell>;
  if (!isAdmin) return <AdminShell><div className="admin-badge">ACCESS DENIED</div><h1>Not an administrator</h1><p className="admin-muted">This Firebase account is authenticated but has not been granted ArchiClip admin access.</p><button className="primary-button" onClick={handleLogout}>Sign out</button></AdminShell>;

  return <AdminShell>
    <div className="admin-topbar"><div><div className="admin-badge">ARCHICLIP ADMIN</div><h1>Dashboard</h1></div><button className="secondary-button" onClick={handleLogout}>Sign out</button></div>
    <p className="admin-muted">Monitor ArchiClip usage and permanently remove expired clips.</p>
    <div className="admin-metrics-grid"><MetricCard label="Total created" value={metrics.totalCreated} detail="Lifetime" /><MetricCard label="Currently stored" value={metrics.current} detail="In Firestore" /><MetricCard label="Total deleted" value={metrics.totalDeleted} detail="Admin cleanup" /><MetricCard label="Expired pending" value={metrics.expired} detail="Unavailable to users" /></div>

    <section className="admin-section"><div className="admin-section-heading"><div><h2>Lifetime clips by expiry</h2><p>Every clip created since ArchiClip started, including clips already deleted.</p></div><button className="secondary-button admin-refresh" onClick={refreshMetrics} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      <div className="expiry-grid">{metrics.byExpiry.map((item) => <div className="expiry-row" key={item.key}><span>{item.label}</span><strong>{item.count}</strong></div>)}{metrics.legacy > 0 && <div className="expiry-row expiry-row-muted"><span>Legacy / unspecified</span><strong>{metrics.legacy}</strong></div>}</div>
    </section>

    <section className="admin-section"><div className="admin-section-heading"><div><h2>Historical data</h2><p>Use this once to include clips that existed before lifetime tracking was added.</p></div></div><button className="secondary-button" onClick={backfillExistingClips} disabled={loading}>Backfill existing clips</button></section>

    <section className="admin-section cleanup-section"><div className="admin-section-heading"><div><h2>Cleanup</h2><p>Expired clips are already inaccessible. Cleanup permanently removes them from Firestore.</p></div></div>{error && <div className="admin-error">{error}</div>}{message && <div className="admin-success">{message}</div>}<div className="admin-stat"><span>Expired clips ready for deletion</span><strong>{expiredCount ?? metrics.expired}</strong></div><div className="admin-actions"><button className="secondary-button" onClick={findExpired} disabled={loading}>Check expired</button><button className="primary-button" onClick={clearExpired} disabled={loading}>{loading ? "Cleaning…" : "Delete expired clips"}</button></div><div className="admin-warning"><strong>This is permanent.</strong> Deleted clips cannot be restored.</div>{metrics.lastCleanupAt && <p className="admin-last-cleanup">Last cleanup: {formatDate(metrics.lastCleanupAt)}</p>}</section>
  </AdminShell>;
}

function MetricCard({ label, value, detail }) { return <div className="admin-metric-card"><span>{label}</span><strong>{Number(value || 0).toLocaleString()}</strong><small>{detail}</small></div>; }
function formatDate(value) { if (!value) return "—"; const date = typeof value.toDate === "function" ? value.toDate() : new Date(value); return date.toLocaleString(); }
function AdminShell({ children }) { return <div className="app admin-app"><main className="container admin-container"><header className="header"><button className="logo" aria-label="ArchiClip home" onClick={() => { window.location.href = "/"; }}><img className="logo-image" src="/archiclip-logo.svg" alt="" aria-hidden="true" /><span>ArchiClip</span></button><span className="header-tag">Administration</span></header><section className="card admin-card">{children}</section></main></div>; }
