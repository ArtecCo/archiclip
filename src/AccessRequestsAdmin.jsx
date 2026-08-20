import { useEffect, useState } from "react";
import { collection, doc, getDocs, query, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";

export default function AccessRequestsAdmin() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const snap = await getDocs(query(collection(db, "accessRequests")));
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0)));
    } catch (err) { console.error(err); setError("Could not load access requests."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function updateRequest(item, status) {
    setError(""); setMessage("");
    try {
      await updateDoc(doc(db, "accessRequests", item.id), { status, reviewedAt: new Date() });
      if (status === "Granted") {
        const value = Math.max(1001, Number(item.adminLimit || item.requestedLimit || 2000));
        await setDoc(doc(db, "users", item.uid), { uid: item.uid, email: item.email, maxChars: value, accessRevoked: false, limitUpdatedAt: new Date() }, { merge: true });
      }
      if (status === "Denied") await setDoc(doc(db, "users", item.uid), { accessRevoked: true, maxChars: 1000, limitUpdatedAt: new Date() }, { merge: true });
      setMessage(`${item.email}: ${status}.`); await load();
    } catch (err) { console.error(err); setError("Could not update this request."); }
  }

  async function setLimit(item) {
    const raw = window.prompt(`Character limit for ${item.email}`, String(item.adminLimit || item.requestedLimit || 2000));
    if (raw === null) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1001 || value > 1000000) return setError("Enter a whole number between 1,001 and 1,000,000.");
    setError(""); setMessage("");
    try {
      await setDoc(doc(db, "users", item.uid), { uid: item.uid, email: item.email, maxChars: value, accessRevoked: false, limitUpdatedAt: new Date() }, { merge: true });
      await updateDoc(doc(db, "accessRequests", item.id), { adminLimit: value, status: "Granted", reviewedAt: new Date() });
      setMessage(`Limit set to ${value.toLocaleString()} for ${item.email}.`); await load();
    } catch (err) { console.error(err); setError("Could not set the character limit."); }
  }

  async function revoke(item) {
    if (!window.confirm(`Revoke extended access for ${item.email}? Their limit will return to 1,000.`)) return;
    setError(""); setMessage("");
    try {
      await setDoc(doc(db, "users", item.uid), { uid: item.uid, email: item.email, maxChars: 1000, accessRevoked: true, limitUpdatedAt: new Date() }, { merge: true });
      await updateDoc(doc(db, "accessRequests", item.id), { status: "Denied", reviewedAt: new Date() });
      setMessage(`Extended access revoked for ${item.email}.`); await load();
    } catch (err) { console.error(err); setError("Could not revoke access."); }
  }

  return <section className="admin-section access-requests-section">
    <div className="admin-section-heading"><div><h2>Extended limit requests</h2><p>Review requests and manage approved users.</p></div><button className="secondary-button admin-refresh" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    {error && <div className="admin-error">{error}</div>}{message && <div className="admin-success">{message}</div>}
    {items.length === 0 ? <p className="admin-muted">No requests yet.</p> : <div className="request-list">{items.map((item) => <article className="request-card" key={item.id}>
      <div className="request-card-top"><div><strong>{item.name}</strong><span>{item.email}</span></div><span className={`request-status status-${String(item.status || "Pending").toLowerCase()}`}>{item.status || "Pending"}</span></div>
      <p>{item.purpose}</p><div className="request-meta"><span>User: {item.uid}</span><span>Limit: {(item.adminLimit || item.requestedLimit || 1000).toLocaleString()}</span></div>
      <div className="request-actions"><button className="secondary-button" onClick={() => updateRequest(item, "Pending")}>Pending</button><button className="secondary-button" onClick={() => updateRequest(item, "Denied")}>Denied</button><button className="secondary-button" onClick={() => updateRequest(item, "Granted")}>Grant</button><button className="primary-button" onClick={() => setLimit(item)}>Edit limit</button>{item.status === "Granted" && <button className="secondary-button" onClick={() => revoke(item)}>Revoke access</button>}</div>
    </article>)}</div>}
  </section>;
}
