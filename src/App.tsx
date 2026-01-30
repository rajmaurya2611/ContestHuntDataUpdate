import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * ✅ Vite + React + Tailwind + TypeScript
 * Env (Vite):
 *   VITE_REFRESH_API_URL=...
 *   VITE_DATA_API_URL=...
 */
const REFRESH_API_URL: string = `${import.meta.env.VITE_REFRESH_API_URL ?? "/api/refresh"}`;
const DATA_API_URL: string = `${import.meta.env.VITE_DATA_API_URL ?? "/api/data"}`;

const IST_TZ = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

function formatIST(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatISTTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Next fire time (ms since epoch) for an IST time (HH:MM), re-armed daily.
 * IST is fixed UTC+05:30, so deterministic offset math is safe.
 */
function getNextISTTriggerMs(targetHour: number, targetMinute: number): number {
  const nowMs = Date.now();
  const istNow = new Date(nowMs + IST_OFFSET_MS);

  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();

  const targetIstAsUtcMs = Date.UTC(y, m, d, targetHour, targetMinute, 0, 0);
  let targetEpochMs = targetIstAsUtcMs - IST_OFFSET_MS;

  if (targetEpochMs <= nowMs) {
    const nextDayIstAsUtcMs = Date.UTC(y, m, d + 1, targetHour, targetMinute, 0, 0);
    targetEpochMs = nextDayIstAsUtcMs - IST_OFFSET_MS;
  }

  return targetEpochMs;
}

async function hitApiGET(url: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} ${text}`.trim());
  }

  // Payload intentionally ignored (per requirement)
  try {
    await res.json();
  } catch {
    // ignore
  }
}

/** localStorage-backed state so counters survive refresh */
function usePersistentState<T>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initialValue;
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value]);

  return [value, setValue];
}

type SlotId = "t0345" | "t0355" | "t0405";

type SlotConfig = {
  id: SlotId;
  h: number;
  m: number;
  label: string;
};

type SlotStats = {
  count: number;
  lastHitIST: string; // "—" or formatted IST date+time
};

type SlotState = Record<SlotId, SlotStats>;
type SlotNextMap = Partial<Record<SlotId, string>>;

export default function App() {
  // =========================
  // LEFT: 13-minute countdown
  // Uses REFRESH API
  // =========================
  const CYCLE_MS = 13 * 60 * 1000;

  const [leftRemainingMs, setLeftRemainingMs] = useState<number>(CYCLE_MS);
  const [leftHits, setLeftHits] = usePersistentState<number>("refreshHits", 0);
  const [leftLastHitIST, setLeftLastHitIST] = usePersistentState<string>("refreshLastHitIST", "—");

  const leftEndTimeRef = useRef<number>(Date.now() + CYCLE_MS);
  const leftFiredRef = useRef<boolean>(false);

  const safeRefreshHit = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    try {
      await hitApiGET(REFRESH_API_URL, controller.signal);
    } finally {
      controller.abort();
    }
  }, []);

  useEffect(() => {
    const tick = (): void => {
      const now = Date.now();
      const remaining = Math.max(0, leftEndTimeRef.current - now);
      setLeftRemainingMs(remaining);

      if (remaining === 0 && !leftFiredRef.current) {
        leftFiredRef.current = true;

        void (async () => {
          try {
            await safeRefreshHit();
          } catch (e) {
            console.error("[REFRESH API] hit failed:", e);
          } finally {
            setLeftHits((c) => c + 1);
            setLeftLastHitIST(formatIST(new Date()));

            leftEndTimeRef.current = Date.now() + CYCLE_MS;
            leftFiredRef.current = false;
            setLeftRemainingMs(CYCLE_MS);
          }
        })();
      }
    };

    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [safeRefreshHit, setLeftHits, setLeftLastHitIST]);

  const leftMin = Math.floor(leftRemainingMs / 60000);
  const leftSec = Math.floor((leftRemainingMs % 60000) / 1000);

  // ============================================
  // RIGHT: IST clock + 3 scheduled hits (separate)
  // Uses DATA API
  // ============================================
  const scheduleSlots: SlotConfig[] = useMemo(
    () => [
      { id: "t0345", h: 3, m: 45, label: "03:45 IST" },
      { id: "t0355", h: 3, m: 55, label: "03:55 IST" },
      { id: "t0405", h: 4, m: 5, label: "04:05 IST" },
    ],
    []
  );

  const [rightNowIST, setRightNowIST] = useState<string>(formatISTTime(new Date()));

  const [slotState, setSlotState] = usePersistentState<SlotState>("dataSlotState", {
    t0345: { count: 0, lastHitIST: "—" },
    t0355: { count: 0, lastHitIST: "—" },
    t0405: { count: 0, lastHitIST: "—" },
  });

  const [slotNextFireIST, setSlotNextFireIST] = useState<SlotNextMap>(() => {
    const next: SlotNextMap = {};
    scheduleSlots.forEach((s) => {
      const nextMs = getNextISTTriggerMs(s.h, s.m);
      next[s.id] = formatIST(new Date(nextMs));
    });
    return next;
  });

  const timeoutsRef = useRef<number[]>([]);

  const safeDataHit = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    try {
      await hitApiGET(DATA_API_URL, controller.signal);
    } finally {
      controller.abort();
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setRightNowIST(formatISTTime(new Date()));
    }, 250);

    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // StrictMode-safe cleanup
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];

    const armSlot = (slot: SlotConfig): void => {
      const scheduleNext = (): void => {
        const nextMs = getNextISTTriggerMs(slot.h, slot.m);
        const delay = Math.max(0, nextMs - Date.now());

        setSlotNextFireIST((prev) => ({ ...prev, [slot.id]: formatIST(new Date(nextMs)) }));

        const t = window.setTimeout(() => {
          void (async () => {
            try {
              await safeDataHit();
            } catch (e) {
              console.error(`[DATA API ${slot.label}] hit failed:`, e);
            } finally {
              const nowIST = formatIST(new Date());

              setSlotState((prev) => ({
                ...prev,
                [slot.id]: {
                  count: (prev?.[slot.id]?.count ?? 0) + 1,
                  lastHitIST: nowIST,
                },
              }));

              scheduleNext(); // re-arm daily
            }
          })();
        }, delay);

        timeoutsRef.current.push(t);
      };

      scheduleNext();
    };

    scheduleSlots.forEach(armSlot);

    return () => {
      timeoutsRef.current.forEach((t) => window.clearTimeout(t));
      timeoutsRef.current = [];
    };
  }, [safeDataHit, scheduleSlots, setSlotState]);

  const totalDataHits =
    (slotState.t0345?.count ?? 0) + (slotState.t0355?.count ?? 0) + (slotState.t0405?.count ?? 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LEFT (REFRESH API) */}
        <section className="rounded-2xl border border-white/10 bg-slate-900/40 shadow-xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tracking-wide text-slate-200">
                Left: 13-Minute Cycle (Refresh API)
              </h2>
            </div>
          </div>

          <div className="mt-3 text-5xl font-extrabold tracking-wider tabular-nums">
            {pad2(leftMin)}:{pad2(leftSec)}
          </div>

          <div className="mt-4 divide-y divide-white/10 border-t border-white/10">
            <div className="flex items-center justify-between py-3 text-sm">
              <span className="text-slate-300/80">Counter</span>
              <span className="font-semibold tabular-nums">{leftHits}</span>
            </div>
            <div className="flex items-center justify-between py-3 text-sm">
              <span className="text-slate-300/80">Last hit (IST date+time)</span>
              <span className="font-semibold">{leftLastHitIST}</span>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-300/70 leading-relaxed">
            Countdown restarts at 13:00 after each hit; API response is suppressed.
          </p>
        </section>

        {/* RIGHT (DATA API) */}
        <section className="rounded-2xl border border-white/10 bg-slate-900/40 shadow-xl p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tracking-wide text-slate-200">
                Right: IST Clock + Daily Data API Hits (separate slots)
              </h2>
            </div>
          </div>

          <div className="mt-3 text-5xl font-extrabold tracking-wider tabular-nums">{rightNowIST}</div>

          <div className="mt-4 rounded-xl border border-white/10 overflow-hidden">
            <div className="grid grid-cols-12 bg-white/5 text-xs font-semibold text-slate-200/90">
              <div className="col-span-3 px-3 py-2">Slot</div>
              <div className="col-span-3 px-3 py-2">Counter</div>
              <div className="col-span-6 px-3 py-2">Last hit / Next (IST)</div>
            </div>

            {scheduleSlots.map((s) => {
              const st = slotState[s.id];
              const next = slotNextFireIST[s.id] ?? "—";
              return (
                <div key={s.id} className="grid grid-cols-12 border-t border-white/10 text-sm">
                  <div className="col-span-3 px-3 py-3 font-semibold">{s.label}</div>
                  <div className="col-span-3 px-3 py-3 tabular-nums">{st.count}</div>
                  <div className="col-span-6 px-3 py-3">
                    <div className="text-slate-100/90">{st.lastHitIST}</div>
                    <div className="text-xs text-slate-300/70 mt-1">Next: {next}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between text-sm border-t border-white/10 pt-3">
            <span className="text-slate-300/80">Total (all slots)</span>
            <span className="font-semibold tabular-nums">{totalDataHits}</span>
          </div>

          <p className="mt-3 text-xs text-slate-300/70 leading-relaxed">
            Each slot maintains its own counter + last-hit IST timestamp; response is never rendered.
          </p>
        </section>
      </div>
    </div>
  );
}
