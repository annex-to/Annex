import { NavLink } from "react-router-dom";

interface SidebarNavItem {
  to: string;
  label: string;
  end?: boolean;
}

interface SidebarNavProps {
  items: SidebarNavItem[];
}

export function SidebarNav({ items }: SidebarNavProps) {
  return (
    <nav className="flex flex-col gap-1 w-48">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `px-4 py-2.5 rounded text-sm font-medium transition-all duration-150 ${
              isActive
                ? "bg-white/10 text-white border-l-2 border-annex-500"
                : "text-white/50 hover:text-white hover:bg-white/5"
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
