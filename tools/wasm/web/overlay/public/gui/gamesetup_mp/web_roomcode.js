/**
 * Room codes for the browser build (T7.1e).
 *
 * Every browser ENet socket goes through the UDP relay (tools/relay/PROTOCOL.md), so a browser
 * host's UDP port on the relay is the port typed in the host dialog. Players who load the page
 * from the same site share that relay, so a browser joiner reaches the host at 127.0.0.1:<port>:
 * the room code is the relay port, shown as digits. Native players use <relay host>:<port>.
 *
 * Loaded by gui/gamesetup_mp/gamesetup_mp.xml ("<script directory=\"gui/gamesetup_mp/\"/>"),
 * after gamesetup_mp.js, and replaces it only when the browser build passed -conf=webnet.relay
 * (tools/wasm/enet-tunnel.pre.js). In a native build it changes nothing.
 */

/**
 * Parse what the player typed in the join dialog: a room code ("20647") or "host:port".
 * Returns { host, port } or null when it is not a usable address.
 */
function webRoomCodeParse(text)
{
	const trimmed = String(text === undefined || text === null ? "" : text).trim();
	if (!trimmed)
		return null;

	let host = "127.0.0.1";
	let portText = trimmed;
	const colon = trimmed.indexOf(":");
	if (colon !== -1)
	{
		host = trimmed.slice(0, colon).trim();
		portText = trimmed.slice(colon + 1).trim();
		// Empty host, empty port, or a second colon (IPv6 is not supported here).
		if (!host || portText.indexOf(":") !== -1)
			return null;
	}

	if (!/^[0-9]+$/.test(portText))
		return null;
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		return null;

	return { host, port };
}

/**
 * A fresh relay port for hosting, in 20700..20999 (the relay's room-code range).
 * `random` is a function returning [0,1), Math.random in the game.
 */
function webRoomCodeRandomPort(random)
{
	const port = 20700 + Math.floor(random() * 300);
	return Math.max(20700, Math.min(20999, port));
}

/**
 * Default name of a browser player in the host/join dialog. In the browser
 * Engine.GetSystemUsername() is always "web_user", so every page would offer the same name and
 * the server refuses the second player (NDR_PLAYERNAME_IN_USE). A name the user chose or saved
 * is kept; otherwise a random "Player NNNN" is offered. `random` returns [0,1).
 */
function webDefaultPlayerName(current, systemName, random)
{
	const name = String(current === undefined || current === null ? "" : current).trim();
	if (name && name !== systemName)
		return current;

	const n = 1000 + Math.floor(random() * 9000);
	return "Player " + Math.max(1000, Math.min(9999, n));
}

/**
 * Hostname of the relay URL ("wss://play.example.org:20600/" -> "play.example.org"),
 * "" if it cannot be parsed. No URL object: the GUI script interface does not provide one.
 */
function webRelayHostname(relayUrl)
{
	const match = /^wss?:\/\/([^\/:?#]+)/i.exec(String(relayUrl === undefined || relayUrl === null ? "" : relayUrl).trim());
	return match ? match[1] : "";
}

/**
 * Items of the join dialog's "Open games" drop-down from the relay's GET /rooms answer
 * ({"rooms":[{"code","name","players","age"}]}, tools/relay/PROTOCOL.md). Returns
 * { labels, codes }, both empty when the text is not a room list; codes are the room codes as
 * strings (what the drop-down's list_data holds) and the labels are sorted by code.
 * `escape` is the GUI's escapeText: room names are user text and must not become GUI markup.
 */
function webRoomListItems(text, escape)
{
	const items = { labels: [], codes: [] };

	let rooms;
	try
	{
		rooms = JSON.parse(String(text === undefined || text === null ? "" : text));
	}
	catch (error)
	{
		return items;
	}
	if (!rooms || !Array.isArray(rooms.rooms))
		return items;

	const listed = rooms.rooms.filter(room => room && Number.isInteger(room.code));
	listed.sort((a, b) => a.code - b.code);

	for (const room of listed)
	{
		let label;
		if (typeof room.name === "string" && room.name)
			label = escape(room.name) + " (" + room.code + ")";
		else
			label = "Room " + room.code;
		if (Number.isInteger(room.players))
			label += " — " + room.players + " players";
		items.labels.push(label);
		items.codes.push(String(room.code));
	}

	return items;
}

/**
 * The rest only applies to the browser build: Engine is absent in Node and the relay config is
 * empty in a native build, so nothing below runs there.
 */
(function webRoomCodeInstall()
{
	if (typeof Engine === "undefined")
		return;
	const relayUrl = Engine.ConfigDB_GetValue("user", "webnet.relay");
	if (!relayUrl)
		return;
	if (typeof init !== "function" || typeof confirmSetup !== "function" || typeof startHost !== "function")
		return;

	// Host page: a fresh random relay port is the room code. Only the field is set, the config is
	// left alone (the XML Load action and startHost still read/save their own values).
	// Both pages also get their own default player name: the browser's system user name is always
	// "web_user", so the server would refuse the second player (NDR_PLAYERNAME_IN_USE). A name the
	// player typed or saved is kept, and nothing is written to the config.
	const webOriginalInit = init;
	init = function(attribs)
	{
		webInstallRoomList();

		const isHost = attribs && attribs.multiplayerGameType === "host";
		if (isHost)
			Engine.GetGUIObjectByName("hostPort").caption = String(webRoomCodeRandomPort(Math.random));

		const nameField = Engine.GetGUIObjectByName(isHost ? "hostPlayerName" : "joinPlayerName");
		if (nameField)
			nameField.caption = webDefaultPlayerName(nameField.caption, Engine.GetSystemUsername(), Math.random);

		return webOriginalInit(attribs);
	};

	// Join page: a room code (or "host:port") in the server field replaces host + port fields.
	const webOriginalConfirmSetup = confirmSetup;
	confirmSetup = function(loadSavedGame)
	{
		if (!Engine.GetGUIObjectByName("pageJoin").hidden)
		{
			const room = webRoomCodeParse(Engine.GetGUIObjectByName("joinServer").caption);
			if (room)
			{
				// Same call the original join branch makes (gamesetup_mp.js confirmSetup).
				const joinPlayerName = Engine.GetGUIObjectByName("joinPlayerName").caption;
				if (startJoin(joinPlayerName, room.host, room.port))
				{
					switchSetupPage("pageConnecting");
					return false;
				}
				return true;
			}
		}
		return webOriginalConfirmSetup(loadSavedGame);
	};

	// Join page: the relay's open rooms (PROTOCOL.md "Room list") in a drop-down, refreshed every
	// 2 s while the page is visible. Picking one writes its room code into the server field, which
	// confirmSetup above reads (webRoomCodeParse accepts a bare code).
	// Installed from init(): this file is loaded before the XML's objects exist.
	let webRoomListInstalled = false;
	function webInstallRoomList()
	{
		if (webRoomListInstalled || typeof Engine.WebRoomList !== "function")
			return;
		const joinRoomList = Engine.GetGUIObjectByName("joinRoomList");
		const pageJoin = Engine.GetGUIObjectByName("pageJoin");
		if (!joinRoomList || !pageJoin)
			return;
		webRoomListInstalled = true;

		let lastFetch = 0;
		let lastText = null;
		joinRoomList.onTick = function()
		{
			if (pageJoin.hidden)
				return;
			const now = Date.now();
			if (now - lastFetch < 2000)
				return;
			lastFetch = now;

			const text = Engine.WebRoomList();
			if (text === lastText)
				return;
			lastText = text;

			// Keep the player's choice selected while its room is still listed.
			const selected = joinRoomList.enabled ? joinRoomList.list_data[joinRoomList.selected] : "";
			const items = webRoomListItems(text, escapeText);
			if (!items.codes.length)
			{
				joinRoomList.list = ["(none)"];
				joinRoomList.list_data = [""];
				joinRoomList.enabled = false;
				// "(none)" is item 0; its data is "", so no code is written to the server field.
				if (joinRoomList.selected !== 0)
					joinRoomList.selected = 0;
				return;
			}
			joinRoomList.list = items.labels;
			joinRoomList.list_data = items.codes;
			joinRoomList.enabled = true;
			// Keep the player's choice; nothing is selected until the player picks a room, so a room
			// appearing never overwrites an address the player typed. Re-assigning the same index
			// still fires SelectionChange, so only assign when it changed.
			const index = items.codes.indexOf(selected);
			if (joinRoomList.selected !== index)
				joinRoomList.selected = index;
		};

		joinRoomList.onSelectionChange = function()
		{
			const code = joinRoomList.list_data[joinRoomList.selected];
			if (code)
				Engine.GetGUIObjectByName("joinServer").caption = code;
		};
	}

	// After a successful host start, show the code. A failed bind throws inside the original
	// startHost (enet_socket_bind waits for the relay's answer), which shows its own error box.
	const webOriginalStartHost = startHost;
	startHost = function(playername, servername, port, password, loadSavedGame)
	{
		if (!webOriginalStartHost(playername, servername, port, password, loadSavedGame))
			return false;

		const code = `Room code: ${port}   (native 0 A.D.: ${webRelayHostname(relayUrl)}:${port})`;
		Engine.GetGUIObjectByName("hostFeedback").caption = code;
		warn(code);

		// Tell the relay this room's name (PROTOCOL.md "Room list": a 0x03 META message on the
		// socket bound to `port`) so other players find it in their "Open games" list.
		if (typeof Engine.WebRoomAnnounce === "function")
			warn("Room announce: " + Engine.WebRoomAnnounce(port, JSON.stringify({ "name": playername })));
		return true;
	};
})();
