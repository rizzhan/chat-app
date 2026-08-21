import { useEffect, useRef, useState } from "react";
import ModalShell from "./components/ModalShell";

const CONTAINER = 320;
const CROP = 280;
const PREVIEW = 96;
const OUT = 512;

function AvatarCropper({ file, title = "Crop profile picture", onCancel, onSave }) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [previewUrl, setPreviewUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dragRef = useRef(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setZoom(1);
      setPos({ x: 0, y: 0 });
    };
    image.onerror = () => setError("Could not read this image.");
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const scale = img
    ? (CROP / Math.min(img.naturalWidth, img.naturalHeight)) * zoom
    : 1;
  const rw = img ? img.naturalWidth * scale : 0;
  const rh = img ? img.naturalHeight * scale : 0;
  const baseLeft = (CONTAINER - rw) / 2;
  const baseTop = (CONTAINER - rh) / 2;
  const maxX = Math.max(0, (rw - CROP) / 2);
  const maxY = Math.max(0, (rh - CROP) / 2);
  const x = Math.max(-maxX, Math.min(maxX, pos.x));
  const y = Math.max(-maxY, Math.min(maxY, pos.y));

  useEffect(() => {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PREVIEW;
    const ctx = canvas.getContext("2d");
    const sx = ((img.naturalWidth * scale - CROP) / 2 - x) / scale;
    const sy = ((img.naturalHeight * scale - CROP) / 2 - y) / scale;
    const src = CROP / scale;
    ctx.beginPath();
    ctx.arc(PREVIEW / 2, PREVIEW / 2, PREVIEW / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, src, src, 0, 0, PREVIEW, PREVIEW);
    setPreviewUrl(canvas.toDataURL("image/png"));
  }, [img, zoom, x, y, scale]);

  const handleSave = () => {
    setSaving(true);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    const sx = ((img.naturalWidth * scale - CROP) / 2 - x) / scale;
    const sy = ((img.naturalHeight * scale - CROP) / 2 - y) / scale;
    const src = CROP / scale;
    ctx.beginPath();
    ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, src, src, 0, 0, OUT, OUT);
    canvas.toBlob(
      async (blob) => {
        try {
          if (blob) await onSave(blob);
        } finally {
          setSaving(false);
        }
      },
      "image/png"
    );
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, dx: pos.x, dy: pos.y };
  };

  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    setPos({
      x: dragRef.current.dx + (e.clientX - dragRef.current.startX),
      y: dragRef.current.dy + (e.clientY - dragRef.current.startY),
    });
  };

  const onPointerUp = (e) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const next = zoom * (e.deltaY < 0 ? 1.08 : 0.92);
    setZoom(Math.min(3, Math.max(1, next)));
  };

  return (
    <ModalShell open onClose={onCancel} className="avatar-crop-modal" overlayClassName="overlay-dim modal-shell-front">
      <h3>{title}</h3>

      <div className="avatar-cropper">
        <div className="crop-row">
          <div
            className="crop-area"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          >
            {img && (
              <>
                <img
                  className="crop-image"
                  src={img.src}
                  alt=""
                  draggable={false}
                  style={{
                    left: baseLeft + x,
                    top: baseTop + y,
                    width: rw,
                    height: rh,
                  }}
                />
                <div className="crop-ring" />
              </>
            )}
          </div>
          <div className="crop-preview">
            <span className="crop-preview-label">Preview</span>
            {previewUrl ? (
              <img src={previewUrl} alt="Preview" />
            ) : (
              <div className="crop-preview-empty" />
            )}
          </div>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="crop-hint">Drag to reposition · Scroll or use the slider to zoom</div>

        <div className="crop-controls">
          <span className="crop-label">Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </div>

        <div className="modal-actions">
          <button
            className="auth-button"
            style={{ background: "var(--bg)", color: "var(--text)" }}
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="auth-button"
            onClick={handleSave}
            disabled={saving || !img}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export default AvatarCropper;
