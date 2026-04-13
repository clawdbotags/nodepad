"use client"

import { motion, AnimatePresence } from "framer-motion"
import { Scissors, FileText, Loader2 } from "lucide-react"

interface SplitConfirmProps {
  open: boolean
  text: string
  isSplitting: boolean
  onSplit: () => void
  onKeepSingle: () => void
  onCancel: () => void
}

export function SplitConfirm({ open, text, isSplitting, onSplit, onKeepSingle, onCancel }: SplitConfirmProps) {
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text
  const lineCount = text.split("\n").filter(l => l.trim()).length

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !isSplitting) onCancel() }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="w-full max-w-md mx-4 bg-black/95 border border-white/15 rounded-sm shadow-2xl"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-white/10">
              <h3 className="font-mono text-xs font-bold text-white/90 uppercase tracking-[0.15em]">
                Multi-item text detected
              </h3>
              <p className="mt-1.5 font-mono text-[10px] text-white/50 leading-relaxed">
                {lineCount} lines detected. Split into separate notes or keep as one?
              </p>
            </div>

            {/* Preview */}
            <div className="px-5 py-3 max-h-[200px] overflow-y-auto scrollbar-none">
              <pre className="font-mono text-[10px] text-white/40 whitespace-pre-wrap leading-relaxed">
                {preview}
              </pre>
            </div>

            {/* Actions */}
            <div className="px-5 py-4 border-t border-white/10 flex items-center gap-2">
              <button
                onClick={onSplit}
                disabled={isSplitting}
                className="flex items-center gap-2 px-4 py-2 rounded-sm bg-primary/15 border border-primary/30 font-mono text-[10px] font-bold text-primary uppercase tracking-[0.1em] hover:bg-primary/25 transition-all disabled:opacity-50"
              >
                {isSplitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Scissors className="h-3.5 w-3.5" />
                )}
                {isSplitting ? "Splitting…" : "Split into notes"}
              </button>

              <button
                onClick={onKeepSingle}
                disabled={isSplitting}
                className="flex items-center gap-2 px-4 py-2 rounded-sm bg-white/5 border border-white/10 font-mono text-[10px] font-bold text-white/60 uppercase tracking-[0.1em] hover:bg-white/10 transition-all disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                Keep as one
              </button>

              <div className="flex-1" />

              <button
                onClick={onCancel}
                disabled={isSplitting}
                className="px-3 py-2 font-mono text-[9px] text-white/40 uppercase tracking-[0.1em] hover:text-white/60 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
