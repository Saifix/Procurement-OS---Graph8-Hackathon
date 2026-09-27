import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Avatar } from './ui.jsx';
import { G8Mark, ProductMark } from './Brand.jsx';

/** Navigation is role-aware: each role sees the pages it is responsible for,
    which is what makes the four-role story legible rather than one giant menu. */
const NAV = [
  { to: '/dashboard', label: 'Dashboard', roles: ['head', 'officer', 'planner', 'requester'] },
  { to: '/ask', label: 'Copilot', roles: ['requester', 'planner', 'officer', 'head'] },
  { to: '/raise', label: 'Raise manually', roles: ['requester', 'planner', 'officer', 'head'] },
  { to: '/requirements', label: 'Requirements', roles: ['officer', 'head', 'requester', 'planner'], countKey: 'open' },
  { to: '/inventory', label: 'Inventory & planning', roles: ['planner', 'officer', 'head'], countKey: 'shortages' },
  { to: '/analytics', label: 'Forward buying', roles: ['planner', 'officer', 'head'] },
  { to: '/suppliers', label: 'Suppliers', roles: ['officer', 'head'] },
  { to: '/sales', label: 'Sell our products', roles: ['officer', 'head', 'requester', 'planner'] },
  { to: '/agents', label: 'Agent activity', roles: ['officer', 'head', 'planner', 'requester'] },
];

export default function Shell({ role, roles, onSwitchRole, children }) {
  const location = useLocation();
  const [counts, setCounts] = useState({});

  useEffect(() => {
    let alive = true;
    api.dashboard().then((d) => alive && setCounts(d.counts || {})).catch(() => {});
    return () => { alive = false; };
  }, [location.pathname]);

  const me = roles?.find((r) => r.id === role);
  const visible = NAV.filter((n) => n.roles.includes(role));
  const current = [...visible].reverse().find((n) => location.pathname.startsWith(n.to));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <G8Mark size={28} />
          <div>
            <div className="brand-name"><ProductMark /></div>
            <div className="brand-sub">Powered by graph8</div>
          </div>
        </div>
        <div className="brand-rule" />

        <div className="role-switch">
          <span className="role-switch-label">Signed in as</span>
          <div className="row" style={{ gap: 9 }}>
            <Avatar name={me?.name} />
            <div style={{ minWidth: 0 }}>
              <div className="role-name">{me?.name}</div>
              <div className="role-title">{me?.label}</div>
            </div>
          </div>
          <select className="select" value={role} onChange={(e) => onSwitchRole(e.target.value)} aria-label="Switch role">
            {roles?.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>

        <nav className="nav">
          <div className="nav-group">Workflow</div>
          {visible.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              {item.label}
              {item.countKey && counts[item.countKey] > 0 && <span className="nav-count">{counts[item.countKey]}</span>}
            </NavLink>
          ))}
        </nav>

        <div style={{ marginTop: 'auto' }}>
          <div className="divider" />
          <p className="xs dim" style={{ lineHeight: 1.5 }}>
            Fictionalised demo workspace. Not connected to Nestlé systems. Inventory, recipes and prices
            are illustrative.
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="topbar-title">{current?.label || 'Procurement OS'}</div>
            <div className="topbar-sub">{me?.title}</div>
          </div>
          <div className="row" style={{ gap: 7 }}>
            <span className="prov prov-live">graph8 live</span>
            <span className="prov prov-derived">calculated</span>
            <span className="prov prov-demo">illustrative</span>
            <span className="topbar-brand">
              <G8Mark size={17} />
              <span>graph8</span>
            </span>
          </div>
        </header>

        <div className="content">
          <AnimatePresence mode="wait">
            <motion.div className="route-frame" key={location.pathname}>{children}</motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
