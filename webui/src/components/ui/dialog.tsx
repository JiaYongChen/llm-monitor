import * as React from "react"
import { cn } from "../../lib/utils"

interface DialogProps { open: boolean; onClose: () => void; children: React.ReactNode }
function Dialog({ open, onClose, children }: DialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-50 w-full max-w-xl bg-white rounded-2xl border border-gray-200 shadow-2xl p-6 animate-in max-h-[90vh] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col space-y-1.5 mb-4">{children}</div>
}
function DialogTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-gray-900 leading-none tracking-tight">{children}</h2>
}
function DialogDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500">{children}</p>
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription }
