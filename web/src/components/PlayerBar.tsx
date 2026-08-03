import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { Artwork } from './Artwork';
import { Icon } from './Icon';
import { playerStore, usePlayer, type PlayerStore } from '../player';
import styles from './PlayerBar.module.css';

const MOBILE_PLAYER_QUERY = '(max-width: 767px)';
const VERTICAL_GESTURE_THRESHOLD = 48;
const HORIZONTAL_GESTURE_THRESHOLD = 56;
const GESTURE_AXIS_RATIO = 1.15;

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

/** Prevents playback shortcuts from intercepting typing and native range-input keys. */
const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  );
};

const readMobileViewport = () => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(MOBILE_PLAYER_QUERY).matches;
  return window.innerWidth <= 767;
};

const onNextFrame = (callback: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 0);
};

/** Tracks the presentation breakpoint without coupling player state to the current route. */
const useMobileViewport = () => {
  const [mobile, setMobile] = useState(readMobileViewport);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    if (typeof window.matchMedia === 'function') {
      const query = window.matchMedia(MOBILE_PLAYER_QUERY);
      const update = () => setMobile(query.matches);
      update();
      query.addEventListener?.('change', update);
      return () => query.removeEventListener?.('change', update);
    }

    const update = () => setMobile(readMobileViewport());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return mobile;
};

const trapDialogFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hasAttribute('hidden'));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

interface PlayerBarProps {
  /** Tests may inject a store; the application always uses the one shared browser store. */
  store?: PlayerStore;
}

/** Presents compact, expanded, and keyboard surfaces over one route-independent player store. */
export const PlayerBar = ({ store = playerStore }: PlayerBarProps) => {
  const player = usePlayer(store);
  const current = player.currentItem;
  const playing = player.status === 'playing';
  const mobile = useMobileViewport();
  const [expanded, setExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const gestureStart = useRef<{ x: number; y: number } | null>(null);
  const suppressNextOpen = useRef(false);
  const compactOpenButton = useRef<HTMLButtonElement>(null);
  const expandedCloseButton = useRef<HTMLButtonElement>(null);
  const helpCloseButton = useRef<HTMLButtonElement>(null);
  const helpReturnFocus = useRef<HTMLElement | null>(null);

  const openExpanded = () => {
    if (mobile && current) setExpanded(true);
  };

  const closeExpanded = (restoreFocus = true) => {
    setExpanded(false);
    if (restoreFocus) onNextFrame(() => compactOpenButton.current?.focus());
  };

  const openHelp = () => {
    helpReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setHelpOpen(true);
  };

  const closeHelp = () => {
    setHelpOpen(false);
    onNextFrame(() => helpReturnFocus.current?.focus());
  };

  const suppressGestureClick = () => {
    suppressNextOpen.current = true;
    setTimeout(() => { suppressNextOpen.current = false; }, 0);
  };

  useEffect(() => {
    if (!mobile && expanded) setExpanded(false);
  }, [expanded, mobile]);

  useEffect(() => {
    if (expanded) expandedCloseButton.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (helpOpen) helpCloseButton.current?.focus();
  }, [helpOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        if (helpOpen) {
          event.preventDefault();
          closeHelp();
        } else if (expanded) {
          event.preventDefault();
          closeExpanded();
        }
        return;
      }

      if (isEditableTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;

      if (!current || event.repeat) return;

      switch (event.key) {
        case ' ':
          if (event.target instanceof HTMLElement
            && event.target.closest('button, a, [role="button"]')) return;
          event.preventDefault();
          if (playing) store.pause();
          else void store.play();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          store.skipBackward();
          break;
        case 'ArrowRight':
          event.preventDefault();
          store.skipForward();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [current, expanded, helpOpen, playing, store]);

  const startCompactGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (!mobile || !current || event.currentTarget !== event.target
      && (event.target as HTMLElement).closest('[data-player-control]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    gestureStart.current = { x: event.clientX, y: event.clientY };
  };

  const finishCompactGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const start = gestureStart.current;
    gestureStart.current = null;
    if (!start || !mobile || !current) return;

    const horizontalDelta = event.clientX - start.x;
    const verticalDelta = event.clientY - start.y;
    const horizontalDistance = Math.abs(horizontalDelta);
    const verticalDistance = Math.abs(verticalDelta);

    if (verticalDelta < 0
      && verticalDistance >= VERTICAL_GESTURE_THRESHOLD
      && verticalDistance > horizontalDistance * GESTURE_AXIS_RATIO) {
      suppressGestureClick();
      openExpanded();
      return;
    }

    if (horizontalDistance >= HORIZONTAL_GESTURE_THRESHOLD
      && horizontalDistance > verticalDistance * GESTURE_AXIS_RATIO) {
      suppressGestureClick();
      if (horizontalDelta < 0) void store.next();
      else void store.previous();
    }
  };

  const compactIdentity = (
    <>
      {current ? (
        <Artwork
          alt=""
          className={styles.artwork}
          kind="audioTrack"
          sizes="(max-width: 767px) 2.55rem, 3.4rem"
          src={current.artworkUrl}
        />
      ) : (
        <span className={styles.artworkFallback} aria-hidden="true">F</span>
      )}
      <span className={styles.copy}>
        <span className={styles.title}>{current?.title || 'Nothing playing'}</span>
        <span className={styles.meta}>
          {current?.artistNames.join(', ') || (current ? 'Finitude soundtrack' : 'Choose something that fits the moment')}
        </span>
        {player.error && <span className={styles.error} role="alert">{player.error.message}</span>}
      </span>
    </>
  );

  return (
    <>
      <section
        aria-hidden={helpOpen || (mobile && expanded) || undefined}
        className={styles.player}
        aria-label="Now playing"
        onPointerCancel={() => { gestureStart.current = null; }}
        onPointerDown={startCompactGesture}
        onPointerUp={finishCompactGesture}
      >
        {mobile ? (
          <button
            aria-expanded={expanded}
            aria-haspopup="dialog"
            aria-label={current ? `Open Now Playing: ${current.title}` : 'Nothing playing'}
            className={`${styles.identity} ${styles.mobileIdentityButton}`}
            disabled={!current}
            onClick={() => {
              if (suppressNextOpen.current) {
                suppressNextOpen.current = false;
                return;
              }
              openExpanded();
            }}
            ref={compactOpenButton}
            type="button"
          >
            {compactIdentity}
          </button>
        ) : (
          <div className={styles.identity}>{compactIdentity}</div>
        )}

        <div className={styles.transport} role="group" aria-label="Playback controls">
          <div className={styles.transportButtons}>
            <button
              className={styles.secondaryControl}
              data-player-control
              type="button"
              aria-label="Previous soundtrack"
              disabled={!player.canPrevious}
              onClick={() => { void store.previous(); }}
            >
              <Icon name="previous" />
            </button>
            <button
              className={styles.control}
              data-player-control
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!current}
              onClick={() => playing ? store.pause() : void store.play()}
            >
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button
              className={styles.secondaryControl}
              data-player-control
              type="button"
              aria-label="Next soundtrack"
              disabled={!player.canNext}
              onClick={() => { void store.next(); }}
            >
              <Icon name="next" />
            </button>
          </div>
          <div className={styles.timeline}>
            <span className={styles.time}>{formatTime(player.currentTime)}</span>
            <input
              aria-label="Playback position"
              className={styles.progress}
              disabled={!current || player.duration <= 0}
              max={Math.max(player.duration, 0)}
              min="0"
              onChange={(event) => store.seek(Number(event.currentTarget.value))}
              step="0.1"
              type="range"
              value={Math.min(player.currentTime, Math.max(player.duration, 0))}
            />
            <span className={styles.time}>{formatTime(player.duration)}</span>
          </div>
        </div>

        <div className={styles.volume}>
          <button
            aria-label="Keyboard shortcuts"
            className={styles.helpButton}
            onClick={openHelp}
            title="Keyboard shortcuts (?)"
            type="button"
          >
            <span aria-hidden="true">?</span>
          </button>
          <button
            aria-label={player.muted ? 'Unmute' : 'Mute'}
            className={styles.volumeButton}
            disabled={!current}
            onClick={() => store.toggleMute()}
            type="button"
          >
            <Icon name={player.muted ? 'volume-off' : 'volume'} />
          </button>
          <input
            aria-label="Volume"
            disabled={!current}
            max="1"
            min="0"
            onChange={(event) => store.setVolume(Number(event.currentTarget.value))}
            step="0.01"
            type="range"
            value={player.volume}
          />
        </div>

        {mobile && current && player.duration > 0 && (
          <progress
            aria-hidden="true"
            className={styles.miniProgress}
            max={player.duration}
            value={Math.min(player.currentTime, player.duration)}
          />
        )}
      </section>

      {mobile && expanded && current && (
        <section
          aria-hidden={helpOpen || undefined}
          aria-labelledby="expanded-player-heading"
          aria-modal="true"
          className={styles.expandedPlayer}
          onKeyDown={trapDialogFocus}
          role="dialog"
        >
          <header className={styles.expandedHeader}>
            <button
              aria-label="Close expanded player"
              className={styles.expandedHeaderButton}
              onClick={() => closeExpanded()}
              ref={expandedCloseButton}
              type="button"
            >
              <span aria-hidden="true">⌄</span>
            </button>
            <div>
              <p className={styles.expandedEyebrow}>Now Playing</p>
              <h2 id="expanded-player-heading">{current.title}</h2>
            </div>
            <button
              aria-label="Keyboard shortcuts"
              className={styles.expandedHeaderButton}
              onClick={openHelp}
              title="Keyboard shortcuts (?)"
              type="button"
            >
              <span aria-hidden="true">?</span>
            </button>
          </header>

          <div className={styles.expandedBody}>
            <Artwork
              alt={`${current.title} cover`}
              className={styles.expandedArtwork}
              kind="audioTrack"
              loading="eager"
              sizes="(max-width: 767px) and (orientation: landscape) and (max-height: 500px) min(32vh, 14rem), min(72vw, 22rem)"
              src={current.artworkUrl}
            />

            <div className={styles.expandedIdentity}>
              <p className={styles.expandedTitle}>{current.title}</p>
              <p className={styles.expandedArtist}>
                {current.artistNames.join(', ') || 'Finitude soundtrack'}
              </p>
            </div>

            <div className={styles.expandedTimeline}>
              <input
                aria-label="Playback position"
                disabled={player.duration <= 0}
                max={Math.max(player.duration, 0)}
                min="0"
                onChange={(event) => store.seek(Number(event.currentTarget.value))}
                step="0.1"
                type="range"
                value={Math.min(player.currentTime, Math.max(player.duration, 0))}
              />
              <div className={styles.expandedTimes}>
                <span>{formatTime(player.currentTime)}</span>
                <span>−{formatTime(Math.max(0, player.duration - player.currentTime))}</span>
              </div>
            </div>

            <div className={styles.expandedTransport} role="group" aria-label="Expanded playback controls">
              <button
                aria-label="Previous soundtrack"
                disabled={!player.canPrevious}
                onClick={() => { void store.previous(); }}
                type="button"
              >
                <Icon name="previous" />
              </button>
              <button aria-label="Skip backward 10 seconds" onClick={() => store.skipBackward()} type="button">
                <span aria-hidden="true">−10</span>
              </button>
              <button
                aria-label={playing ? 'Pause' : 'Play'}
                className={styles.expandedPlay}
                onClick={() => playing ? store.pause() : void store.play()}
                type="button"
              >
                <Icon name={playing ? 'pause' : 'play'} />
              </button>
              <button aria-label="Skip forward 10 seconds" onClick={() => store.skipForward()} type="button">
                <span aria-hidden="true">+10</span>
              </button>
              <button
                aria-label="Next soundtrack"
                disabled={!player.canNext}
                onClick={() => { void store.next(); }}
                type="button"
              >
                <Icon name="next" />
              </button>
            </div>

            <div className={styles.expandedVolume}>
              <button
                aria-label={player.muted ? 'Unmute' : 'Mute'}
                onClick={() => store.toggleMute()}
                type="button"
              >
                <Icon name={player.muted ? 'volume-off' : 'volume'} />
              </button>
              <input
                aria-label="Volume"
                max="1"
                min="0"
                onChange={(event) => store.setVolume(Number(event.currentTarget.value))}
                step="0.01"
                type="range"
                value={player.volume}
              />
            </div>

            {player.error && <p className={styles.expandedError} role="alert">{player.error.message}</p>}
          </div>
        </section>
      )}

      {helpOpen && (
        <div className={styles.helpBackdrop} onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeHelp();
        }}>
          <section
            aria-labelledby="player-shortcuts-heading"
            aria-modal="true"
            className={styles.helpDialog}
            onKeyDown={trapDialogFocus}
            role="dialog"
          >
            <div className={styles.helpHeader}>
              <div>
                <p className={styles.expandedEyebrow}>Player help</p>
                <h2 id="player-shortcuts-heading">Keyboard shortcuts</h2>
              </div>
              <button aria-label="Close keyboard shortcuts" onClick={closeHelp} ref={helpCloseButton} type="button">
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <p className={styles.helpIntro}>Shortcuts work anywhere except while typing in a field.</p>
            <dl className={styles.shortcutList}>
              <div><dt><kbd>Space</kbd></dt><dd>Play or pause</dd></div>
              <div><dt><kbd>←</kbd></dt><dd>Back 10 seconds</dd></div>
              <div><dt><kbd>→</kbd></dt><dd>Forward 10 seconds</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>Close an open player panel</dd></div>
            </dl>
          </section>
        </div>
      )}
    </>
  );
};
