import { useEffect, useState } from "react";
import { addDoc, collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth, db } from "./firebase";
import "./access.css";

export const DEFAULT_LIMIT = 1000;

export default function LimitAccess({ onLimitChange }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [requests, setRequests] = useState([]);
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [requestEmail, setRequestEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => onAuthStateChanged(auth, async (currentUser) => {
    setUser(currentUser);
    setError("");
    if (!currentUser) {
      setLimit(DEFAULT_LIMIT);
      onLimitChange?.(DEFAULT_LIMIT);
      return;
    }
    setEmail(currentUser.email || "");
    setRequestEmail(currentUser.email || "");
    await ensureProfile(currentUser);
  }), [onLimitChange]);

  async function ensureProfile(currentUser) {
    try {
      const ref = doc(db, "users", currentUser.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, { uid: currentUser.uid, email: currentUser.email || "", maxChars: DEFAULT_LIMIT, createdAt: new Date() });
        setLimit(DEFAULT_LIMIT);
        onLimitChange?.(DEFAULT_LIMIT);
      } else {
        const nextLimit = Math.max(DEFAULT_LIMIT, Number(snap.data().maxChars || DEFAULT_LIMIT));
        setLimit(nextLimit);
        onLimitChange?.(nextLimit);
      }
      await loadRequests(currentUser.uid);
    } catch (err) {
      console.error(err);
      setLimit(DEFAULT_LIMIT);
      onLimitChange?.(DEFAULT_LIMIT);
    }
  }

  async function loadRequests(uid) {
    try {
      const snapshot = await getDocs(query(collection(db, "accessRequests"), where("uid", "==", uid)));
      setRequests(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0)));
    } catch (err) {
      console.error(err);
    }
  }

  function clearFeedback() { setError(""); setMessage(""); }

  async function authenticate(event) {
    event.preventDefault();
    clearFeedback();
    setBusy(true);
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
        setMessage("Account created. You can now request an extended limit.");
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
        setMessage("Signed in.");
      }
      setPassword("");
    } catch (err) {
      console.error(err);
      setError(mode === "signup" ? "Could not create the account. Use a valid email and a password of at least 6 characters." : "Invalid email or password.");
    } finally { setBusy(false); }
  }

  async function submitRequest(event) {
    event.preventDefault();
    clearFeedback();
    if (!user) return setError("Sign in before requesting an extended limit.");
    if (!name.trim() || !requestEmail.trim() || !purpose.trim()) return setError("Please complete all fields.");
    setBusy(true);
    try {
      await addDoc(collection(db, "accessRequests"), {
        uid: user.uid,
        name: name.trim(),
        email: requestEmail.trim(),
        purpose: purpose.trim(),
        status: "Pending",
        requestedAt: new Date()
      });
      setName("");
      setPurpose("");
      setMessage("Request submitted. The admin will review it.");
      await loadRequests(user.uid);
    } catch (err) {
      console.error(err);
      setError("Could not submit the request. Please try again.");
    } finally { setBusy(false); }
  }

  async function logout() {
    clearFeedback();
    await signOut(auth);
    setMode("signin");
    setOpen(false);
  }

  return <>
    <button className="limit-fab" onClick={() => { clearFeedback(); setOpen(true); }} aria-label="Character limit and account options">
      {limit > DEFAULT_LIMIT ? `${limit.toLocaleString()} chars` : "Need more characters?"}
    </button>
    {open && <div className="limit-dialog">
      <div className="limit-dialog-header"><div><span className="small-label">ARCHICLIP ACCESS</span><h2>{user ? "Extended character limit" : "Use more characters"}</h2></div><button className="limit-close" onClick={() => setOpen(false)} aria-label="Close">×</button></div>
      {!user ? <>
        <p className="limit-muted">Create an account or sign in to request and use an extended limit.</p>
        <div className="limit-tabs"><button className={mode === "signin" ? "active" : ""} onClick={() => { clearFeedback(); setMode("signin"); }}>Sign in</button><button className={mode === "signup" ? "active" : ""} onClick={() => { clearFeedback(); setMode("signup"); }}>Create account</button></div>
        <form className="limit-form" onSubmit={authenticate}>
          <label htmlFor="limit-email">Email</label><input id="limit-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <label htmlFor="limit-password">Password</label><input id="limit-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
          {error && <div className="limit-error">{error}</div>}{message && <div className="limit-success">{message}</div>}
          <button className="primary-button create-button" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
        </form>
      </> : <>
        <div className="limit-account"><span>Signed in as</span><strong>{user.email}</strong><small>Current limit: {limit.toLocaleString()} characters</small></div>
        {limit > DEFAULT_LIMIT && <div className="limit-granted">✓ Extended limit granted</div>}
        <form className="limit-form" onSubmit={submitRequest}>
          <label htmlFor="request-name">Name</label><input id="request-name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label htmlFor="request-email">Email</label><input id="request-email" type="email" value={requestEmail} onChange={(e) => setRequestEmail(e.target.value)} required />
          <label htmlFor="request-purpose">Purpose</label><textarea id="request-purpose" className="limit-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why do you need a higher character limit?" required />
          {error && <div className="limit-error">{error}</div>}{message && <div className="limit-success">{message}</div>}
          <button className="primary-button create-button" disabled={busy}>{busy ? "Submitting…" : "Request extended limit"}</button>
        </form>
        {requests.length > 0 && <div className="limit-history"><strong>Your requests</strong>{requests.slice(0, 3).map((item) => <div className="limit-request" key={item.id}><span>{item.status}</span><small>{item.purpose}</small></div>)}</div>}
        <button className="limit-signout" onClick={logout}>Sign out</button>
      </>}
    </div>}
  </>;
}
