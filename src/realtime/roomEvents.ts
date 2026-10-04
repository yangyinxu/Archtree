import { EventEmitter } from 'node:events';

/** Local wakeups contain no private payload; the gateway reauthorizes and projects committed state. */
const events = new EventEmitter();
export const notifyRoomChanges = () => { events.emit('changed'); };
export const onRoomChanges = (listener: () => void) => {
    events.on('changed', listener);
    return () => { events.off('changed', listener); };
};
