import { useState } from "react";
import { EMOJIS } from "./emojis";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

function EmojiPicker({ onSelect }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="emoji-picker-wrap">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="icon-button"
              onClick={() => setOpen(!open)}
              aria-label="Emoji"
            >
              😊
            </button>
          }
        />
        <TooltipContent>Emoji</TooltipContent>
      </Tooltip>

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
