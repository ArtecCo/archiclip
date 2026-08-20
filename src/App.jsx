import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp
} from "firebase/firestore";
import { QRCodeSVG } from "qrcode.react";
import { db } from "./firebase";

const CODE_LENGTH = 6;

const EXPIRATION_OPTIONS = [
  {
    label: "10 minutes",
    value: 10 * 60 * 1000
  },
  {
    label: "1 hour",
    value: 60 * 60 * 1000
  },
  {
    label: "24 hours",
    value: 24 * 60 * 60 * 1000
  }
];

function generateCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let result = "";

  for (let i = 0; i < CODE_LENGTH; i++) {
    result += characters.charAt(
      Math.floor(Math.random() * characters.length)
    );
  }

  return result;
}

function App() {
  const [text, setText] = useState("");
  const [expiration, setExpiration] = useState(
    EXPIRATION_OPTIONS[0].value
  );

  const [clip, setClip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [pathCode, setPathCode] = useState(null);

  useEffect(() => {
    const code = window.location.pathname.startsWith("/c/")
      ? window.location.pathname.split("/c/")[1]
      : null;

    if (code) {
      setPathCode(code.toUpperCase());
    }
  }, []);

  async function createClip() {
    setError("");

    if (!text.trim()) {
      setError("Please enter some text first.");
      return;
    }

    if (text.length > 10000) {
      setError("Text is limited to 10,000 characters.");
      return;
    }

    setLoading(true);

    try {
      let code = generateCode();

      let existing = await getDoc(doc(db, "clips", code));

      let attempts = 0;

      while (existing.exists() && attempts < 10) {
        code = generateCode();
        existing = await getDoc(doc(db, "clips", code));
        attempts++;
      }

      if (existing.exists()) {
        throw new Error("Could not generate a unique code. Try again.");
      }

      const expiresAt = Date.now() + expiration;

      await addDoc(collection(db, "clips"), {
        code,
        content: text,
        createdAt: serverTimestamp(),
        expiresAt,
        views: 0
      });

      setClip({
        code,
        content: text,
        expiresAt
      });

      window.history.pushState({}, "", `/c/${code}`);
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setText("");
    setClip(null);
    setError("");

    window.history.pushState({}, "", "/");
    setPathCode(null);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Could not access your clipboard.");
    }
  }

  async function shareClip() {
    const url = window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({
          title: "Shared Clip",
          text: "Open this shared text",
          url
        });
      } catch {
        // User cancelled sharing.
      }
    } else {
      await copyText(url);
      alert("Link copied!");
    }
  }

  if (pathCode && !clip) {
    return <ClipViewer code={pathCode} onHome={reset} />;
  }

  if (clip) {
    return (
      <div className="app">
        <main className="container">
          <Header />

          <section className="card success-card">
            <div className="success-icon">✓</div>

            <h1>Your clip is ready</h1>

            <p className="muted">
              Open this link on another device or share it with someone.
            </p>

            <div className="code-box">{clip.code}</div>

            <div className="qr-wrapper">
              <QRCodeSVG
                value={`${window.location.origin}/c/${clip.code}`}
                size={190}
                level="M"
              />
            </div>

            <div className="share-url">
              {window.location.origin}/c/{clip.code}
            </div>

            <div className="button-row">
              <button
                className="primary-button"
                onClick={() =>
                  copyText(`${window.location.origin}/c/${clip.code}`)
                }
              >
                Copy Link
              </button>

              <button
                className="secondary-button"
                onClick={shareClip}
              >
                Share
              </button>
            </div>

            <button className="text-button" onClick={reset}>
              Create another clip
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="container">
        <Header />

        <section className="hero">
          <div className="badge">FAST • SIMPLE • TEMPORARY</div>

          <h1>
            Send text
            <br />
            <span>instantly.</span>
          </h1>

          <p>
            Paste something here, get a link, and open it anywhere.
            No account required.
          </p>
        </section>

        <section className="card">
          <label htmlFor="clip-text">Your text</label>

          <textarea
            id="clip-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste text, links, notes, commands..."
            maxLength={10000}
          />

          <div className="textarea-footer">
            <span>{text.length.toLocaleString()} / 10,000</span>
          </div>

          <label htmlFor="expiration">Expires after</label>

          <select
            id="expiration"
            value={expiration}
            onChange={(event) =>
              setExpiration(Number(event.target.value))
            }
          >
            {EXPIRATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {error && <div className="error">{error}</div>}

          <button
            className="primary-button create-button"
            onClick={createClip}
            disabled={loading}
          >
            {loading ? "Creating..." : "Create Clip"}
          </button>
        </section>

        <section className="features">
          <Feature
            icon="⚡"
            title="Instant"
            text="Create a shareable clip in seconds."
          />

          <Feature
            icon="🔗"
            title="Simple"
            text="One link works across your devices."
          />

          <Feature
            icon="⌛"
            title="Temporary"
            text="Clips automatically expire."
          />
        </section>

        <Footer />
      </main>
    </div>
  );
}

function ClipViewer({ code, onHome }) {
  const [clip, setClip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadClip() {
      try {
        const snapshot = await getDoc(doc(db, "clips", code));

        if (!snapshot.exists()) {
          setError("This clip does not exist.");
          return;
        }

        const data = snapshot.data();

        if (data.expiresAt && Date.now() > data.expiresAt) {
          setError("This clip has expired.");
          return;
        }

        setClip(data);
      } catch (err) {
        console.error(err);
        setError("Could not load this clip.");
      } finally {
        setLoading(false);
      }
    }

    loadClip();
  }, [code]);

  async function copy() {
    if (!clip?.content) return;

    try {
      await navigator.clipboard.writeText(clip.content);
      alert("Copied!");
    } catch {
      alert("Could not copy the text.");
    }
  }

  if (loading) {
    return (
      <div className="app">
        <main className="container">
          <Header />

          <section className="card centered">
            <div className="loader"></div>
            <p>Loading clip...</p>
          </section>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <main className="container">
          <Header />

          <section className="card centered">
            <div className="error-icon">!</div>

            <h1>{error}</h1>

            <button className="primary-button" onClick={onHome}>
              Create a new clip
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="container">
        <Header />

        <section className="card">
          <div className="clip-header">
            <div>
              <span className="small-label">SHARED CLIP</span>
              <h1>{code}</h1>
            </div>

            <span className="live-dot">LIVE</span>
          </div>

          <div className="content-box">
            {clip.content}
          </div>

          <button className="primary-button create-button" onClick={copy}>
            Copy Text
          </button>

          <button className="text-button" onClick={onHome}>
            Create your own clip
          </button>
        </section>
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <button
        className="logo"
        onClick={() => {
          window.location.href = "/";
        }}
      >
        <span className="logo-mark">C</span>
        ClipSend
      </button>

      <span className="header-tag">Online Clipboard</span>
    </header>
  );
}

function Feature({ icon, title, text }) {
  return (
    <div className="feature">
      <div className="feature-icon">{icon}</div>

      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer>
      <span>ClipSend</span>
      <span>Temporary text sharing</span>
    </footer>
  );
}

export default App;
