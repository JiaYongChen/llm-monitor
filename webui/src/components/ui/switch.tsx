import * as React from "react"
import { cn } from "../../lib/utils"
const Switch = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }>(({ className, checked, onCheckedChange, ...props }, ref) => (
  <button type="button" role="switch" aria-checked={checked} data-state={checked ? "checked" : "unchecked"}
    className={cn("peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-gray-300", className)}
    onClick={() => onCheckedChange?.(!checked)} {...props} ref={ref}>
    <span data-state={checked ? "checked" : "unchecked"} className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </button>
))
Switch.displayName = "Switch"
export { Switch }
