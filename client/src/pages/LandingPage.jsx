import { Link } from 'react-router-dom';

const features = [
  {
    icon: '📍',
    title: 'Live GPS Convoy Tracking',
    desc: 'See every rider on a real-time map. Stay together, never lose the pack.',
  },
  {
    icon: '💬',
    title: 'In-Ride Team Chat',
    desc: 'Coordinate on the fly with instant group messaging during every ride.',
  },
  {
    icon: '🚨',
    title: 'Emergency SOS',
    desc: 'One-tap SOS broadcasts your location to every convoy member instantly.',
  },
  {
    icon: '👥',
    title: 'Group Management',
    desc: 'Create groups, share invite codes, assign admins, and plan rides together.',
  },
];

function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center">
        <div className="mb-6 flex items-center justify-center">
          <img
            src="/grouplock_logo.png"
            alt="GroupLock Mascot Logo"
            className="w-48 h-56 sm:w-56 sm:h-64 object-contain drop-shadow-[0_15px_30px_rgba(6,182,212,0.4)] hover:scale-105 transition-transform duration-300"
          />
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-white mb-2">
          GROUP<span className="text-cyan-400">-LOCK</span>
        </h1>
        <p className="text-xs uppercase tracking-widest text-amber-400 font-extrabold mb-4">
          Ride Together • Stay Together
        </p>
        <p className="text-base sm:text-xl text-slate-300 max-w-xl mb-8 leading-relaxed">
          Intelligent group motorcycle ride safety, live GPS convoy tracking, and PRIMUS AI voice companion.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            to="/register"
            className="px-8 py-3 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-xl shadow-lg transition text-base"
          >
            Get Started — Register
          </Link>
          <Link
            to="/login"
            className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-xl border border-slate-600 shadow transition text-base"
          >
            Log In
          </Link>
        </div>
      </section>

      {/* Feature Cards */}
      <section className="px-4 pb-20">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-center text-sm uppercase tracking-widest text-emerald-400 font-semibold mb-8">
            Everything your convoy needs
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {features.map((f) => (
              <div
                key={f.title}
                className="bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-md flex gap-4 items-start hover:border-emerald-500 transition"
              >
                <span className="text-3xl mt-0.5 shrink-0">{f.icon}</span>
                <div>
                  <h3 className="text-base font-bold text-white mb-1">{f.title}</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-xs text-slate-600 pb-6">
        © {new Date().getFullYear()} Group-Lock · Ride safe, ride together 🏍️
      </footer>
    </div>
  );
}

export default LandingPage;
