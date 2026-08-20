import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

export default function ReceiveWidget() {
  const [code, setCode] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  if (window.location.pathname !== "/" && window.location.pathname !== "") return null;

  function openCode() {
    const value = code.trim().toUpperCase();
    setError("");
    if (!/^[A-Z0-9]{6}$/.test(value)) {
      setError("Enter a valid 6-character clip code.");
      return;
    }
    window.location.href = `/c/${value}`;
  }

  function handleScan(value) {
    try {
      const url = new URL(value);
      if (url.origin !== window.location.origin || !/^\/c\/[A-Za-z0-9]{6}\/?$/.test(url.pathname)) throw new Error();
      window.location.href = url.href;
    } catch {
      setError("That QR code is not an ArchiClip clip link.");
      setScannerOpen(false);
    }
  }

  useEffect(() => {
    if (!scannerOpen) return undefined;
    let stream;
    let frame;
    let active = true;
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!active) return stream.getTracks().forEach((track) => track.stop());
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const scan = () => {
          if (!active) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video.readyState >= 2) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
            if (result?.data) return handleScan(result.data);
          }
          frame = requestAnimationFrame(scan);
        };
        scan();
      } catch (err) {
        console.error(err);
        setError(err.name === "NotAllowedError" ? "Camera access was blocked. Allow camera access and try again." : "Could not open the camera. Use HTTPS and a supported browser.");
      }
    }
    start();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [scannerOpen]);

  if (scannerOpen) {
    return <section className="receive-panel card scanner-inline">
      <span className="small-label">QR SCANNER</span>
      <h2>Scan a clip</h2>
      <p className="muted">Point your camera at an ArchiClip QR code.</p>
      <div className="camera-frame"><video ref={videoRef} playsInline muted /><div className="scan-corners" /></div>
      <canvas ref={canvasRef} hidden />
      {error && <div className="error">{error}</div>}
      <button className="secondary-button create-button" onClick={() => { setScannerOpen(false); setError(""); }}>Cancel</button>
    </section>;
  }

  return <section className="receive-panel card">
    <div className="receive-heading">
      <div><span className="small-label">RECEIVE A CLIP</span><h2>Open on this device</h2></div>
      <span className="receive-icon">↗</span>
    </div>
    <p className="muted">Enter the 6-character code or scan the QR code.</p>
    <div className="receive-row">
      <input className="code-input" value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6))} onKeyDown={(event) => event.key === "Enter" && openCode()} placeholder="ABC123" maxLength={6} autoCapitalize="characters" autoComplete="off" />
      <button className="secondary-button" onClick={openCode}>Open Clip</button>
    </div>
    <button className="secondary-button scan-button" onClick={() => { setError(""); setScannerOpen(true); }}>▣ Scan QR Code</button>
    {error && <div className="error receive-error">{error}</div>}
  </section>;
}
