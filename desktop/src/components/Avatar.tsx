const PALETTE_SIZE = 8;

export function agentColorClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `agent-c${h % PALETTE_SIZE}`;
}

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={`avatar ${small ? "sm" : ""} ${agentColorClass(name)}`} aria-hidden>
      {initial}
    </span>
  );
}
