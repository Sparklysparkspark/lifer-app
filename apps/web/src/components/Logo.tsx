import { useTheme } from "../hooks/useTheme";

interface LogoProps {
  variant?: "wordmark" | "text" | "icon";
  className?: string;
}

export function Logo({ variant = "wordmark", className }: LogoProps) {
  const { theme } = useTheme();
  const suffix = theme === "dark" ? "-dark" : "";
  const file = variant === "wordmark" ? "wordmark" : variant === "text" ? "text-logo" : "icon";
  return <img src={`/branding/${file}${suffix}.png`} alt="Lifer" className={className} />;
}
