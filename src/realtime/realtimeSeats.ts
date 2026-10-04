import type { RealtimeSeatRefusal } from '../config/socialCapacity';
import type { RoomActor } from '../contracts/roomV1';

export type RealtimeSeatCheck = (actor: RoomActor) => Promise<RealtimeSeatRefusal | null>;

let installed: RealtimeSeatCheck | null = null;

/**
 * The installed gateway's seat rule, shared with the ticket route so a refused seat costs no ticket
 * transaction. Without a gateway no upgrade can succeed, so the route issues tickets as before.
 */
export const realtimeSeats = {
    install(check: RealtimeSeatCheck) {
        installed = check;
        return () => { if (installed === check) installed = null; };
    },
    check: (actor: RoomActor): Promise<RealtimeSeatRefusal | null> => installed ? installed(actor) : Promise.resolve(null)
};
