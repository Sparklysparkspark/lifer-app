import { useTheme } from "../hooks/useTheme";
import { useDarkChrome } from "../lib/plugins";

interface LogoProps {
  variant?: "wordmark" | "text" | "icon";
  className?: string;
}

export function Logo({ variant = "wordmark", className }: LogoProps) {
  const { theme } = useTheme();
  const darkChrome = useDarkChrome();
  const file = variant === "wordmark" ? "wordmark" : variant === "text" ? "text-logo" : "icon";
  return (
    <img
      src={`/branding/${file}${theme === "dark" || darkChrome ? "-dark" : ""}.png`}
      alt="Lifer"
      className={className}
    />
  );
}
