import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './popup.css';

type AuthState =
  | { loggedIn: false }
  | { loggedIn: true; email: string; tokenExpiry: number };

const PopupApp: React.FC = () => {
  const [activeTab, setActiveTab]   = useState<'status' | 'settings'>('status');
  const [auth, setAuth]             = useState<AuthState | null>(null);
  const [authBusy, setAuthBusy]     = useState(false);
  const [authError, setAuthError]   = useState('');

  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => { void loadAll(); }, []);

  const loadAll = async () => {
    try {
      const authResp = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
      if (authResp?.success) setAuth(authResp.data);
    } catch (err) {
      console.error('Failed to load popup state:', err);
    }
  };

  const handleSignIn = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'COGNITO_LOGIN' });
      if (resp?.success) {
        setAuth({ loggedIn: true, email: resp.data.email, tokenExpiry: 0 });
      } else {
        setAuthError(resp?.error || 'Sign-in failed');
      }
    } catch (err) {
      setAuthError(String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      await chrome.runtime.sendMessage({ type: 'COGNITO_LOGOUT' });
      setAuth({ loggedIn: false });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignInAgain = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      await chrome.runtime.sendMessage({ type: 'COGNITO_LOGOUT' });
      const resp = await chrome.runtime.sendMessage({ type: 'COGNITO_LOGIN' });
      if (resp?.success) {
        await loadAll();
      } else {
        setAuthError(resp?.error || 'Sign-in failed');
      }
    } catch (err) {
      setAuthError(String(err));
    } finally {
      setAuthBusy(false);
    }
  };


  const expiryLabel = auth?.loggedIn
    ? new Date(auth.tokenExpiry).toLocaleTimeString()
    : '';

  return (
    <div className="popupApp">
      <header className="popupHeader">
        <h1>📚 Subtitle Learning</h1>
        <p className="subtitle">Learn languages from video subtitles</p>
      </header>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'status' ? 'active' : ''}`}
          onClick={() => setActiveTab('status')}
        >
          Status
        </button>
        <button
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      <div className="tabContent">
        {activeTab === 'status' && (
          <div className="statusTab">
            {/* ── Auth card ─────────────────────────────────────────── */}
            <div className="authCard">
              {auth === null ? (
                <p className="authLoading">Checking login…</p>
              ) : auth.loggedIn ? (
                <div className="authSignedIn">
                  <div className="authInfo">
                    <span className="authBadge">✓ Signed in</span>
                    <span className="authEmail">{auth.email}</span>
                  </div>
                  {auth.tokenExpiry > 0 && (
                    <p className="authExpiry">Token refreshes at {expiryLabel}</p>
                  )}
                  <div className="authActions">
                    <button
                      className="signOutBtn"
                      onClick={handleSignOut}
                      disabled={authBusy}
                    >
                      Sign out
                    </button>
                    <button
                      className="signInBtn signInAgainBtn"
                      onClick={handleSignInAgain}
                      disabled={authBusy}
                    >
                      {authBusy ? 'Working…' : 'Sign in again'}
                    </button>
                  </div>
                  {authError && <p className="authError">{authError}</p>}
                </div>
              ) : (
                <div className="authSignedOut">
                  <p className="authPrompt">Sign in to save phrases to your vocabulary.</p>
                  <button
                    className="signInBtn"
                    onClick={handleSignIn}
                    disabled={authBusy}
                  >
                    {authBusy ? 'Opening login…' : 'Sign in with Cognito'}
                  </button>
                  {authError && <p className="authError">{authError}</p>}
                </div>
              )}
            </div>

            <div className="statusItem">
              <h3>Getting Started</h3>
              <ol className="stepsList">
                <li>Sign in above to enable phrase saving</li>
                <li>Play a video on YouTube or Netflix</li>
                <li>Click the 📚 button in the player</li>
                <li>Select a sentence, then click Explain</li>
                <li>Save idioms and phrases with the + button</li>
              </ol>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="settingsTab">
            <div className="settingGroup">
              <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.85)', lineHeight: 1.6 }}>
                AI analysis is powered by the backend — no API keys needed here.
                Just sign in from the Status tab and the extension handles everything automatically.
              </p>
            </div>
            {saveMessage && <div className="saveMessage">{saveMessage}</div>}
          </div>
        )}
      </div>
    </div>
  );
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('root');
    if (root) ReactDOM.createRoot(root).render(<PopupApp />);
  });
} else {
  const root = document.getElementById('root');
  if (root) ReactDOM.createRoot(root).render(<PopupApp />);
}
