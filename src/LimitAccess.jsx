import { useEffect, useState } from "react";
import { addDoc, collection, doc, getDoc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "./firebase";
import "./access.css";

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 100000;
function safeLimit(value, fallback = DEFAULT_LIMIT) { const n = Number(value); return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(n))) : fallback; }

export default function LimitAccess({ onLimitChange }) {
  const [open, setOpen] = useState(false), [user, setUser] = useState(null), [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [requests, setRequests] = useState([]), [mode, setMode] = useState("request"), [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [name, setName] = useState(""), [purpose, setPurpose] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const inviteToken = new URLSearchParams(window.location.search).get("invite");

  useEffect(() => onAuthStateChanged(auth, async currentUser => {
    setUser(currentUser); setError("");
    if (!currentUser) { setLimit(DEFAULT_LIMIT); onLimitChange?.(DEFAULT_LIMIT); return; }
    await loadProfile(currentUser);
    if (!inviteToken && open) setMode("account");
  }), [onLimitChange, inviteToken, open]);
  useEffect(() => { if (inviteToken) { setOpen(true); setMode("invite"); } }, [inviteToken]);

  async function loadProfile(currentUser) {
    try {
      const snap = await getDoc(doc(db, "users", currentUser.uid));
      const data = snap.exists() ? snap.data() : {};
      const next = data.active === false ? DEFAULT_LIMIT : safeLimit(data.maxChars, DEFAULT_LIMIT);
      setLimit(next); onLimitChange?.(next); await loadRequests(currentUser.email);
      return next;
    } catch (err) { console.error("Could not load user profile", err); setLimit(DEFAULT_LIMIT); onLimitChange?.(DEFAULT_LIMIT); return DEFAULT_LIMIT; }
  }
  async function loadRequests(userEmail) { try { const snap=await getDocs(query(collection(db,"accessRequests"),where("email","==",String(userEmail||"").toLowerCase()))); setRequests(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.requestedAt?.seconds||0)-(a.requestedAt?.seconds||0))); } catch (err) { console.error("Could not load access requests", err); } }
  function clear(){setError("");setMessage("");}
  async function submitRequest(e){e.preventDefault();clear();if(!name.trim()||!email.trim()||!purpose.trim())return setError("Please complete all fields.");setBusy(true);try{await addDoc(collection(db,"accessRequests"),{name:name.trim(),email:email.trim().toLowerCase(),purpose:purpose.trim(),status:"Pending",requestedAt:new Date()});setName("");setPurpose("");setMessage("Request submitted. We will contact you after review.");}catch(err){console.error(err);setError("Could not submit your request. Please try again.");}finally{setBusy(false);}}
  async function signIn(e){
    e.preventDefault(); clear(); setBusy(true);
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      setPassword(""); setUser(credential.user);
      const nextLimit = await loadProfile(credential.user);
      setLimit(nextLimit); onLimitChange?.(nextLimit);
      setMode("account"); setMessage(`Signed in. Your current limit is ${nextLimit.toLocaleString()} characters.`);
    } catch(err) { console.error(err); setError(err?.code === "auth/invalid-credential" ? "Invalid email or password." : "Could not sign in. Please try again."); }
    finally { setBusy(false); }
  }
  async function claimInvite(e){e.preventDefault();clear();if(!inviteToken)return setError("Invitation link is missing.");setBusy(true);try{const inviteSnap=await getDoc(doc(db,"accessInvites",inviteToken));if(!inviteSnap.exists())throw new Error("invalid");const invite=inviteSnap.data();if(invite.used||(invite.expiresAt&&Date.now()>invite.expiresAt))throw new Error("expired");const invitedEmail=String(invite.email||"").trim().toLowerCase();if(email.trim().toLowerCase()!==invitedEmail)return setError(`Use the invited email address: ${invitedEmail}`);const grantedLimit=safeLimit(invite.maxChars,DEFAULT_LIMIT);let account=auth.currentUser;if(account){if(account.email?.toLowerCase()!==invitedEmail)return setError(`Sign out and use the invited email address: ${invitedEmail}`);}else{try{account=await createUserWithEmailAndPassword(auth,invitedEmail,password);}catch(err){if(err?.code!=="auth/email-already-in-use")throw err;account=(await signInWithEmailAndPassword(auth,invitedEmail,password)).user;}}if(!account)throw new Error("no-account");await updateDoc(doc(db,"users",account.uid),{uid:account.uid,maxChars:grantedLimit,active:true,email:account.email,invitedAt:new Date(),inviteId:inviteToken,status:"Granted"});await updateDoc(doc(db,"accessInvites",inviteToken),{used:true,usedBy:account.uid,usedAt:new Date()});if(invite.requestId)await updateDoc(doc(db,"accessRequests",invite.requestId),{status:"Granted",grantedAt:new Date(),uid:account.uid,adminLimit:grantedLimit});setUser(account);setLimit(grantedLimit);onLimitChange?.(grantedLimit);setMessage(`Access activated. Your limit is ${grantedLimit.toLocaleString()} characters.`);window.history.replaceState({},"",window.location.pathname);setMode("account");}catch(err){console.error(err);setError(err?.message==="expired"?"This invitation has expired or has already been used.":err?.code==="auth/invalid-credential"?"The email or password is incorrect.":"Could not activate the invitation. Check the invitation, email and password.");}finally{setBusy(false);}}
  async function logout(){await signOut(auth);setUser(null);setLimit(DEFAULT_LIMIT);onLimitChange?.(DEFAULT_LIMIT);setMode("request");setMessage("");setError("");setOpen(false);}
  return <><button className="limit-fab" onClick={()=>{clear();setOpen(true);if(user)setMode("account");else setMode("request");}} aria-label="Request extended character limit">{limit>DEFAULT_LIMIT?`${limit.toLocaleString()} chars`:"Need more characters?"}</button>{open&&<div className="limit-dialog"><div className="limit-dialog-header"><div><span className="small-label">ARCHICLIP ACCESS</span><h2>{mode==="invite"?"Activate your access":mode==="signin"?"Sign in":mode==="account"?"Your access":"Need more characters?"}</h2></div><button className="limit-close" onClick={()=>setOpen(false)} aria-label="Close">×</button></div>{mode==="request"&&<><p className="limit-muted">Request an extended character limit. If approved, we will contact you with an invitation.</p><form className="limit-form" onSubmit={submitRequest}><label>Name</label><input value={name} onChange={e=>setName(e.target.value)} required /><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /><label>Purpose</label><textarea className="limit-purpose" value={purpose} onChange={e=>setPurpose(e.target.value)} placeholder="Why do you need a higher character limit?" required />{error&&<div className="limit-error">{error}</div>}{message&&<div className="limit-success">{message}</div>}<button className="primary-button create-button" disabled={busy}>{busy?"Submitting…":"Submit request"}</button></form><button className="limit-signin-link" onClick={()=>{clear();setMode("signin");}}>Already invited? Sign in</button></>}{mode==="signin"&&<><p className="limit-muted">Sign in to use your approved character limit.</p><form className="limit-form" onSubmit={signIn}><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /><label>Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} />{error&&<div className="limit-error">{error}</div>}{message&&<div className="limit-success">{message}</div>}<button className="primary-button create-button" disabled={busy}>{busy?"Signing in…":"Sign in"}</button></form><button className="limit-signin-link" onClick={()=>{clear();setMode("request");}}>Request access</button></>}{mode==="invite"&&<><p className="limit-muted">Your request was approved. Use the invited email and your existing password, or create an account if you do not have one yet.</p><form className="limit-form" onSubmit={claimInvite}><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /><label>Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} autoComplete="current-password" />{error&&<div className="limit-error">{error}</div>}{message&&<div className="limit-success">{message}</div>}<button className="primary-button create-button" disabled={busy}>{busy?"Activating…":"Activate access"}</button></form></>}{mode==="account"&&<><div className="limit-account"><span>Signed in as</span><strong>{user?.email}</strong><small>Current limit: {limit.toLocaleString()} characters</small></div>{message&&<div className="limit-success">{message}</div>}{requests.length>0&&<div className="limit-history"><strong>Your requests</strong>{requests.slice(0,3).map(r=><div className="limit-request" key={r.id}><span>{r.status}</span><small>{r.purpose}</small></div>)}</div>}<button className="limit-signout" onClick={logout}>Sign out</button></>}</div>}</>;
}
