import { collection, doc, getDocs, query, setDoc, updateDoc } from "firebase/firestore";
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

function groupRequests(docs) {
  const groups = new Map();
  for (const d of docs) {
    const data = d.data();
    const email = normalizedEmail(data.email);
    if (!email) continue;
    const item = { id: d.id, ...data, email };
    const group = groups.get(email) || { latest: null, count: 0 };
    group.count += 1;
    if (!group.latest || requestMillis(item) >= requestMillis(group.latest)) group.latest = item;
    groups.set(email, group);
  }
  return Array.from(groups, ([email, group]) => ({ ...group.latest, email, requestCount: group.count }))
    .filter(Boolean)
    .sort((a, b) => requestMillis(b) - requestMillis(a));
}

export default function AccessRequestsAdmin() {
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [managedEmail, setManagedEmail] = useState(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [requestsSnap, usersSnap] = await Promise.all([
        getDocs(query(collection(db, "accessRequests"))),
        getDocs(query(collection(db, "users")))
      ]);
      setItems(groupRequests(requestsSnap.docs));
      setUsers(usersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
      setError("Could not load access management data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function findUser(item) {
    const email = normalizedEmail(item.email);
    return users.find(u => u.id === item.uid || normalizedEmail(u.email) === email);
  }

  async function status(item, nextStatus) {
    setError("");
    setMessage("");
    try {
      const u = findUser(item);
      await updateDoc(doc(db, "accessRequests", item.id), {
        status: nextStatus,
        reviewedAt: new Date()
      });
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
    } catch (e) {
      console.error(e);
      setError("Could not update this request.");
    }
  }

  async function editLimit(item) {
    const u = findUser(item);
    const raw = window.prompt(`Character limit for ${item.email} (0–100,000)`, String(item.adminLimit ?? u?.maxChars ?? 1000));
    if (raw === null) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
      setError("Enter a whole number between 0 and 100,000.");
      return;
    }
    try {
      if (u) {
        await setDoc(doc(db, "users", u.id), {
          uid: u.id,
          email: u.email || item.email,
          maxChars: value,
          active: true,
          status: "Granted",
          limitUpdatedAt: new Date()
        }, { merge: true });
        await updateDoc(doc(db, "accessRequests", item.id), {
          adminLimit: value,
          status: "Granted",
          reviewedAt: new Date(),
          uid: u.id
        });
      } else {
        await updateDoc(doc(db, "accessRequests", item.id), { adminLimit: value });
      }
      setMessage(`Limit set to ${value.toLocaleString()} for ${item.email}.`);
      await load();
    } catch (e) {
      console.error(e);
      setError("Could not set the character limit.");
    }
  }

  async function invite(item) {
    const value = Number(item.adminLimit ?? 1000);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
      setError("Set a valid limit between 0 and 100,000 before inviting.");
      return;
    }
    try {
      const id = makeToken();
      await setDoc(doc(db, "accessInvites", id), {
        email: normalizedEmail(item.email),
        maxChars: value,
        requestId: item.id,
        used: false,
        createdAt: new Date(),
        expiresAt: Date.now() + 604800000
      });
      await updateDoc(doc(db, "accessRequests", item.id), {
        status: "Granted",
        adminLimit: value,
        inviteId: id,
        invitedAt: new Date()
      });
      const url = `${window.location.origin}/?invite=${id}`;
      try { await navigator.clipboard.writeText(url); } catch { /* Clipboard may be unavailable. */ }
      setMessage(`Invitation created for ${item.email}.`);
      await load();
    } catch (e) {
      console.error(e);
      setError("Could not create invitation.");
    }
  }

  async function revoke(item) {
    const u = findUser(item);
    if (!u) {
      setError("This user has not created an account yet.");
      return;
    }
    if (!window.confirm(`Revoke extended access for ${item.email}?`)) return;
    try {
      await setDoc(doc(db, "users", u.id), {
        active: false,
        maxChars: 1000,
        status: "Revoked",
        revokedAt: new Date()
      }, { merge: true });
      await updateDoc(doc(db, "accessRequests", item.id), {
        status: "Denied",
        revokedAt: new Date(),
        uid: u.id
      });
      setMessage(`Access revoked for ${item.email}.`);
      await load();
    } catch (e) {
      console.error(e);
      setError("Could not revoke access.");
    }
  }

  return (
    <section className="admin-section access-requests-section">
      <style>{`
        .access-requests-section .account-table{width:100%;border:1px solid #e3e3dd;border-radius:14px;overflow:hidden;background:#fff}
        .access-requests-section .account-row{display:grid;grid-template-columns:minmax(210px,2fr) 110px 130px 80px minmax(90px,110px);align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid #ecece7;font-size:13px}
        .access-requests-section .account-row:last-child{border-bottom:0}
        .access-requests-section .account-head{background:#fafaf8;color:#777;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
        .access-requests-section .account-user{display:grid;gap:3px;min-width:0}
        .access-requests-section .account-user strong{font-size:13px;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .access-requests-section .account-user span{font-size:11px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .access-requests-section .account-status{display:inline-flex;width:max-content;padding:6px 10px;border-radius:999px;background:#eee;color:#555;font-size:11px;font-weight:700}
        .access-requests-section .account-status.granted{background:#e9f5ea;color:#256029}.access-requests-section .account-status.denied{background:#fff0f0;color:#b42318}.access-requests-section .account-status.pending{background:#f7f5ed;color:#665b3b}
        .access-requests-section .account-limit{font-weight:700}.access-requests-section .account-requests{color:#666}.access-requests-section .new-request-badge{display:inline-flex;margin-left:8px;padding:4px 7px;border-radius:999px;background:#fff3cf;color:#8a6500;font-size:10px;font-weight:800;vertical-align:middle}
        .access-requests-section .manage-button{width:auto!important;min-height:36px;height:36px;padding:0 13px;border:1px solid #dcdcd6;border-radius:9px;background:#111;color:#fff;font-size:12px;font-weight:700;cursor:pointer}
        .access-requests-section .manage-button:hover{transform:translateY(-1px)}
        .access-requests-section .account-detail{grid-column:1/-1;margin-top:2px;padding:16px;border:1px solid #e5e5df;border-radius:12px;background:#fafaf8}
        .access-requests-section .account-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:start}
        .access-requests-section .account-detail p{margin:0;color:#555;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
        .access-requests-section .detail-label{display:block;margin-bottom:5px;color:#888;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
        .access-requests-section .detail-time{color:#999;font-size:11px;white-space:nowrap}
        .access-requests-section .manage-actions{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px}
        .access-requests-section .manage-actions button{width:auto!important;min-height:38px;height:38px;padding:0 13px;border-radius:9px;font-size:12px}
        .access-requests-section .status-select-label{display:flex;flex-direction:column;gap:5px;color:#666;font-size:10px;font-weight:700}
        .access-requests-section .admin-status-select{width:140px;height:38px;margin:0;padding:0 9px;border:1px solid #ddd;border-radius:9px;background:#fff;font-size:12px}
        .access-requests-section .admin-refresh{width:auto!important}
        @media(max-width:700px){.access-requests-section .account-row{grid-template-columns:1fr 90px 90px}.access-requests-section .account-head{display:none}.access-requests-section .account-row>*:nth-child(4){display:none}.access-requests-section .manage-button{justify-self:end}.access-requests-section .account-detail{grid-column:1/-1}.access-requests-section .account-detail-grid{grid-template-columns:1fr}.access-requests-section .detail-time{white-space:normal}}
      `}</style>

      <div className="admin-section-heading">
        <div>
          <h2>Extended access</h2>
          <p>One account per email. New requests are highlighted so you can attend to them.</p>
        </div>
        <button className="secondary-button admin-refresh" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {message && <div className="admin-success">{message}</div>}

      {items.length === 0 ? <p className="admin-muted">No requests yet.</p> : (
        <div className="account-table">
          <div className="account-row account-head"><span>User</span><span>Status</span><span>Current limit</span><span>Requests</span><span>Actions</span></div>
          {items.map(item => {
            const u = findUser(item);
            const current = Number(item.adminLimit ?? u?.maxChars ?? 1000);
            const statusValue = item.status || "Pending";
            const isManaged = managedEmail === item.email;
            const isNew = statusValue === "Pending";
            const when = requestMillis(item);
            return (
              <div className="account-row" key={item.email}>
                <div className="account-user">
                  <strong>{item.name || item.email}{isNew && <span className="new-request-badge">New request</span>}</strong>
                  <span>{item.email}</span>
                </div>
                <span className={`account-status ${String(statusValue).toLowerCase()}`}>{statusValue}</span>
                <span className="account-limit">{current.toLocaleString()}</span>
                <span className="account-requests">{item.requestCount || 1}</span>
                <button className="manage-button" onClick={() => setManagedEmail(isManaged ? null : item.email)}>{isManaged ? "Close" : "Manage"}</button>

                {isManaged && (
                  <div className="account-detail">
                    <div className="account-detail-grid">
                      <div>
                        <span className="detail-label">Latest justification</span>
                        <p>{item.purpose || "No justification provided."}</p>
                      </div>
                      <span className="detail-time">{when ? new Date(when).toLocaleString() : "No timestamp"}</span>
                    </div>
                    <div className="manage-actions">
                      <label className="status-select-label">Status
                        <select className="admin-status-select" value={statusValue} onChange={e => status(item, e.target.value)}>
                          <option value="Pending">Pending</option><option value="Denied">Denied</option><option value="Granted">Granted</option>
                        </select>
                      </label>
                      <button className="primary-button" onClick={() => editLimit(item)}>Edit limit</button>
                      {statusValue === "Granted" && !u && <button className="primary-button" onClick={() => invite(item)}>Invite</button>}
                      {u && u.active !== false && <button className="secondary-button" onClick={() => revoke(item)}>Revoke</button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
