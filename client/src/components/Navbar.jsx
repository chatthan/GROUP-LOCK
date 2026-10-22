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
    <nav className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
      <Link to="/" className="font-bold text-lg tracking-tight">
        GROUP-LOCK
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {isAuthenticated ? (
          <>
            <Link to="/dashboard" className="hover:text-slate-300 flex items-center gap-2">
              <div className="w-7 h-7 rounded-full overflow-hidden border border-red-500 bg-slate-800 flex items-center justify-center">
                {user?.profilePic ? (
                  <img
                    src={user.profilePic}
                    alt={user.name}
                    className="w-full h-full object-cover aspect-square"
                  />
                ) : (
                  <img
                    src="/motorcycle_badge.png"
                    alt="Emblem"
                    className="w-full h-full object-contain p-0.5"
                  />
                )}
              </div>
              <span className="font-medium text-white">{user?.name}</span>
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
