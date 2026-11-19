// Unit tests for the room-code and room-list helpers of the browser GUI overlay (T7.1e, T7.2b).
// The GUI file is loaded in a fresh VM context without Engine: it must not need the engine,
// and the override section must change nothing there (the native-build path).
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'overlay/public/gui/gamesetup_mp/web_roomcode.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);
const { webRoomCodeParse, webRoomCodeRandomPort, webRelayHostname, webDefaultPlayerName, webRoomListItems } = sandbox;

// "host:port" of a parse result, or "null", to compare across the VM realm.
const parsed = (text) =>
{
	const room = webRoomCodeParse(text);
	return room ? `${room.host}:${room.port}` : null;
};

test('a bare room code is the relay port on 127.0.0.1', () =>
{
	assert.equal(parsed('20647'), '127.0.0.1:20647');
	assert.equal(parsed(' 20647 '), '127.0.0.1:20647');
	assert.equal(parsed('20700'), '127.0.0.1:20700');
	assert.equal(parsed('20999'), '127.0.0.1:20999');
});

test('host:port is taken as given', () =>
{
	assert.equal(parsed('relay.example.org:20647'), 'relay.example.org:20647');
	assert.equal(parsed('1.2.3.4:20700'), '1.2.3.4:20700');
	assert.equal(parsed('  relay.example.org:20647  '), 'relay.example.org:20647');
});

test('unusable text parses to null', () =>
{
	assert.equal(webRoomCodeParse(''), null);
	assert.equal(webRoomCodeParse('   '), null);
	assert.equal(webRoomCodeParse(undefined), null);
	assert.equal(webRoomCodeParse('abc'), null);
	assert.equal(webRoomCodeParse('20647x'), null);
	assert.equal(webRoomCodeParse('host:'), null);
	assert.equal(webRoomCodeParse('host:99999'), null);
	assert.equal(webRoomCodeParse(':20647'), null);
	assert.equal(webRoomCodeParse('host:20:647'), null);
	assert.equal(webRoomCodeParse('host:20a47'), null);
	assert.equal(webRoomCodeParse('host:-20647'), null);
});

test('port must be an integer in 1024..65535', () =>
{
	assert.equal(webRoomCodeParse('1023'), null);
	assert.equal(parsed('1024'), '127.0.0.1:1024');
	assert.equal(parsed('65535'), '127.0.0.1:65535');
	assert.equal(webRoomCodeParse('65536'), null);
	assert.equal(webRoomCodeParse('1.2.3.4:65536'), null);
});

test('random room ports stay in 20700..20999 and are integers', () =>
{
	assert.equal(webRoomCodeRandomPort(() => 0), 20700);
	assert.equal(webRoomCodeRandomPort(() => 0.9999999), 20999);
	assert.equal(webRoomCodeRandomPort(() => 1), 20999);
	for (let i = 0; i < 1000; ++i)
	{
		const port = webRoomCodeRandomPort(Math.random);
		assert.equal(Number.isInteger(port), true);
		assert.equal(port >= 20700 && port <= 20999, true);
	}
});

test('the relay hostname comes out of a ws:// or wss:// URL', () =>
{
	assert.equal(webRelayHostname('wss://play.example.org:20600/'), 'play.example.org');
	assert.equal(webRelayHostname('ws://127.0.0.1:20640/'), '127.0.0.1');
	assert.equal(webRelayHostname('ws://relay.example.org/'), 'relay.example.org');
	assert.equal(webRelayHostname(''), '');
	assert.equal(webRelayHostname('http://play.example.org/'), '');
	assert.equal(webRelayHostname('play.example.org:20600'), '');
	assert.equal(webRelayHostname(undefined), '');
});

test('a chosen name is kept, the system user name becomes a random Player NNNN', () =>
{
	assert.equal(webDefaultPlayerName('Ana', 'web_user', Math.random), 'Ana');
	assert.equal(webDefaultPlayerName('web_user', 'web_user', () => 0), 'Player 1000');
	assert.equal(webDefaultPlayerName('', 'web_user', () => 0.99999), 'Player 9999');
	assert.equal(webDefaultPlayerName('  ', 'web_user', () => 0.5), 'Player 5500');
});

// "labels|codes" of a room list, to compare across the VM realm.
const listed = (text, escape = s => s) =>
{
	const items = webRoomListItems(text, escape);
	return `${Array.from(items.labels).join('|')}#${Array.from(items.codes).join('|')}`;
};

test('an empty, invalid or room-less answer lists nothing', () =>
{
	assert.equal(listed(''), '#');
	assert.equal(listed('x{'), '#');
	assert.equal(listed('{}'), '#');
	assert.equal(listed('{"rooms":[]}'), '#');
	assert.equal(listed('{"rooms":"nope"}'), '#');
	assert.equal(listed(null), '#');
	assert.equal(listed(undefined), '#');
});

test('rooms are sorted by code', () =>
{
	assert.equal(
		listed('{"rooms":[{"code":20710,"name":"Bob"},{"code":20705,"name":"Ana"}]}'),
		'Ana (20705)|Bob (20710)#20705|20710');
});

test('a room without a name is shown as Room <code>', () =>
{
	assert.equal(listed('{"rooms":[{"code":20705,"name":null}]}'), 'Room 20705#20705');
	assert.equal(listed('{"rooms":[{"code":20705}]}'), 'Room 20705#20705');
	assert.equal(listed('{"rooms":[{"code":20705,"name":""}]}'), 'Room 20705#20705');
	assert.equal(listed('{"rooms":[{"code":20705,"name":42}]}'), 'Room 20705#20705');
});

test('a room without an integer code is skipped', () =>
{
	assert.equal(
		listed('{"rooms":[{"code":"20705"},{"code":20705.5},{"code":20706,"name":"Ana"}]}'),
		'Ana (20706)#20706');
});

test('the room name goes through the escape function', () =>
{
	assert.equal(
		listed('{"rooms":[{"code":20705,"name":"[font=serif]x"}]}', s => '<' + s + '>'),
		'<[font=serif]x> (20705)#20705');
});

test('the player count is appended when it is an integer', () =>
{
	assert.equal(
		listed('{"rooms":[{"code":20705,"name":"Ana","players":2}]}'),
		'Ana (20705) — 2 players#20705');
	assert.equal(listed('{"rooms":[{"code":20705,"name":"Ana","players":null}]}'), 'Ana (20705)#20705');
	assert.equal(listed('{"rooms":[{"code":20705,"players":0}]}'), 'Room 20705 — 0 players#20705');
	assert.equal(listed('{"rooms":[{"code":20705,"players":"2"}]}'), 'Room 20705#20705');
});
