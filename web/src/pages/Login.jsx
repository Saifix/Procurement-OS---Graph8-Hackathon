import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Card, Callout } from '../components/ui.jsx';
import { G8Mark, ProductMark } from '../components/Brand.jsx';

export default function Login({ workspace, onSignIn }) {
  const [sel, setSel] = useState('requester');

  return (
    <div className="login-wrap">
      <motion.div className="login-card"
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: .5, ease: [0.16, 1, 0.3, 1] }}>

        <motion.div className="login-lockup"
          initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
          transition={{ delay: .08, duration: .5, ease: [0.16, 1, 0.3, 1] }}>
          <G8Mark size={34} />
          <span className="login-wordmark">graph8</span>
        </motion.div>
        <div className="login-rule" />

        <div style={{ marginBottom: 26 }}>
          <h1 className="login-title"><ProductMark /></h1>
          <p className="login-powered">Powered by graph8</p>
          <p className="login-tagline">Smarter sourcing. Stronger supply chains. Greater impact.</p>
          <p className="xs faint" style={{ marginTop: 12 }}>{workspace.meta.workspaceName}</p>
        </div>

        <Card large>
          <div className="col" style={{ gap: 16 }}>
            <div>
              <div className="label" style={{ marginBottom: 9 }}>Continue as</div>
              <div className="col" style={{ gap: 8 }}>
                {workspace.roles.map((r) => (
                  <button key={r.id}
                    className={`role-card ${sel === r.id ? 'sel' : ''}`}
                    onClick={() => setSel(r.id)}
                    aria-pressed={sel === r.id}>
                    <div className="row-between">
                      <span className="strong" style={{ fontSize: 13.5 }}>{r.label}</span>
                      <span className="xs faint">{r.name}</span>
                    </div>
                    <div className="xs faint" style={{ marginTop: 3, lineHeight: 1.45 }}>{r.responsibilities}</div>
                  </button>
                ))}
              </div>
            </div>

            <motion.button className="btn btn-primary btn-lg" style={{ width: '100%' }}
              onClick={() => onSignIn(sel)}
              whileHover={{ scale: 1.008 }} whileTap={{ scale: .99 }}>
              Enter workspace
            </motion.button>

            <Callout tone="amber" icon="⚠">
              {workspace.meta.disclaimer}
            </Callout>
          </div>
        </Card>

        <p className="xs dim" style={{ textAlign: 'center', marginTop: 18 }}>
          Supplier discovery powered by graph8 · {workspace.graph8Meta.org}
        </p>
      </motion.div>
    </div>
  );
}
