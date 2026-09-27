import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './lib/api.js';
import Shell from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Ask from './pages/Ask.jsx';
import RaiseRequirement from './pages/RaiseRequirement.jsx';
import Requirements from './pages/Requirements.jsx';
import RequirementDetail from './pages/RequirementDetail.jsx';
import Inventory from './pages/Inventory.jsx';
import Analytics from './pages/Analytics.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Sales from './pages/Sales.jsx';
import AgentCenter from './pages/AgentCenter.jsx';

const KEY = 'procos.role';

export default function App() {
  const [workspace, setWorkspace] = useState(null);
  const [role, setRole] = useState(() => sessionStorage.getItem(KEY) || null);
  const navigate = useNavigate();

  useEffect(() => { api.workspace().then(setWorkspace).catch(() => {}); }, []);

  const signIn = (roleId) => {
    try { sessionStorage.setItem(KEY, roleId); } catch { /* private mode */ }
    setRole(roleId);
    navigate(roleId === 'requester' ? '/ask' : roleId === 'planner' ? '/inventory' : '/dashboard');
  };

  const switchRole = (roleId) => {
    try { sessionStorage.setItem(KEY, roleId); } catch { /* ignore */ }
    setRole(roleId);
  };

  if (!workspace) return <div className="login-wrap"><div className="faint">Loading workspace…</div></div>;
  if (!role) return <Login workspace={workspace} onSignIn={signIn} />;

  return (
    <Shell role={role} roles={workspace.roles} onSwitchRole={switchRole}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard role={role} workspace={workspace} />} />
        <Route path="/ask" element={<Ask role={role} workspace={workspace} />} />
        <Route path="/raise" element={<RaiseRequirement role={role} workspace={workspace} />} />
        <Route path="/requirements" element={<Requirements workspace={workspace} />} />
        <Route path="/requirements/:id" element={<RequirementDetail role={role} workspace={workspace} />} />
        <Route path="/inventory" element={<Inventory workspace={workspace} />} />
        <Route path="/analytics" element={<Analytics workspace={workspace} />} />
        <Route path="/suppliers" element={<Suppliers workspace={workspace} />} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/agents" element={<AgentCenter />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Shell>
  );
}
