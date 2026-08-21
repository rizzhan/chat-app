import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

let openCount = 0;

function ModalShell({ open, onClose, className, overlayClassName, children }) {
  useEffect(() => {
    if (open) {
      openCount += 1;
      document.body.classList.add("modal-open");
    } else {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) document.body.classList.remove("modal-open");
    }
    return () => {
      if (open) {
        openCount = Math.max(0, openCount - 1);
        if (openCount === 0) document.body.classList.remove("modal-open");
      }
    };
  }, [open]);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className={`modal-overlay modal-shell ${overlayClassName || ""}`.trim()}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className={`modal ${className || ""}`.trim()}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.92, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 14 }}
            transition={{ type: "spring", damping: 26, stiffness: 340 }}
          >
            {typeof children === "function" ? children() : children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default ModalShell;