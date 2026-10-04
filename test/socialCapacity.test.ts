import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    admitRealtimeSeat, generalRealtimeSeats, REALTIME_SOCKET_CEILING, REALTIME_SOCKETS_PER_ACCOUNT, realtimeSeatRefusal,
    realtimeSocketsPerAccount, resolveSocialCapacity, socialCapacity, type RealtimeSeatState
} from '../src/config/socialCapacity';
import { ROOM_LIMITS } from '../src/contracts/roomV1';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('unset capacity keeps the room contract maximums and the previous socket ceiling', () => {
    assert.deepEqual(resolveSocialCapacity({}), {
        capacity: { maxOpenRooms: ROOM_LIMITS.activeRooms, maxRoomMembers: ROOM_LIMITS.members, maxRealtimeSockets: REALTIME_SOCKET_CEILING },
        invalid: []
    });
    assert.deepEqual(socialCapacity({ FINITUDE_ROOMS_MAX_OPEN: '  ', FINITUDE_ROOM_MAX_MEMBERS: '' }).maxOpenRooms, 100);
});

test('whole numbers inside the range apply, and out-of-range values clamp and are named', () => {
    assert.deepEqual(resolveSocialCapacity({ FINITUDE_ROOMS_MAX_OPEN: '1', FINITUDE_ROOM_MAX_MEMBERS: ' 2 ', FINITUDE_REALTIME_MAX_SOCKETS: '10' }),
        { capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 10 }, invalid: [] });
    assert.deepEqual(resolveSocialCapacity({ FINITUDE_ROOMS_MAX_OPEN: '0', FINITUDE_ROOM_MAX_MEMBERS: '12', FINITUDE_REALTIME_MAX_SOCKETS: '999999' }), {
        capacity: { maxOpenRooms: 1, maxRoomMembers: 8, maxRealtimeSockets: 256 },
        invalid: ['FINITUDE_ROOMS_MAX_OPEN', 'FINITUDE_ROOM_MAX_MEMBERS', 'FINITUDE_REALTIME_MAX_SOCKETS']
    });
});

test('values that are not whole numbers fall back to the ceiling and only the variable name is reported', () => {
    for (const value of ['-1', '2.5', '1e2', 'ten', '0x10', '1234567', 'secret-looking-value']) {
        const { capacity, invalid } = resolveSocialCapacity({ FINITUDE_ROOM_MAX_MEMBERS: value });
        assert.equal(capacity.maxRoomMembers, ROOM_LIMITS.members, value);
        assert.deepEqual(invalid, ['FINITUDE_ROOM_MAX_MEMBERS']);
        assert.equal(JSON.stringify(invalid).includes(value), false);
    }
});

test('room participants keep up to half the realtime seats', () => {
    assert.equal(generalRealtimeSeats({ maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 10 }), 8);
    assert.equal(generalRealtimeSeats({ maxOpenRooms: 100, maxRoomMembers: 8, maxRealtimeSockets: 256 }), 128);
    assert.equal(generalRealtimeSeats({ maxOpenRooms: 4, maxRoomMembers: 8, maxRealtimeSockets: 12 }), 6);
    assert.equal(generalRealtimeSeats({ maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 1 }), 1);
});

const shipped = { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 10 };

test('accounts get a quarter of the general seats, between one and four sockets', () => {
    assert.equal(realtimeSocketsPerAccount(shipped), 2);
    assert.equal(realtimeSocketsPerAccount({ maxOpenRooms: 100, maxRoomMembers: 8, maxRealtimeSockets: 256 }), REALTIME_SOCKETS_PER_ACCOUNT);
    assert.equal(realtimeSocketsPerAccount({ maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 }), 1);
    assert.equal(realtimeSocketsPerAccount({ maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 1 }), 1);
});

/** A process simulated as one socket list: [account, in a room]. */
const simulate = (sockets: Array<[string, boolean]>) => (account: string, replacing = false): RealtimeSeatState => {
    const members = new Set(sockets.filter(([, inRoom]) => inRoom).map(([id]) => id));
    return { replacing, openSockets: sockets.length, memberAccounts: members.size,
        accountSockets: sockets.filter(([id]) => id === account).length, accountIsMember: members.has(account) };
};

test('tabs outside rooms fill only the general seats and each member keeps a reserved seat', () => {
    // Four accounts with two idle tabs each fill the eight general seats of the shipped capacity.
    const idle: Array<[string, boolean]> = ['a', 'b', 'c', 'd'].flatMap(id => [[id, false], [id, false]] as Array<[string, boolean]>);
    const full = simulate(idle);
    assert.equal(realtimeSeatRefusal(full('e'), shipped, false), 'capacity', 'A fifth idle account waits.');
    assert.equal(realtimeSeatRefusal(full('a'), shipped, false), 'perAccount', 'A third idle tab of one account waits.');
    assert.equal(realtimeSeatRefusal(full('a', true), shipped, false), null, 'Replacing a socket needs no seat.');
    // The host who just created a room, and then the guest who just joined it, each find a reserved seat.
    assert.equal(realtimeSeatRefusal(full('host'), shipped, true), null);
    const hosted = simulate([...idle, ['host', true]]);
    assert.equal(realtimeSeatRefusal(hosted('guest'), shipped, true), null);
    assert.equal(realtimeSeatRefusal(hosted('host'), shipped, true), 'capacity', 'A member\'s second tab needs a general seat.');
    const joined = simulate([...idle, ['host', true], ['guest', true]]);
    assert.equal(realtimeSeatRefusal(joined('later'), shipped, true), 'capacity', 'The process is full.');
});

test('a member\'s first socket never counts against the general seats or the per-account share', () => {
    // Early tabs of a member sit in general seats; the reserved seat still covers that member's first socket.
    const state = simulate([['host', true], ['host', true], ['x', false], ['x', false], ['y', false], ['y', false], ['z', false], ['z', false]]);
    assert.equal(realtimeSeatRefusal(state('w'), shipped, false), null, 'The member\'s second tab and six idle tabs leave one general seat.');
    assert.equal(realtimeSeatRefusal(simulate([['host', true], ['host', true],
        ['x', false], ['x', false], ['y', false], ['y', false], ['z', false], ['z', false], ['w', false]])('v'), shipped, false), 'capacity');
    assert.equal(realtimeSeatRefusal(state('host'), shipped, true), null, 'A member may hold one socket beyond the share.');
    const crowded = simulate([['host', true], ['host', true], ['host', true], ['x', false]]);
    assert.equal(realtimeSeatRefusal(crowded('host'), shipped, true), 'perAccount');
    const ceiling = simulate(Array.from({ length: 4 }, () => ['host', true] as [string, boolean]));
    assert.equal(realtimeSeatRefusal(ceiling('host'), { maxOpenRooms: 100, maxRoomMembers: 8, maxRealtimeSockets: 256 }, true), 'perAccount');
});

test('membership is looked up only when it can change the outcome, then judged on a fresh state', async () => {
    const capacity = { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 4 };
    let lookups = 0;
    const member = (value: boolean) => async () => { lookups += 1; return value; };
    assert.deepEqual(await admitRealtimeSeat(() => simulate([['a', false]])('b'), capacity, member(false)), { refusal: null, member: false });
    assert.equal(lookups, 0, 'A free general seat needs no lookup.');
    const generalFull = simulate([['a', false], ['b', false]]);
    assert.deepEqual(await admitRealtimeSeat(() => generalFull('c'), capacity, member(false)), { refusal: 'capacity', member: false });
    assert.deepEqual(await admitRealtimeSeat(() => generalFull('c'), capacity, member(true)), { refusal: null, member: true });
    assert.equal(lookups, 2);
    const known = simulate([['a', false], ['b', false], ['m', true]]);
    assert.deepEqual(await admitRealtimeSeat(() => known('m'), capacity, member(true)), { refusal: 'capacity', member: true });
    const processFull = simulate([['a', false], ['b', false], ['m', true], ['n', true]]);
    assert.deepEqual(await admitRealtimeSeat(() => processFull('o'), capacity, member(true)), { refusal: 'capacity', member: false });
    assert.equal(lookups, 2, 'Known members and a full process need no lookup.');
    // Failed or malformed lookups cannot prove membership.
    for (const lookup of [async () => { throw new Error('Synthetic lookup failure.'); },
        () => { throw new Error('Synthetic synchronous failure.'); }, async () => 'yes' as never]) {
        assert.equal((await admitRealtimeSeat(() => generalFull('c'), capacity, lookup)).refusal, 'capacity');
    }
    // A seat taken while the lookup was pending is seen by the second read.
    let state = generalFull('c');
    const raced = await admitRealtimeSeat(() => state, capacity, async () => { state = simulate([['a', false], ['b', false], ['m', true], ['n', true]])('c'); return true; });
    assert.deepEqual(raced, { refusal: 'capacity', member: true });
});

test('the shipped Elastic Beanstalk defaults are literal, in range and match the documented budget', async () => {
    const source = await readFile(path.join(repositoryRoot, '.ebextensions/social-capacity.config'), 'utf8');
    const value = (name: string) => {
        const matches = [...source.matchAll(new RegExp(`^\\s+${name}: "(\\d+)"$`, 'gm'))];
        assert.equal(matches.length, 1, `${name} must be set exactly once as a quoted whole number`);
        return matches[0][1];
    };
    const environment = { FINITUDE_ROOMS_MAX_OPEN: value('FINITUDE_ROOMS_MAX_OPEN'),
        FINITUDE_ROOM_MAX_MEMBERS: value('FINITUDE_ROOM_MAX_MEMBERS'), FINITUDE_REALTIME_MAX_SOCKETS: value('FINITUDE_REALTIME_MAX_SOCKETS') };
    assert.match(source, /^option_settings:\n {2}aws:elasticbeanstalk:application:environment:\n/m);
    assert.deepEqual(resolveSocialCapacity(environment), {
        capacity: { maxOpenRooms: 1, maxRoomMembers: 2, maxRealtimeSockets: 10 }, invalid: []
    });
    const budget = await readFile(path.join(repositoryRoot, 'docs/testing/t4g-micro-capacity-screen.md'), 'utf8');
    assert.match(budget, /sets one open room, two members and ten\s+realtime sockets/);
});
