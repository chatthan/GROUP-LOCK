import Navbar from './Navbar.jsx';

function Layout({ children }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Navbar />
      <main className="max-w-4xl mx-auto px-6 py-10">{children}</main>
    </div>
  );
}

export default Layout;
