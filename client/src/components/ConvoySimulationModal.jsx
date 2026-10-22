import { useState, useEffect } from 'react';
import {
  startSimulation,
  triggerScenario,
  stopSimulation,
  getSimulationStatus,
} from '../services/simulation.service';

export default function ConvoySimulationModal({
  isOpen,
  onClose,
  rideId,
  token,
  addToast,
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeScenario, setActiveScenario] = useState(null);
  const [simRiders, setSimRiders] = useState([]);
  const [uptimeSeconds, setUptimeSeconds] = useState(0);

  // Poll simulation status while open
  useEffect(() => {
    if (!isOpen || !rideId) return;

    let isMounted = true;
    async function checkStatus() {
      try {
        const res = await getSimulationStatus(rideId, token);
        if (isMounted && res) {
          setIsRunning(Boolean(res.isRunning));
          setSimRiders(res.riders || []);
          setUptimeSeconds(res.uptimeSeconds || 0);
        }
      } catch (_) {}
    }

    checkStatus();
    const interval = setInterval(checkStatus, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen, rideId, token]);

  if (!isOpen) return null;

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await startSimulation(rideId, token);
      if (res?.success) {
        setIsRunning(true);
        addToast({
          type: 'success',
          title: '🎮 Simulation Started',
          message: 'Spawned virtual convoy riders on map.',
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Simulation Error',
        message: err.message || 'Could not start simulation.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await stopSimulation(rideId, token);
      if (res?.success) {
        setIsRunning(false);
        setActiveScenario(null);
        setSimRiders([]);
        addToast({
          type: 'info',
          title: 'Simulation Stopped',
          message: 'All virtual riders disconnected.',
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Stop Error',
        message: err.message || 'Could not stop simulation.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTrigger = async (scenario, label) => {
    setLoading(true);
    setActiveScenario(scenario);
    try {
      const res = await triggerScenario(rideId, scenario, token);
      if (res?.success) {
        addToast({
          type: 'warning',
          title: `Triggered: ${label}`,
          message: res.message || `Scenario ${scenario} active.`,
        });
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Trigger Failed',
        message: err.message || 'Failed to trigger scenario.',
      });
    } finally {
      setLoading(false);
      setTimeout(() => setActiveScenario(null), 4000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-slate-900 border border-cyan-500/80 rounded-2xl max-w-lg w-full p-4 sm:p-5 text-white shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90dvh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 flex items-center justify-center text-xl font-bold">
              🎮
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm sm:text-base font-bold text-cyan-300">
                  Convoy Simulation Lab
                </h3>
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded-full font-extrabold uppercase border ${
                    isRunning
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-500 animate-pulse'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {isRunning ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Stage 11: Real-time multi-rider stress test & scenario rig
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 text-sm transition"
          >
            ✕
          </button>
        </div>

        {/* Status Card */}
        <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">Virtual Riders Connected:</div>
            <div className="text-base font-extrabold text-white flex items-center gap-1.5 mt-0.5">
              <span>🏍️</span>
              <span>{simRiders.length > 0 ? `${simRiders.length} Bikes Active` : '0 Virtual Bikes'}</span>
            </div>
          </div>
          {isRunning ? (
            <button
              type="button"
              disabled={loading}
              onClick={handleStop}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-red-900/30"
            >
              🛑 Stop Simulation
            </button>
          ) : (
            <button
              type="button"
              disabled={loading}
              onClick={handleStart}
              className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-cyan-900/30"
            >
              🚀 Launch Convoy (4 Riders)
            </button>
          )}
        </div>

        {/* Virtual Roster */}
        {simRiders.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
              Convoy Formation & Telemetry:
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {simRiders.map((r, idx) => (
                <div
                  key={idx}
                  className="bg-slate-800/80 border border-slate-700/80 rounded-xl p-2 flex items-center justify-between"
                >
                  <div className="min-w-0">
                    <div className="font-bold text-slate-200 truncate">{r.name}</div>
                    <div className="text-[10px] text-slate-400 font-medium">
                      {r.role} · {r.speed} km/h
                    </div>
                  </div>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                      r.isDeadZone
                        ? 'bg-purple-900/80 text-purple-200'
                        : 'bg-emerald-900/80 text-emerald-200'
                    }`}
                  >
                    {r.isDeadZone ? 'DEAD-ZONE' : 'LIVE'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scenario Injection Battery */}
        <div>
          <label className="block text-xs text-slate-300 mb-2 font-bold uppercase tracking-wider">
            1-Tap Scenario Injections:
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              {
                id: 'OVERSPEED',
                label: 'Overspeed Violation',
                icon: '⚡',
                desc: 'Accelerates pack rider to 108 km/h. Tests overspeed banner & kick prompt.',
                color: 'amber',
              },
              {
                id: 'STRAGGLER',
                label: 'Straggler Separation',
                icon: '⚠️',
                desc: 'Decelerates Dev to 8 km/h. Tests > 2km spread & Regroup recommendation.',
                color: 'orange',
              },
              {
                id: 'DEAD_ZONE',
                label: 'Dead-Zone Reconcile',
                icon: '📵',
                desc: 'Drops rider offline for 8s, buffers 5 fixes, tests batch replay trail.',
                color: 'purple',
              },
              {
                id: 'ROAD_HAZARD',
                label: 'Pothole Hazard Ahead',
                icon: '🚧',
                desc: 'Drops a road hazard 250m ahead. Tests TTS voice alert & Still There confirm.',
                color: 'blue',
              },
              {
                id: 'EMERGENCY_SOS',
                label: 'Emergency SOS Alert',
                icon: '🚨',
                desc: 'Fires critical SOS from Dev. Tests siren, red banner & ICE escalation.',
                color: 'red',
              },
            ].map((sc) => {
              const isSelected = activeScenario === sc.id;
              return (
                <button
                  key={sc.id}
                  type="button"
                  disabled={!isRunning || loading}
                  onClick={() => handleTrigger(sc.id, sc.label)}
                  className={`p-2.5 rounded-xl border text-left transition flex flex-col justify-between gap-1 ${
                    !isRunning
                      ? 'opacity-40 cursor-not-allowed bg-slate-800/40 border-slate-800'
                      : isSelected
                      ? 'bg-cyan-600/30 border-cyan-400 ring-2 ring-cyan-500/50'
                      : 'bg-slate-800/80 border-slate-700/80 hover:bg-slate-800 hover:border-slate-600 active:scale-95'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{sc.icon}</span>
                    <span className="text-xs font-bold text-white">{sc.label}</span>
                  </div>
                  <p className="text-[10px] text-slate-400 line-clamp-2">{sc.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 pt-3 flex items-center justify-between text-xs text-slate-400">
          <span>Uptime: {Math.floor(uptimeSeconds / 60)}m {uptimeSeconds % 60}s</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-semibold transition"
          >
            Close Panel
          </button>
        </div>
      </div>
    </div>
  );
}
