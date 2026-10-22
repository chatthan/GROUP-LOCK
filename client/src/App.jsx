import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import LandingPage from './pages/LandingPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import GroupDetailsPage from './pages/GroupDetailsPage.jsx';
import LiveRidePage from './pages/LiveRidePage.jsx';
import RideHistoryPage from './pages/RideHistoryPage.jsx';
import JoinInvitePage from './pages/JoinInvitePage.jsx';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/join" element={<JoinInvitePage />} />
        <Route path="/join/:code" element={<JoinInvitePage />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/groups/:id" element={<GroupDetailsPage />} />
          <Route path="/groups/:id/history" element={<RideHistoryPage />} />
          <Route path="/rides/:id/live" element={<LiveRidePage />} />
        </Route>
      </Routes>
    </Layout>
  );
}

export default App;
