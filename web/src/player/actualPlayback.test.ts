import { createActualPlaybackObserver, type ActualPlaybackObservation } from './actualPlayback';
import { createPlayerStore } from './playerStore';
import type { PlayerAudio, PlayerQueueItem, PlayerStore } from './types';

/** A successful play call deliberately does not synthesize actual native playing. */
class Media extends EventTarget implements PlayerAudio {
  src = ''; currentSrc = ''; currentTime = 0; duration = 60; volume = 1; muted = false;
  paused = true; ended = false; error = null; playbackRate = 1; readyState = 1; seeking = false;
  play = vi.fn(async () => { this.paused = false; this.emit('play'); });
  pause() { this.paused = true; this.emit('pause'); }
  load() { this.currentSrc = this.src; this.readyState = 1; this.emit('loadstart'); }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
  playing() { this.readyState = 4; this.paused = false; this.ended = false; this.emit('playing'); }
  progress(value: number) { this.currentTime = value; this.emit('timeupdate'); }
}
const track = (digit: string, mediaType: 'audio' | 'video' = 'audio'): PlayerQueueItem => ({ id: digit.repeat(24),
  title: 'Synthetic Audio', artistNames: [], artworkUrl: '', mediaType, streamUrl: `/content/mediaTrack/stream/${digit.repeat(24)}` });
const events: ActualPlaybackObservation[] = [];
let media: Media; let store: PlayerStore; let stop: () => void;
beforeEach(() => {
  events.length = 0; media = new Media(); store = createPlayerStore({ audioFactory: () => media, mediaSession: null });
  stop = createActualPlaybackObserver(store, event => events.push(event), { now: () => 1000 });
});
afterEach(() => { stop(); store.destroy(); });
const samples = () => events.filter((event): event is Extract<ActualPlaybackObservation, { sample: unknown }> => 'sample' in event);

test('optimistic play state and promise resolution do not publish; exact playing and advancing progress do', async () => {
  await store.launchStandalone(track('a'));
  expect(store.getSnapshot().status).toBe('playing'); expect(samples()).toEqual([]);
  media.progress(1); expect(samples()).toEqual([]);
  media.playing(); expect(samples()).toHaveLength(1);
  expect(samples()[0]).toMatchObject({ type: 'playing', sample: { intentId: 1, mediaTrackId: 'a'.repeat(24), positionMs: 1000, observedAtMs: 1000, room: null } });
  media.emit('playing'); media.progress(1); expect(samples()).toHaveLength(1);
  media.progress(2); expect(samples()).toHaveLength(2);
  expect(samples()[1].sample.occurrenceId).toBe(samples()[0].sample.occurrenceId);
});

test.each(['wrong-source', 'empty-source', 'paused', 'not-ready', 'seeking', 'video'])('unproven %s events cannot establish listening', async reason => {
  await store.launchStandalone(track('a', reason === 'video' ? 'video' : 'audio'));
  media.readyState = 4;
  if (reason === 'wrong-source') media.currentSrc = '/content/mediaTrack/stream/old';
  if (reason === 'empty-source') media.currentSrc = '';
  if (reason === 'paused') media.paused = true;
  if (reason === 'not-ready') media.readyState = 2;
  if (reason === 'seeking') media.seeking = true;
  media.emit('playing'); media.progress(1); expect(samples()).toEqual([]);
});

test.each(['pause', 'waiting', 'stalled', 'seeking'])('%s clears the occurrence; same proven source recovers only with fresh native progress', async event => {
  await store.launchStandalone(track('a')); media.playing(); media.progress(2);
  const previous = samples().at(-1)!.sample;
  media.emit(event);
  expect(events.at(-1)).toEqual({ type: 'stopped', occurrenceId: previous.occurrenceId });
  media.progress(2); expect(events.at(-1)?.type).toBe('stopped');
  media.progress(3);
  expect(samples().at(-1)!.type).toBe('playing');
  expect(samples().at(-1)!.sample.sourceId).toBe(previous.sourceId);
  expect(samples().at(-1)!.sample.occurrenceId).not.toBe(previous.occurrenceId);
});

test('a seek jump cannot masquerade as advancing progress, and source replacement forgets earlier proof', async () => {
  await store.launchStandalone(track('a')); media.playing(); media.progress(2);
  store.seek(30); media.emit('seeked'); const count = samples().length;
  media.progress(30); expect(samples()).toHaveLength(count);
  media.progress(30.5); expect(samples()).toHaveLength(count + 1);
  const previous = samples().at(-1)!.sample;
  await store.launchStandalone(track('b')); media.readyState = 4; media.progress(1);
  expect(samples()).toHaveLength(count + 1);
  media.playing(); expect(samples().at(-1)!.sample.sourceId).not.toBe(previous.sourceId);
  expect(samples().at(-1)!.sample.mediaTrackId).toBe('b'.repeat(24));
});

test('freeze stops, hidden Audio can progress, and unsubscription stops the captured occurrence', async () => {
  await store.launchStandalone(track('a')); media.playing(); media.progress(2);
  document.dispatchEvent(new Event('visibilitychange')); media.progress(3);
  expect(events.at(-1)?.type).toBe('progress');
  document.dispatchEvent(new Event('freeze')); const before = samples().length;
  media.progress(4); expect(samples()).toHaveLength(before);
  document.dispatchEvent(new Event('resume')); media.progress(5);
  expect(samples()).toHaveLength(before + 1);
  const occurrenceId = samples().at(-1)!.sample.occurrenceId;
  stop(); expect(events.at(-1)).toEqual({ type: 'stopped', occurrenceId });
  const length = events.length; media.progress(6); expect(events).toHaveLength(length);
});

test('natural advancement changes source without inventing a new explicit intent', async () => {
  await store.launchQueue([track('a'), track('b')], 0); media.playing();
  media.ended = true; media.emit('ended'); await Promise.resolve(); await Promise.resolve();
  expect(store.getSnapshot().currentItem?.id).toBe('b'.repeat(24));
  media.playing(); expect(samples().at(-1)!.sample.intentId).toBe(1);
  expect(events.filter(event => event.type === 'intent')).toHaveLength(1);
  store.notePlaybackIntent(); media.progress(1); expect(samples().at(-1)!.sample.intentId).toBe(2);
});

test('late subscribers cannot infer past actual playing from the current snapshot', async () => {
  await store.launchStandalone(track('a')); media.playing(); stop();
  const late: ActualPlaybackObservation[] = [];
  const unsubscribe = createActualPlaybackObserver(store, event => late.push(event));
  media.progress(3); expect(late).toEqual([]);
  media.emit('playing'); expect(late[0]?.type).toBe('playing'); unsubscribe();
});

test('explicit intent generations remain monotonic when the same player observer remounts', async () => {
  await store.launchStandalone(track('a')); store.notePlaybackIntent(); stop();
  const later: ActualPlaybackObservation[] = [];
  const unsubscribe = createActualPlaybackObserver(store, event => later.push(event));
  store.notePlaybackIntent();
  expect(later[0]).toEqual({ type: 'intent', intentId: 3 }); unsubscribe();
});

test('a remounted observer recovers continuing Audio only after a new gesture and two fresh advancing observations', async () => {
  await store.launchStandalone(track('a')); media.playing(); stop();
  const later: ActualPlaybackObservation[] = [];
  const unsubscribe = createActualPlaybackObserver(store, event => later.push(event));
  media.progress(1); media.progress(2); expect(later).toEqual([]);
  store.notePlaybackIntent(); expect(later).toHaveLength(1);
  media.progress(3); media.progress(3); expect(later).toHaveLength(1);
  media.paused = true; media.progress(4); media.progress(5); expect(later).toHaveLength(1);
  media.paused = false; media.progress(6); expect(later).toHaveLength(1);
  media.progress(6.5);
  expect(later[1]).toMatchObject({ type: 'playing', sample: { intentId: 2, positionMs: 6500 } });
  unsubscribe();
});

test('a source change retires a remounted recovery gesture before fresh progress can bind it elsewhere', async () => {
  await store.launchStandalone(track('a')); media.playing(); stop();
  const later: ActualPlaybackObservation[] = [];
  const unsubscribe = createActualPlaybackObserver(store, event => later.push(event));
  store.notePlaybackIntent(); media.progress(1);
  await store.launchStandalone(track('b'), { autoplay: false }); media.readyState = 4; media.paused = false;
  media.progress(2); media.progress(3);
  expect(later.filter(event => 'sample' in event)).toEqual([]);
  unsubscribe();
});
