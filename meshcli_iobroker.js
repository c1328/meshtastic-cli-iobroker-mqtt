// this script/idea is based on https://forum.iobroker.net/topic/73326/meshtastic/2

// Meshtastic ioBroker Integration Kit (Full Script)

// Configuration of IP adress of meshtastic node that is connected via TCP
var deviceIp = '<IP-of-your-meshtastic-node>';
// Configuration of MQTT instance that is used (in my case 3rd instance)
var mqttPath = 'mqtt.3.msh.*.json.*'; 
 
var chats = [
    { name: 'Default', id: 0 },
    { name: '<private channel>', id: 1 },
    { name: '<public channel>', id: 2 }
];


// ======================================================
// 1. MQTT TRIGGER (Realtime Chat + Name Resolution)
// ======================================================
on({id: /^mqtt\.3\.msh\..*\.json\..*$/, change: "any"}, function (obj) {
    try {
        if (!obj.state.val) return;
        const msg = JSON.parse(obj.state.val);

        // Basis-Daten extrahieren
        const channelIdx = parseInt(msg.channel) || 0;
        
        // ID generieren: Dezimal zu Hex, Kleinbuchstaben, ohne !, aufgefüllt auf 8 Stellen
        let senderHex = parseInt(msg.from).toString(16).toLowerCase().replace('!', '').padStart(8, '0');
        const nodeBasePath = '0_userdata.0.Meshtastic.Nodes.' + senderHex;

        // --- Namensauflösung ---
        let displayName = senderHex;
        if (existsState(nodeBasePath + '.info.alias')) {
            let aliasVal = getState(nodeBasePath + '.info.alias').val;
            if (aliasVal && aliasVal !== 'N/A' && aliasVal !== '') displayName = aliasVal;
        } else if (existsState(nodeBasePath + '.info.user')) {
            let userVal = getState(nodeBasePath + '.info.user').val;
            if (userVal && userVal !== 'N/A' && userVal !== '') displayName = userVal;
        }

        // --- FALL 1: TEXTNACHRICHTEN ---
        if (msg.type === "text" && msg.payload && msg.payload.text) {
            const text = msg.payload.text;
            const nodeMsgPath = nodeBasePath + '.info.lastMessage';

            // In Node Info speichern
            if (existsObject(nodeBasePath)) {
                if (!existsState(nodeMsgPath)) {
                    setObject(nodeMsgPath, {
                        type: 'state',
                        common: { name: 'Letzte Nachricht', type: 'string', role: 'text', read: true, write: false },
                        native: {}
                    });
                }
                setState(nodeMsgPath, text, true);
            }

            // In Chat & Historie speichern
            const chatPath = '0_userdata.0.Meshtastic.Chats.' + channelIdx;
            if (existsObject(chatPath)) {
                setState(chatPath + '.lastMessage', `${displayName}: ${text}`, true);
                addToHistory(channelIdx, displayName, text);
            } else {
                log(`Chat-Kanal ${channelIdx} nicht gefunden unter ${chatPath}`, "warn");
            }
            log(`Meshtastic Text: [Kanal ${channelIdx}] ${displayName}: ${text}`);
        }

        // --- FALL 2: POSITIONSDATEN ---
        else if (msg.type === "position" && msg.payload) {
            const p = msg.payload;
            const infoPath = nodeBasePath + '.info.';

            if (p.latitude_i && p.longitude_i) {
                // Umrechnung von Meshtastic Integer zu Float
                const lat = p.latitude_i / 10000000;
                const lon = p.longitude_i / 10000000;
                const alt = p.altitude || 0;

                if (existsObject(nodeBasePath)) {
                    // Einzelne Datenpunkte setzen
                    setState(infoPath + 'latitude', lat, true);
                    setState(infoPath + 'longitude', lon, true);
                    setState(infoPath + 'altitude', alt, true);
                    
                    // Kombiniertes Location-Feld für Jarvis/Maps (lat,lon)
                    setState(infoPath + 'location', `${lat},${lon}`, true);

                    log(`Meshtastic Position: ${displayName} ist bei ${lat}, ${lon}`);
                }
            }
        }
    } catch (e) {
        log("Fehler im MQTT Trigger: " + e, "error");
    }
});


// Trigger für Nachrichten an Kanäle (Chats)
on({id: /^0_userdata\.0\.Meshtastic\.Chats\.\d+\.sendMessage$/, change: "any"}, function (obj) {
    const msg = obj.state.val;
    if (!msg || msg === "" || obj.state.ack === true) return;

    const parts = obj.id.split('.');
    const channelId = parseInt(parts[parts.length - 2]); 
    
    // Log-Fix: Falls obj.from undefined ist, nutzen wir einen Fallback
    const source = obj.from || "Skript/System";
    
    // Sonderzeichen-Schutz: Wir entfernen einfache Anführungszeichen aus der Nachricht,
    // um den Shell-Befehl nicht zu brechen.
    const safeMsg = msg.replace(/'/g, ""); 

    log(`Meshtastic: Sende an Kanal ${channelId} (von ${source}): ${safeMsg}`);

    // Wir umschließen die Nachricht in EINFACHE Anführungszeichen (') für die Shell
    const command = `/home/iobroker/.local/bin/meshtastic --host ${deviceIp} --ch-index ${channelId} --sendtext '${safeMsg}'`;

    exec(command, function (error, stdout, stderr) {
        if (error) {
            log(`Fehler beim Senden (Kanal ${channelId}): ${stderr || error}`, 'error');
        } else {
            // Feld leeren nach Erfolg
            setTimeout(() => setState(obj.id, "", true), 500);
        }
    });
});

// 2. Trigger für Direktnachrichten (Nodes)
on({id: /^0_userdata\.0\.Meshtastic\.Nodes\..*\.command\.sendMessage$/, change: "any", ack: false}, function (obj) {
    const msg = obj.state.val;
    if (!msg || msg === "") return;

    const parts = obj.id.split('.');
    const nodeId = parts[parts.length - 3]; 
    const safeMsg = msg.replace(/"/g, '\\"');

    log(`Meshtastic: Sende Direktnachricht an !${nodeId}: ${safeMsg}`);

    exec(`/home/iobroker/.local/bin/meshtastic --host ${deviceIp} --dest "!${nodeId}" --sendtext "${safeMsg}"`, function (error) {
        if (!error) {
            setTimeout(() => setState(obj.id, "", true), 500);
        }
    });
});


// ======================================================
// 2. CLI Node Polling + Parsing
// ======================================================
function updateNodes() {
    exec('/home/iobroker/.local/bin/meshtastic --host ' + deviceIp + ' --nodes', function (error, result, stderr) {
        if (result && result.includes('Connected to radio')) {
            var nodes = parseData(result);
            handleNodes(nodes);
        }
    });
}

function handleNodes(nodes) {
    nodes.forEach(node => {
        node.ID = node.ID.replace("!", "");
        if (nodeIsKnown(node.ID)) {
            updateNode(node);
        } else {
            createNode(node);
            setTimeout(() => updateNode(node), 4000);
        }
    });
}

function nodeIsKnown(id) {
    return !!getObject('0_userdata.0.Meshtastic.Nodes.' + id);
}

function parseData(data) {
    const lines = data.trim().split('\n');
    const headerIndex = lines.findIndex(l => l.includes('│') && l.includes('ID'));
    if (headerIndex === -1) return [];
    const keys = lines[headerIndex].split('│').map(k => k.trim()).filter((k, i, arr) => i > 0 && i < arr.length - 1);
    return lines.filter(l => l.includes('│') && !l.includes('═') && !l.includes('─') && !l.includes(' User '))
        .map(line => {
            let values = line.split('│').map(v => v.trim()).slice(1, -1);
            if (values.length < keys.length) return null;
            let obj = {};
            keys.forEach((key, index) => { obj[key] = values[index] || "N/A"; });
            return obj;
        }).filter(obj => obj !== null);
}

// ======================================================
// 3. Node Creation + Info States + Command States
// ======================================================
function createNode(data) {
    log("creating new node " + data.User, "info");

    setObject('0_userdata.0.Meshtastic.Nodes.' + data.ID, {
        type: 'channel',
        common: { name: data.User },
        native: {}
    });

    createNodeStates(data.ID);
}

function createNodeStates(id) {

    // Info Channel
    setObject('0_userdata.0.Meshtastic.Nodes.' + id + '.info', {
        type: 'channel',
        common: { name: 'Info' },
        native: {}
    });

    // Info States
    var nodeInfoStates = [
        {id: 'id', name: 'NodeID', type: 'string'},
        {id: 'user', name: 'User', type: 'string'},
        {id: 'alias', name: 'Alias', type: 'string'},
        {id: 'location', name: 'Location', type: 'string', role: 'value.gps'}, // for JARVIS map
        {id: 'latitude', name: 'Latitude', type: 'number', role: 'value.gps.latitude'},
        {id: 'longitude', name: 'Longitude', type: 'number', role: 'value.gps.longitude'},
        {id: 'altitude', name: 'Altitude', type: 'number', unit: 'm'},
        {id: 'chanUtil', name: 'Channel util.', type: 'number', unit: '%'},
        {id: 'txAir', name: 'Tx air util.', type: 'number', unit: '%'},
        {id: 'snr', name: 'SNR', type: 'number', unit: 'dB'},
        {id: 'channel', name: 'Channel', type: 'string'},
        {id: 'lastHeard', name: 'Last heard', type: 'string'},
        {id: 'battery', name: 'Battery', type: 'number', unit: '%'},
        {id: 'lastMessage', name: 'Letzte Nachricht', type: 'string'}
    ];

    nodeInfoStates.forEach(state => {
        setObject('0_userdata.0.Meshtastic.Nodes.' + id + '.info.' + state.id, {
            type: 'state',
            common: {
                name: state.name,
                type: state.type === 'string' ? 'string' :
                      state.type === 'number' ? 'number' :
                      state.type === 'boolean' ? 'boolean' : 'string', // cast TS
                role: state.role || 'value',
                unit: state.unit || null,
                read: true,
                write: false,
                def: state.type === 'number' ? 0 : ''
            },
            native: {}
        });
    });

    // Command Channel
    setObject('0_userdata.0.Meshtastic.Nodes.' + id + '.command', {
        type: 'channel',
        common: { name: 'Command' },
        native: {}
    });

    // Command States
    var nodeCommandStates = [
        {id: 'sendMessage', name: 'Direktnachricht senden', type: 'string', role: 'value'},
        {id: 'sendPing', name: 'Ping senden', type: 'boolean', role: 'button'},
        {id: 'sendTraceRoute', name: 'Traceroute starten', type: 'boolean', role: 'button'},
        {id: 'getLocation', name: 'Standort anfordern', type: 'boolean', role: 'button'},
        {id: 'getTelemetry', name: 'Telemetrie anfordern', type: 'boolean', role: 'button'}
    ];

    nodeCommandStates.forEach(state => {
        setObject('0_userdata.0.Meshtastic.Nodes.' + id + '.command.' + state.id, {
            type: 'state',
            common: {
                name: state.name,
                type: state.type === 'string' ? 'string' :
                      state.type === 'number' ? 'number' :
                      state.type === 'boolean' ? 'boolean' : 'string',
                role: state.role,
                read: true,
                write: true,
                def: state.type === 'number' ? 0 : ''
            },
            native: {}
        });
    });
}

// ======================================================
// 4. Update Node Values (Location + Lat/Lon separated)
// ======================================================
function updateNode(data) {

    function parseNum(val) {
        if (!val || val === "N/A" || val === "Powered") return 0;
        // Entfernt Einheiten wie %, m, dB und konvertiert zu Number
        return parseFloat(val.replace(/[^\d.-]/g, "")) || 0;
    }

    const path = '0_userdata.0.Meshtastic.Nodes.' + data.ID + '.info.';

    // Basis-Informationen
    setState(path + "id", data.N || "N/A", true);
    setState(path + "user", data.User || "N/A", true);
    setState(path + "alias", data.AKA || "N/A", true);

    // Standort-Logik
    let lat = parseNum(data.Latitude);
    let lon = parseNum(data.Longitude);

    // Nur aktualisieren, wenn echte Koordinaten geliefert werden (verhindert 0,0 Sprünge)
    if (lat !== 0 && lon !== 0) {
        setState(path + "latitude", lat, true);
        setState(path + "longitude", lon, true);
        // Format lat,lon (ohne Leerzeichen) für Jarvis Maps
        setState(path + "location", lat + "," + lon, true);
    }

    // Hardware- & Netzparameter
    setState(path + "altitude", parseNum(data.Altitude), true);
    setState(path + "chanUtil", parseNum(data["Channel util."]), true);
    setState(path + "txAir", parseNum(data["Tx air util."]), true);
    setState(path + "snr", parseNum(data.SNR), true);
    setState(path + "channel", data.Channel || "0", true);
    setState(path + "lastHeard", data.LastHeard || "N/A", true);
    
    // Batterie-Sonderbehandlung für "Powered"
    let battVal = data.Battery === 'Powered' ? 100 : parseNum(data.Battery);
    setState(path + "battery", battVal, true);
}

// ======================================================
// 5. Chats + SendMessage Endpoint
// ======================================================
function createChannels() {
    setObject('0_userdata.0.Meshtastic', { type: 'channel', common: { name: 'Meshtastic Server' }, native: {} });
    setObject('0_userdata.0.Meshtastic.Nodes', { type: 'channel', common: { name: 'Nodes' }, native: {} });
    setObject('0_userdata.0.Meshtastic.Chats', { type: 'channel', common: { name: 'Chats' }, native: {} });
}

function createChats() {
    chats.forEach(chatObj => {
        // create channels
        setObject('0_userdata.0.Meshtastic.Chats.' + chatObj.id, {
            type: 'channel',
            common: { 
                name: chatObj.name 
            },
            native: {}
        });

        // last message (read-only)
        setObject('0_userdata.0.Meshtastic.Chats.' + chatObj.id + '.lastMessage', {
            type: 'state',
            common: { 
                name: 'Letzte Nachricht', 
                type: 'string', 
                role: 'text', 
                read: true, 
                write: false 
            },
            native: {}
        });

        // send message (allow writing)
        setObject('0_userdata.0.Meshtastic.Chats.' + chatObj.id + '.sendMessage', {
            type: 'state',
            common: { 
                name: 'Nachricht senden', 
                type: 'string', 
                role: 'text', 
                read: true, 
                write: true 
            },
            native: {}
        });

        // message history as JSON (read-only)
        setObject('0_userdata.0.Meshtastic.Chats.' + chatObj.id + '.history', {
            type: 'state',
            common: { 
                name: 'Chat Historie JSON', 
                type: 'string', 
                role: 'json', 
                read: true, 
                write: false 
           },
           native: {}
         });
        
        // message history as JSON html (read-only)
         setObject('0_userdata.0.Meshtastic.Chats.' + chatObj.id + '.history_html', {
            type: 'state',
            common: { 
                name: 'Chat Historie HTML', 
                type: 'string', 
                role: 'html', 
                read: true, 
                write: false 
           },
          native: {}
         });
    });
}

/**
 * Fügt eine Nachricht zum JSON-Verlauf und HTML-String eines Kanals hinzu
 * @param {number} channelIdx - Index des Kanals (0, 1, 2...)
 * @param {string} senderName - Aufgelöster Name oder ID des Absenders
 * @param {string} messageText - Inhalt der Nachricht
 */
function addToHistory(channelIdx, senderName, messageText) {
    const basePath = '0_userdata.0.Meshtastic.Chats.' + channelIdx;
    const historyPath = basePath + '.history';
    const htmlPath = basePath + '.history_html';
    const maxEntries = 10; // Anzahl der gespeicherten Nachrichten
    
    // --- 1. JSON HISTORY (für Jarvis JsonTable) ---
    let history = [];
    if (existsState(historyPath)) {
        let currentState = getState(historyPath).val;
        try {
            history = JSON.parse(currentState) || [];
        } catch (e) { history = []; }
    }

    // Neues Objekt erstellen
    const newEntry = {
        ts: Date.now(),
        time: formatDate(new Date(), "hh:mm"),
        from: senderName,
        text: messageText
    };

    // Oben einfügen & Kürzen
    history.unshift(newEntry);
    if (history.length > maxEntries) history = history.slice(0, maxEntries);

    // JSON Speichern
    setState(historyPath, JSON.stringify(history), true);


    // --- 2. HTML HISTORY (für Jarvis StateHTML / Messenger-Look) ---
    let html = '<div style="display:flex; flex-direction:column; gap:10px; font-family:sans-serif;">';
    
    history.forEach(m => {
        html += `
        <div style="background:rgba(128,128,128,0.1); padding:8px 12px; border-radius:12px; border-left:4px solid #009688; max-width:95%;">
            <div style="font-size:0.75em; opacity:0.6; margin-bottom:4px;">
                <span style="font-weight:bold; color:#009688;">${m.from}</span> • ${m.time}
            </div>
            <div style="font-size:0.95em; line-height:1.3; word-wrap:break-word;">
                ${m.text}
            </div>
        </div>`;
    });
    
    html += '</div>';

    // HTML Datenpunkt prüfen und schreiben
    if (!existsState(htmlPath)) {
        setObject(htmlPath, {
            type: 'state',
            common: { name: 'Chat Historie HTML', type: 'string', role: 'html', read: true, write: false },
            native: {}
        });
        setTimeout(() => { setState(htmlPath, html, true); }, 200);
    } else {
        setState(htmlPath, html, true);
    }
}

// ======================================================
// 6. Command Listener + CLI Actions
// ======================================================
function registerEndpointListeners() {

    $('state[id=0_userdata.0.Meshtastic.Nodes.*.command.*]').each(function (id) {
        on({id: id, change: "any"}, function (obj) {

            let parts = obj.id.split(".");
            let nodeId = parts[4];
            let cmd = parts[6];

            if (cmd === "getTelemetry" || cmd === "getLocation") requestTelemetry(nodeId);
            if (cmd === "sendPing") sendPing(nodeId);
            if (cmd === "sendTraceRoute") startTraceroute(nodeId);

            if (cmd === "sendMessage") {
                let msg = getState(obj.id).val;
                sendDirectMessage(nodeId, msg);
            }
        });
    });

    $('state[id=0_userdata.0.Meshtastic.Chats.*.sendMessage]').each(function (id) {
        on({id: id, change: "any"}, function (obj) {
            let parts = obj.id.split(".");
            let chatId = parts[4];
            let msg = getState(obj.id).val;
            sendChatMessage(chatId, msg);
        });
    });
}

// --- CLI Actions ---
function requestTelemetry(target) {
    exec('/home/iobroker/.local/bin/meshtastic --host '+deviceIp+' --request-telemetry --dest "!'+target+'"');
}
function startTraceroute(target) {
    exec('/home/iobroker/.local/bin/meshtastic --host '+deviceIp+' --traceroute --dest "!'+target+'"');
}
function sendPing(target) {
    exec('/home/iobroker/.local/bin/meshtastic --host '+deviceIp+' --sendping --dest "!'+target+'"');
}
function sendDirectMessage(target, message) {
    exec('/home/iobroker/.local/bin/meshtastic --host '+deviceIp+' --dest "!'+target+'" --sendtext "'+message+'"');
}
function sendChatMessage(chatId, message) {
    exec('/home/iobroker/.local/bin/meshtastic --host '+deviceIp+' --ch-index '+chatId+' --sendtext "'+message+'"');
}

// ======================================================
// 6. INITIALISIERUNG & START
// ======================================================

// Erstellt die Grundstruktur (nur beim ersten Start relevant)
createChannels();
createChats();

// Erster Abruf der Nodes beim Skriptstart
setTimeout(function() {
    log("Meshtastic: Initialer Node-Abruf gestartet...");
    updateNodes();
}, 2000);

// Regelmäßiges Polling der Node-Liste (alle 5 Minuten)
setInterval(function() {
    log("Meshtastic: Geplanter Node-Abruf läuft...");
    updateNodes();
}, 300000);

log("Meshtastic: Skript erfolgreich initialisiert. MQTT-Trigger aktiv.");
