import { IconCamera, IconUser, IconSettings, IconLock } from "./Icons";

export type View = "camera" | "people" | "settings";

const TABS: { id: View; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: "camera", label: "Camera", Icon: IconCamera },
  { id: "people", label: "People", Icon: IconUser },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

/** Exactly three tabs (UNIFIED-02 §4). People and Settings are PIN-gated —
 * the lock dot just advertises that; the gate itself lives in App. */
export default function BottomNav({
  active,
  onChange,
  unlocked,
}: {
  active: View;
  onChange: (v: View) => void;
  unlocked: boolean;
}) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-surface border-t border-line flex pb-[env(safe-area-inset-bottom)] z-20">
      {TABS.map(({ id, label, Icon }) => {
        const guarded = id !== "camera";
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`relative flex-1 flex flex-col items-center py-2.5 text-[11px] gap-1 ${
              active === id ? "text-primary font-semibold" : "text-ink-muted"
            }`}
          >
            <span className="relative">
              {active === id && (
                <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-primary" />
              )}
              <Icon size={22} />
              {guarded && !unlocked && (
                <span className="absolute -top-1 -right-1.5 bg-ink-muted text-white rounded-full p-[3px]">
                  <IconLock size={9} />
                </span>
              )}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
