import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <nav className="bg-slate-900 text-white px-4 sm:px-6 py-3 sm:py-3.5 flex items-center justify-between border-b border-slate-800 shadow-md">
      <Link to="/" className="flex items-center gap-2.5 group">
        <img
          src="/grouplock_logo.png"
          alt="GroupLock Logo"
          className="w-9 h-9 sm:w-10 sm:h-10 object-contain drop-shadow group-hover:scale-105 transition-transform"
        />
        <div className="flex flex-col leading-none">
          <span className="font-black text-lg tracking-wider bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-400 bg-clip-text text-transparent">
            GROUP-LOCK
          </span>
          <span className="text-[9px] uppercase tracking-widest text-amber-400 font-extrabold hidden sm:block">
            Ride Together
          </span>
        </div>
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {isAuthenticated ? (
          <>
            <Link to="/dashboard" className="hover:text-slate-300 flex items-center gap-2">
              <div className="w-8 h-8 rounded-full overflow-hidden border-2 border-cyan-500/60 bg-slate-800 flex items-center justify-center shadow-sm">
                {user?.profilePic ? (
                  <img
                    src={user.profilePic}
                    alt={user.name}
                    className="w-full h-full object-cover aspect-square"
                  />
                ) : (
                  <img
                    src="/grouplock_logo.png"
                    alt="Emblem"
                    className="w-full h-full object-contain p-0.5"
                  />
                )}
              </div>
              <span className="font-semibold text-white">{user?.name}</span>
            </Link>
            <button onClick={handleLogout} className="text-slate-400 hover:text-white transition-colors">
              Logout
            </button>
          </>
        ) : (
          <>
            <Link to="/login" className="hover:text-slate-300">
              Login
            </Link>
            <Link to="/register" className="hover:text-slate-300">
              Register
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}

export default Navbar;
