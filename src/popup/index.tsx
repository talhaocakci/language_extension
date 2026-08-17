import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  DEFAULT_EXPLANATION_LANGUAGE,
  LANGUAGE_OPTIONS,
  normalizeLanguagePreference,
} from '../utils/language-preferences';
import {
  getNetflixAudioExperimentStatus,
  startNetflixAudioExperiment,
  stopNetflixAudioExperiment,
} from '../experiments/netflix-audio/popup-client';
import {
  NETFLIX_AUDIO_EXPERIMENT_ENABLED,
  type NetflixAudioCaptureStatus,
} from '../experiments/netflix-audio/protocol';
import './popup.css';

type AuthState =
  | { loggedIn: false }
  | { loggedIn: true; email: string; name?: string; tokenExpiry: number };

const PopupApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'profile' | 'settings'>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'settings' ? 'settings' : 'profile'
  );
  const [auth, setAuth]             = useState<AuthState | null>(null);
  const [authBusy, setAuthBusy]     = useState(false);
  const [authError, setAuthError]   = useState('');

  const [saveMessage, setSaveMessage] = useState('');
  const [explanationLanguage, setExplanationLanguage] = useState(DEFAULT_EXPLANATION_LANGUAGE);
  const [audioExperimentStatus, setAudioExperimentStatus] = useState<NetflixAudioCaptureStatus | null>(null);
  const [audioExperimentBusy, setAudioExperimentBusy] = useState(false);
  const [audioExperimentMessage, setAudioExperimentMessage] = useState('');

  useEffect(() => { void loadAll(); }, []);
  useEffect(() => {
    void (async () => {
      const queryFocus = new URLSearchParams(window.location.search).get('focus') === 'sentence-audio';
      const stored = await chrome.storage.session.get('sentence_audio_setup_tab_id');
      if (!queryFocus && !stored.sentence_audio_setup_tab_id) return;
      window.setTimeout(() => document.getElementById('sentence-audio-capture')?.scrollIntoView({ block: 'center' }), 120);
    })();
  }, []);

  const loadAll = async () => {
    try {
      const authResp = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
      if (authResp?.success) setAuth(authResp.data);
      const preferencesResp = await chrome.runtime.sendMessage({ type: 'GET_LANGUAGE_PREFERENCES' });
      if (preferencesResp?.success) {
        setExplanationLanguage(normalizeLanguagePreference(
          preferencesResp.data?.explanationLanguage,
          DEFAULT_EXPLANATION_LANGUAGE,
        ));
      }
      if (NETFLIX_AUDIO_EXPERIMENT_ENABLED) {
        setAudioExperimentStatus(await getNetflixAudioExperimentStatus());
      }
    } catch (err) {
      console.error('Failed to load popup state:', err);
    }
  };

  const handleStartAudioExperiment = async () => {
    setAudioExperimentBusy(true);
    setAudioExperimentMessage('Starting tab capture…');
    try {
      const status = await startNetflixAudioExperiment();
      setAudioExperimentStatus(status);
      setAudioExperimentMessage('Ready. Return to the video and press Save sentence again.');
    } catch (err) {
      setAudioExperimentMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAudioExperimentBusy(false);
    }
  };

  const handleStopAudioExperiment = async () => {
    setAudioExperimentBusy(true);
    setAudioExperimentMessage('Stopping…');
    try {
      setAudioExperimentStatus(await stopNetflixAudioExperiment());
      setAudioExperimentMessage('Audio capture stopped. Unsent retry data expires within 24 hours.');
    } catch (err) {
      setAudioExperimentMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAudioExperimentBusy(false);
    }
  };

  const handleExplanationLanguageChange = async (value: string) => {
    const nextLanguage = normalizeLanguagePreference(value, DEFAULT_EXPLANATION_LANGUAGE);
    setExplanationLanguage(nextLanguage);
    setSaveMessage('Saving…');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SET_LANGUAGE_PREFERENCES',
        payload: { explanationLanguage: nextLanguage },
      });
      setSaveMessage(resp?.success ? 'Explanation language updated' : (resp?.error || 'Could not save'));
    } catch (err) {
      setSaveMessage(`Could not save: ${String(err)}`);
    }
    window.setTimeout(() => setSaveMessage(''), 2200);
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
        <h1>GetFluentFast</h1>
        <p className="subtitle">Learn languages from video subtitles</p>
      </header>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'profile' ? 'active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          Profile
        </button>
        <button
          className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      <div className="tabContent">
        {activeTab === 'profile' && (
          <div className="statusTab">
            {/* ── Auth card ─────────────────────────────────────────── */}
            <div className="authCard">
              {auth === null ? (
                <p className="authLoading">Checking login…</p>
              ) : auth.loggedIn ? (
                <div className="authSignedIn">
                  <div className="authInfo">
                    <span className="profileAvatar">
                      {(auth.name || auth.email || '?').trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="profileIdentity">
                      <span className="authBadge">✓ Signed in</span>
                      {auth.name && <span className="profileName">{auth.name}</span>}
                      <span className="authEmail">{auth.email}</span>
                    </div>
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
                    {authBusy ? 'Opening sign-in…' : 'Sign in'}
                  </button>
                  {authError && <p className="authError">{authError}</p>}
                </div>
              )}
            </div>

            <div className="profilePreferences">
              <label htmlFor="explanation-language">Explanation language</label>
              <select
                id="explanation-language"
                value={explanationLanguage}
                onChange={(event) => { void handleExplanationLanguageChange(event.target.value); }}
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <small>Meanings and explanation notes will be written in this language.</small>
              {saveMessage && <div className="saveMessage">{saveMessage}</div>}
            </div>

            {NETFLIX_AUDIO_EXPERIMENT_ENABLED && (
              <div className="audioExperimentCard" id="sentence-audio-capture">
                <div className="audioExperimentHeading">
                  <strong>Sentence audio capture</strong>
                  <span>Netflix / Max</span>
                </div>
                <p>
                  When you press Save sentence, the extension replays that subtitle and records
                  the tab audio. The clip is uploaded to your private Learn List storage. Temporary
                  browser data is deleted after upload and expires after 24 hours if a retry is needed.
                </p>
                <div className={`audioExperimentStatus ${audioExperimentStatus?.active ? 'active' : ''}`}>
                  {audioExperimentStatus?.active
                    ? `● Capture active${audioExperimentStatus.recording ? ' · recording' : ''}`
                    : '○ Capture inactive'}
                </div>
                <div className="audioExperimentActions">
                  {audioExperimentStatus?.active ? (
                    <button
                      type="button"
                      onClick={() => { void handleStopAudioExperiment(); }}
                      disabled={audioExperimentBusy}
                    >
                      Stop capture
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => { void handleStartAudioExperiment(); }}
                      disabled={audioExperimentBusy}
                    >
                      {audioExperimentBusy ? 'Starting…' : 'Enable for active tab'}
                    </button>
                  )}
                </div>
                {audioExperimentMessage && (
                  <small className="audioExperimentMessage">{audioExperimentMessage}</small>
                )}
              </div>
            )}

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
                Just sign in from the Profile tab and the extension handles everything automatically.
              </p>
            </div>
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
