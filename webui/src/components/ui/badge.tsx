import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"
const badgeVariants = cva("inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors", {
  variants: { variant: { default: "border-transparent bg-gray-900 text-white", secondary: "border-transparent bg-gray-100 text-gray-700", destructive: "border-transparent bg-red-100 text-red-700", outline: "border-gray-300 text-gray-700" } },
  defaultVariants: { variant: "default" },
})
export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}
function Badge({ className, variant, ...props }: BadgeProps) { return <div className={cn(badgeVariants({ variant }), className)} {...props} /> }
export { Badge, badgeVariants }
