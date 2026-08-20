import { collection, deleteDoc, doc, getDocs, query, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";
import { useEffect, useState } from "react";

const MIN_LIMIT = 0;
const MAX_LIMIT = 100000;

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requestMillis(item) {
  const value = item?.requestedAt;
  if (value?.toMillis) return value.toMillis();
  if (value?.seconds) return value.seconds * 1000;
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeRequests(docs) {
  const groups = new Map();
  for (const d of docs) {
    const data = d.data();
    const email = normalizedEmail(data.email);
    if (!email) continue;
    const item = { id: d.id, ...data, email };
    const existing = groups.get(email);
    if (!existing || requestMillis(item) >= requestMillis(existing)) groups.set(email, item);
  }
  return Array.from(groups.values()).sort((a, b) => requestMillis(b) - requestMillis(a));
}

export default function AccessRequestsAdmin() {
  const [items, setItems] = useState([]), [users, setUsers] = useState([]), [loading, setLoading] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const [requestsSnap, usersSnap] = await Promise.all([
        getDocs(query(collection(db, "accessRequests"))),
        getDocs(query(collection(db, "users")))
      ]);
      setItems(dedupeRequests(requestsSnap.docs));
      setUsers(usersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
      setError("Could not load access management data.");
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function findUser(item) {
    const email = normalizedEmail(item.email);
    return users.find(u => u.id === item.uid || normalizedEmail(u.email) === email);
  }

  async function status(item, nextStatus) {
    setError(""); setMessage("");
    try {
      const u = findUser(item);
      await updateDoc(doc(db, "accessRequests", item.id), { status: nextStatus, reviewedAt: new Date() });
      if (u) {
        await setDoc(doc(db, "users", u.id), {
          active: nextStatus === "Granted",
          maxChars: nextStatus === "Granted" ? Number(item.adminLimit ?? u.maxChars ?? 1000) : 1000,
          status: nextStatus,
          email: u.email || item.email
        }, { merge: true });
      }
      setMessage(`${item.email}: ${nextStatus}.`);
      await load();
    } catch (e) { console.error(e); setError("Could not update this request."); }
  }

  async function editLimit(item) {
    const u = findUser(item);
    const raw = window.prompt(`Character limit for ${item.email} (0–100,000)`, String(item.adminLimit ?? u?.maxChars ?? 1000));
    if (raw === null) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) return setError("Enter a whole number between 0 and 100,000.");
    try {
      if (u) {
        await setDoc(doc(db, "users", u.id), { uid: u.id, email: u.email || item.email, maxChars: value, active: true, status: "Granted", limitUpdatedAt: new Date() }, { merge: true });
        await updateDoc(doc(db, "accessRequests", item.id), { adminLimit: value, status: "Granted", reviewedAt: new Date(), uid: u.id });
      } else {
        await updateDoc(doc(db, "accessRequests", item.id), { adminLimit: value });
      }
      setMessage(`Limit set to ${value.toLocaleString()} for ${item.email}.`);
      await load();
    } catch (e) { console.error(e); setError("Could not set the character limit."); }
  }

  async function invite(item) {
    const value = Number(item.adminLimit ?? 1000);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) return setError("Set a valid limit between 0 and 100,000 before inviting.");
    try {
      const id = makeToken();
      await setDoc(doc(db, "accessInvites", id), { email: normalizedEmail(item.email), maxChars: value, requestId: item.id, used: false, createdAt: new Date(), expiresAt: Date.now() + 604800000 });
      await updateDoc(doc(db, "accessRequests", item.id), { status: "Granted", adminLimit: value, inviteId: id, invitedAt: new Date() });
      const url = `${window.location.origin}/?invite=${id}`;
      try { await navigator.clipboard.writeText(url); } catch { /* Clipboard may be unavailable. */ }
      setMessage(`Invitation created for ${item.email}.`);
      await load();
    } catch (e) { console.error(e); setError("Could not create invitation."); }
  }

  async function revoke(item) {
    const u = findUser(item);
    if (!u) return setError("This user has not created an account yet.");
    if (!window.confirm(`Revoke extended access for ${item.email}?`)) return;
    try {
      await setDoc(doc(db, "users", u.id), { active: false, maxChars: 1000, status: "Revoked", revokedAt: new Date() }, { merge: true });
      await updateDoc(doc(db, "accessRequests", item.id), { status: "Denied", revokedAt: new Date(), uid: u.id });
      setMessage(`Access revoked for ${item.email}.`);
      await load();
    } catch (e) { console.error(e); setError("Could not revoke access."); }
  }

  async function removeDuplicateRequests() {
    setError(""); setMessage(""); setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "accessRequests")));
      const groups = new Map();
      snap.docs.forEach(d => {
        const email = normalizedEmail(d.data().email);
        if (!email) return;
        const current = groups.get(email);
        if (!current || requestMillis({ ...d.data(), id: d.id }) > requestMillis(current)) groups.set(email, { ...d.data(), id: d.id });
      });
      const keep = new Set(Array.from(groups.values()).map(x => x.id));
      const duplicates = snap.docs.filter(d => !keep.has(d.id) && normalizedEmail(d.data().email));
      if (!duplicates.length) { setMessage("No duplicate request records found."); return; }
      await Promise.all(duplicates.map(d => deleteDoc(d.ref)));
      setMessage(`Removed ${duplicates.length} duplicate request record${duplicates.length === 1 ? "" : "s"}.`);
      await load();
    } catch (e) { console.error(e); setError("Could not remove duplicate request records. Check Firestore delete permissions."); } finally { setLoading(false); }
  }

  return <section className="admin-section access-requests-section">
    <style>{`.access-requests-section .request-actions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}.access-requests-section .request-actions .primary-button,.access-requests-section .request-actions .secondary-button{width:auto;min-height:40px;height:40px;padding:0 14px;border-radius:10px;font-size:13px}.access-requests-section .request-actions .status-select-label{display:flex;flex-direction:column;gap:5px;margin:0;font-size:11px;font-weight:600;color:#666}.access-requests-section .request-actions .admin-status-select{width:148px;height:40px;min-height:40px;margin:0;padding:0 10px;border-radius:10px;font-size:13px;background:#fff}.access-requests-section .request-actions .primary-button:hover,.access-requests-section .request-actions .secondary-button:hover{transform:none}.access-requests-section .admin-refresh{width:auto!important}.access-requests-section .dedupe-button{margin-top:10px;font-size:11px;min-height:34px;padding:0 12px}`}</style>
    <div className="admin-section-heading"><div><h2>Extended access</h2><p>One entry per email address. New requests replace the previous request for that account.</p></div><button className="secondary-button admin-refresh" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    {error && <div className="admin-error">{error}</div>}{message && <div className="admin-success">{message}</div>}
    {items.length === 0 ? <p className="admin-muted">No requests yet.</p> : <div className="request-list">{items.map(item => {
      const u = findUser(item), current = Number(item.adminLimit ?? u?.maxChars ?? 1000), statusValue = item.status || "Pending";
      const when = requestMillis(item);
      return <article className="request-card" key={normalizedEmail(item.email)}>
        <div className="request-card-top"><div><strong>{item.name || item.email}</strong><span>{item.email}</span></div><span className={`request-status status-${String(statusValue).toLowerCase()}`}>{statusValue}</span></div>
        <p>{item.purpose || "No justification provided."}</p>
        <div className="request-meta"><span>Account: {u ? (u.active === false ? "Revoked" : "Created") : "Not created"}</span><span>Limit: {current.toLocaleString()}</span><span>{when ? new Date(when).toLocaleString() : "No timestamp"}</span></div>
        <div className="request-actions"><label className="status-select-label">Status<select className="admin-status-select" value={statusValue} onChange={e => status(item, e.target.value)}><option value="Pending">Pending</option><option value="Denied">Denied</option><option value="Granted">Granted</option></select></label><button className="primary-button" onClick={() => editLimit(item)}>Edit limit</button>{statusValue === "Granted" && !u && <button className="primary-button" onClick={() => invite(item)}>Invite</button>}{u && u.active !== false && <button className="secondary-button" onClick={() => revoke(item)}>Revoke</button>}</div>
      </article>;
    })}</div>}
    {items.length > 0 && <button className="secondary-button dedupe-button" onClick={removeDuplicateRequests} disabled={loading}>{loading ? "Cleaning…" : "Remove duplicate records"}</button>}
  </section>;
}
