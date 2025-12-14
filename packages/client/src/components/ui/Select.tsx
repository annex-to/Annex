import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={`
          px-4 py-2.5
          bg-white/5 backdrop-blur-sm
          border border-white/10
          rounded text-white
          transition-all duration-150
          hover:bg-white/[0.07] hover:border-white/20
          focus:outline-none focus:bg-white/[0.08] focus:border-annex-500/50 focus:ring-1 focus:ring-annex-500/30
          appearance-none cursor-pointer
          bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.5%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')]
          bg-[length:12px] bg-[right_12px_center] bg-no-repeat
          pr-10
          [&_option]:bg-zinc-900 [&_option]:text-white
          [&_optgroup]:bg-zinc-900 [&_optgroup]:text-white
          ${className}
        `}
        {...props}
      >
        {children}
      </select>
    );
  }
);

Select.displayName = "Select";

export { Select };
