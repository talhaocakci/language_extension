// The single pause/resume around accepting transcription: when the learner
// accepts while the video plays, it is paused once and resumed on the first
// change to 'ready' — unless the learner pressed play or pause in between.
// Feed it the video's play/pause events; it says when to pause and resume.

export class AcceptPauseTracker {
  private pausedOnce = false;
  private neverPauseAgain = false;
  private waitingForReady = false;
  private ownPausePending = false;

  reset(): void {
    this.pausedOnce = false;
    this.neverPauseAgain = false;
    this.waitingForReady = false;
    this.ownPausePending = false;
  }

  /** Returns true when the caller should pause the video now. */
  onAccept(isPlaying: boolean, autoAccepted: boolean): boolean {
    if (!isPlaying || autoAccepted || this.pausedOnce || this.neverPauseAgain) return false;
    this.pausedOnce = true;
    this.waitingForReady = true;
    this.ownPausePending = true;
    return true;
  }

  onPauseEvent(): void {
    if (this.ownPausePending) {
      this.ownPausePending = false; // the pause we asked for
      return;
    }
    this.waitingForReady = false;
  }

  onPlayEvent(): void {
    if (!this.waitingForReady) return;
    this.waitingForReady = false;
    this.ownPausePending = false;
    this.neverPauseAgain = true;
  }

  /** Returns true when the caller should resume playback now. */
  onPhase(phase: string): boolean {
    if (phase !== 'ready' || !this.waitingForReady) return false;
    this.waitingForReady = false;
    return true;
  }
}
