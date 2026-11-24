// The single pause/resume around accepting transcription: when the learner
// accepts while the video plays, it is paused once and resumed when the phase
// leaves 'preparing' (for ready, unavailable, no_credits or signed_out) —
// unless the learner pressed play or pause in between. If the phase is still
// 'preparing' ACCEPT_PAUSE_MAX_MS after our pause, it is resumed anyway (once).
// Feed it the video's play/pause events; it says when to pause and resume.

/** How long the pause event for our own pause() may take to arrive before a pause counts as the learner's. */
export const OWN_PAUSE_EVENT_MS = 1000;
/** Longest the accept-pause lasts while subtitles are still being prepared. */
export const ACCEPT_PAUSE_MAX_MS = 30_000;

const RESUME_PHASES = new Set(['ready', 'unavailable', 'no_credits', 'signed_out']);

export class AcceptPauseTracker {
  private pausedOnce = false;
  private neverPauseAgain = false;
  private waitingForResume = false;
  private ownPauseAt: number | null = null;
  private pausedAt = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  reset(): void {
    this.pausedOnce = false;
    this.neverPauseAgain = false;
    this.waitingForResume = false;
    this.ownPauseAt = null;
    this.pausedAt = 0;
  }

  /** Returns true when the caller should pause the video now. */
  onAccept(isPlaying: boolean, autoAccepted: boolean): boolean {
    if (!isPlaying || autoAccepted || this.pausedOnce || this.neverPauseAgain) return false;
    this.pausedOnce = true;
    this.waitingForResume = true;
    this.ownPauseAt = this.now();
    this.pausedAt = this.ownPauseAt;
    return true;
  }

  onPauseEvent(): void {
    const own = this.ownPauseAt !== null && this.now() - this.ownPauseAt <= OWN_PAUSE_EVENT_MS;
    this.ownPauseAt = null;
    if (own) return; // the pause we asked for
    this.waitingForResume = false;
  }

  onPlayEvent(): void {
    this.ownPauseAt = null; // a missed pause event for our pause can no longer arrive as ours
    if (!this.waitingForResume) return;
    this.waitingForResume = false;
    this.neverPauseAgain = true;
  }

  /** Returns true when the caller should resume playback now. */
  onPhase(phase: string): boolean {
    if (!this.waitingForResume || !RESUME_PHASES.has(phase)) return false;
    this.waitingForResume = false;
    return true;
  }

  /**
   * Polled regularly: true once when the phase is still 'preparing' ACCEPT_PAUSE_MAX_MS after our pause
   * and the learner has not pressed play or pause since. The caller resumes; nothing pauses again.
   */
  onPoll(phase: string): boolean {
    if (!this.waitingForResume || phase !== 'preparing') return false;
    if (this.now() - this.pausedAt < ACCEPT_PAUSE_MAX_MS) return false;
    this.waitingForResume = false;
    this.neverPauseAgain = true;
    return true;
  }
}
