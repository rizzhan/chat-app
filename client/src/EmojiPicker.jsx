import { useState } from "react";
import { EMOJIS } from "./emojis";

function EmojiPicker({ onSelect }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="emoji-picker-wrap">
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen(!open)}
        aria-label="Emoji"
      >
        😊
      </button>

      {open && (
        <div className="emoji-picker">
          {EMOJIS.map((e) => (
            <button
              type="button"
              key={e}
              className="emoji-item"
              onClick={() => {
                onSelect(e);
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default EmojiPicker;
