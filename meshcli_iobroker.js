// Meshtastic ioBroker Integration Kit (FINAL FIXED)
// - execFile statt exec (keine Shell-Injection / Quoting-Probleme)
// - mqttPath Variable wird genutzt
// - robuste senderHex Erzeugung
// - safeCreateObject / safeCreateState Wrapper
// - konstante Pfade / Intervalle
// - alle Funktionen aus deiner letzten Version enthalten
// - History JSON + HTML mit Escape
// - onStop Cleanup

// ======================================================
// CONFIG
// ======================================================
const deviceIp        = "192.168.1.xxx";
const mqttPath        = "mqtt.3.msh.*.json.*";

const MESHTASTIC_BIN  = "/home/iobroker/.local/bin/meshtastic";

const BASE            = "0_userdata.0.Meshtastic";
const NODES           = BASE + ".Nodes";
const CHATS           = BASE + ".Chats";

const POLL_INTERVAL   = 300000;
const HISTORY_MAX     = 10;

const chats = [
    { name: "Default",  id: 0 },
    { name: "Privat",   id: 1 },
    { name: "Public",   id: 2 }
];

// Node.js execFile verfügbar
const { execFile } = require("child_process");

// ======================================================
// RETRY HANDLING (Node offline / reboot)
// ======================================================
let retryCount = 0;
const RETRY_MAX   = 10;
const RETRY_DELAY = 10000;

function scheduleRetry(actionName) {
    retryCount++;

    if (retryCount > RETRY_MAX) {
        log("Meshtastic: Abbruch nach " + RETRY_MAX +
            " Fehlversuchen. Aktion fehlgeschlagen: " + actionName, "error");
        retryCount = 0;
        return;
    }

    log("Meshtastic: Node nicht erreichbar → Retry " +
        retryCount + "/" + RETRY_MAX +
        " in " + (RETRY_DELAY/1000) + "s (" + actionName + ")", "warn");

    setTimeout(() => {
        if (actionName === "updateNodes") updateNodes();
    }, RETRY_DELAY);
}

// ======================================================
// HELPERS
// ======================================================
function safeCreateObject(id, obj) {
    if (!existsObject(id)) {
        setObject(id, obj);
        log("Created object: " + id, "info");
    }
}

function safeCreateState(id, common) {
    if (!existsObject(id)) {
        safeCreateObject(id, {
            type: "state",
            common,
            native: {}
        });
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Robust senderHex conversion
function toSenderHex(fromField) {
    let raw = String(fromField || "").replace(/^!/, "");

    let hex;
    if (/^\d+$/.test(raw)) {
        hex = Number(raw).toString(16);
    } else {
        hex = raw.replace(/^0x/, "");
    }

    return hex.toLowerCase().padStart(8, "0");
}

// ======================================================
// CLI CALLS (with retry)
// ======================================================
function runMeshtastic(args, cb, attempt = 1) {
    execFile(MESHTASTIC_BIN, args, (err, stdout, stderr) => {

        if (err) {
            const actionName = args.join(" ");

            if (attempt <= RETRY_MAX) {
                log("Meshtastic offline → Retry " + attempt + "/" + RETRY_MAX +
                    " in 10s: " + actionName, "warn");

                setTimeout(() => {
                    runMeshtastic(args, cb, attempt + 1);
                }, RETRY_DELAY);

                return;
            }

            log("Meshtastic: Abbruch nach " + RETRY_MAX +
                " Versuchen. Aktion fehlgeschlagen: " + actionName +
                " | Error: " + (stderr || err), "error");

            if (cb) cb(err, stdout, stderr);
            return;
        }

        if (cb) cb(null, stdout, stderr);
    });
}

// ======================================================
// INIT STRUCTURE
// ======================================================
function createChannels() {
    safeCreateObject(BASE,  { type: "channel", common: { name: "Meshtastic" }, native: {} });
    safeCreateObject(NODES, { type: "channel", common: { name: "Nodes" }, native: {} });
    safeCreateObject(CHATS, { type: "channel", common: { name: "Chats" }, native: {} });
}

function createChats() {
    chats.forEach(c => {
        const base = CHATS + "." + c.id;

        safeCreateObject(base, {
            type: "channel",
            common: { name: c.name },
            native: {}
        });

        safeCreateState(base + ".lastMessage", {
            name: "Letzte Nachricht",
            type: "string",
            role: "text",
            read: true,
            write: false
        });

        safeCreateState(base + ".sendMessage", {
            name: "Nachricht senden",
            type: "string",
            role: "text",
            read: true,
            write: true
        });

        safeCreateState(base + ".history", {
            name: "Chat Historie JSON",
            type: "string",
            role: "json",
            read: true,
            write: false
        });

        safeCreateState(base + ".history_html", {
            name: "Chat Historie HTML",
            type: "string",
            role: "html",
            read: true,
            write: false
        });
    });
}

// ======================================================
// HISTORY
// ======================================================
function addToHistory(channelIdx, senderName, messageText) {
    const base = CHATS + "." + channelIdx;
    const historyPath = base + ".history";
    const htmlPath    = base + ".history_html";

    let history = [];
    if (existsState(historyPath)) {
        try {
            history = JSON.parse(getState(historyPath).val) || [];
        } catch {
            history = [];
        }
    }

    history.unshift({
        ts: Date.now(),
        time: formatDate(new Date(), "hh:mm"),
        from: senderName,
        text: messageText
    });

    if (history.length > HISTORY_MAX) {
        history = history.slice(0, HISTORY_MAX);
    }

    setState(historyPath, JSON.stringify(history), true);

    // HTML output (escaped)
    let html = `<div style="display:flex;flex-direction:column;gap:10px;font-family:sans-serif;">`;

    history.forEach(m => {
        html += `
        <div style="background:rgba(128,128,128,0.1);padding:8px 12px;border-radius:12px;max-width:95%;">
            <div style="font-size:0.75em;opacity:0.6;margin-bottom:4px;">
                <b>${escapeHtml(m.from)}</b> • ${escapeHtml(m.time)}
            </div>
            <div style="font-size:0.95em;line-height:1.3;">
                ${escapeHtml(m.text)}
            </div>
        </div>`;
    });

    html += `</div>`;
    setState(htmlPath, html, true);
}

// ======================================================
// MQTT TRIGGER (Realtime)
// ======================================================
on({ id: new RegExp("^" + mqttPath.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"), change: "any" }, obj => {
    try {
        if (!obj.state.val) return;

        const msg = JSON.parse(obj.state.val);

        const channelIdx = parseInt(msg.channel) || 0;
        const senderHex  = toSenderHex(msg.from);

        const nodeBase   = NODES + "." + senderHex;
        const infoBase   = nodeBase + ".info.";

        // Name resolution
        let displayName = senderHex;

        if (existsState(infoBase + "alias")) {
            const v = getState(infoBase + "alias").val;
            if (v && v !== "N/A") displayName = v;
        } else if (existsState(infoBase + "user")) {
            const v = getState(infoBase + "user").val;
            if (v && v !== "N/A") displayName = v;
        }

        // TEXT
        if (msg.type === "text" && msg.payload?.text) {
            const text = msg.payload.text;

            safeCreateState(infoBase + "lastMessage", {
                name: "Letzte Nachricht",
                type: "string",
                role: "text",
                read: true,
                write: false
            });

            setState(infoBase + "lastMessage", text, true);

            const chatBase = CHATS + "." + channelIdx;
            if (existsObject(chatBase)) {
                setState(chatBase + ".lastMessage", `${displayName}: ${text}`, true);
                addToHistory(channelIdx, displayName, text);
            }

            log(`Meshtastic Text [${channelIdx}] ${displayName}: ${text}`, "info");
        }

        // POSITION
        if (msg.type === "position" && msg.payload) {
            const p = msg.payload;
            if (p.latitude_i && p.longitude_i) {
                const lat = p.latitude_i / 10000000;
                const lon = p.longitude_i / 10000000;
                const alt = p.altitude || 0;

                setState(infoBase + "latitude", lat, true);
                setState(infoBase + "longitude", lon, true);
                setState(infoBase + "altitude", alt, true);
                setState(infoBase + "location", `${lat},${lon}`, true);

                log(`Meshtastic Position ${displayName}: ${lat},${lon}`, "info");
            }
        }

    } catch (e) {
        log("MQTT Trigger Fehler: " + e, "error");
    }
});

// ======================================================
// SEND MESSAGE TRIGGERS
// ======================================================

// Chat send
on({ id: /^0_userdata\.0\.Meshtastic\.Chats\.\d+\.sendMessage$/, change: "any" }, obj => {
    if (obj.state.ack) return;

    const msg = obj.state.val;
    if (!msg) return;

    const parts = obj.id.split(".");
    const channelId = Number(parts[parts.length - 2]);

    runMeshtastic(
        ["--host", deviceIp, "--ch-index", String(channelId), "--sendtext", msg],
        err => {
            if (!err) setTimeout(() => setState(obj.id, "", true), 300);
        }
    );
});

// Direct send
on({ id: /^0_userdata\.0\.Meshtastic\.Nodes\..*\.command\.sendMessage$/, change: "any", ack: false }, obj => {
    const msg = obj.state.val;
    if (!msg) return;

    const parts = obj.id.split(".");
    const nodeId = parts[parts.length - 3];

    runMeshtastic(
        ["--host", deviceIp, "--dest", "!" + nodeId, "--sendtext", msg],
        err => {
            if (!err) setTimeout(() => setState(obj.id, "", true), 300);
        }
    );
});

// ======================================================
// CLI NODE POLLING
// ======================================================
/**
 * Parst die CLI-Ausgabe von meshtastic --nodes in ein Array von Node-Objekten
 * @param {string} data - CLI-Ausgabe
 * @returns {Array<Object>} nodes
 */
function parseData(data) {
    const lines = data.trim().split('\n');

    // Header-Zeile finden (ID | User | …)
    const headerIndex = lines.findIndex(l => l.includes('│') && l.includes('ID'));
    if (headerIndex === -1) return [];

    // Header-Spalten extrahieren
    const keys = lines[headerIndex]
        .split('│')
        .map(k => k.trim())
        .filter((k, i) => i > 0 && i < lines[headerIndex].split('│').length - 1);

    // Zeilen filtern und Nodes erzeugen
    return lines
        .filter(l =>
            l.includes('│') &&
            !l.includes('═') &&       // Tabellenrahmen ausschließen
            !l.includes('─') &&
            !l.includes(' ID ') &&    // Header ausschließen
            !l.includes(' User ')     // optional: User-Header ausschließen
        )
        .map(line => {
            const values = line.split('│').map(v => v.trim()).slice(1, -1);

            if (values.length < keys.length) return null;

            let obj = {};
            keys.forEach((key, index) => {
                obj[key] = values[index] || "N/A";
            });

            // Node-ID normalisieren
            if (obj.ID) obj.ID = normalizeNodeId(obj.ID);

            // Nur gültige Node-IDs weitergeben
            if (!isValidNodeId(obj.ID)) return null;

            return obj;
        })
        .filter(obj => obj !== null);
}

/**
 * Normalisiert eine Node-ID (CLI oder MQTT)
 * @param {string} rawId
 * @returns {string} normalizedId (8-stellig hex, lowercase)
 */
function normalizeNodeId(rawId) {
    let id = String(rawId || "").replace(/^!/, "");
    if (/^\d+$/.test(id)) id = Number(id).toString(16);
    else id = id.replace(/^0x/, "");
    return id.toLowerCase().padStart(8, "0");
}

/**
 * Prüft, ob eine Node-ID gültig ist (8-stellige Hex)
 * @param {string} id
 * @returns {boolean}
 */
function isValidNodeId(id) {
    return /^[0-9a-f]{8}$/.test(id);
}

function nodeIsKnown(id) {
    return existsObject(NODES + "." + id);
}

function createNode(data) {
    safeCreateObject(NODES + "." + data.ID, {
        type: "channel",
        common: { name: data.User },
        native: {}
    });

    createNodeStates(data.ID);
}

function createNodeStates(id) {
    const base = NODES + "." + id;

    safeCreateObject(base + ".info", {
        type: "channel",
        common: { name: "Info" },
        native: {}
    });

    safeCreateObject(base + ".command", {
        type: "channel",
        common: { name: "Command" },
        native: {}
    });

    // Info states
    [
        ["alias", "Alias", "string", "text"],
        ["user", "User", "string", "text"],
        ["latitude", "Latitude", "number", "value.gps.latitude"],
        ["longitude", "Longitude", "number", "value.gps.longitude"],
        ["location", "Location", "string", "value.gps"],
        ["altitude", "Altitude", "number", "value"],
        ["battery", "Battery", "number", "value.battery"],
        ["lastMessage", "Letzte Nachricht", "string", "text"]
    ].forEach(s => {
        safeCreateState(base + ".info." + s[0], {
            name: s[1],
            type: s[2],
            role: s[3],
            read: true,
            write: false
        });
    });

    // Command states
    [
        ["sendMessage", "Direktnachricht senden", "string", "text"],
        ["sendPing", "Ping senden", "boolean", "button"],
        ["sendTraceRoute", "Traceroute starten", "boolean", "button"],
        ["getLocation", "Standort anfordern", "boolean", "button"],
        ["getTelemetry", "Telemetrie anfordern", "boolean", "button"]
    ].forEach(s => {
        safeCreateState(base + ".command." + s[0], {
            name: s[1],
            type: s[2],
            role: s[3],
            read: true,
            write: true
        });
    });
}

function updateNode(data) {
    function parseNum(val) {
        if (!val || val === "N/A" || val === "Powered") return 0;
        return parseFloat(String(val).replace(/[^\d.-]/g, "")) || 0;
    }

    const base = NODES + "." + data.ID + ".info.";

    setState(base + "user", data.User || "N/A", true);
    setState(base + "alias", data.AKA || "N/A", true);

    const lat = parseNum(data.Latitude);
    const lon = parseNum(data.Longitude);

    if (lat !== 0 && lon !== 0) {
        setState(base + "latitude", lat, true);
        setState(base + "longitude", lon, true);
        setState(base + "location", `${lat},${lon}`, true);
    }

    let battVal = data.Battery === "Powered" ? 100 : parseNum(data.Battery);
    setState(base + "battery", battVal, true);
}

// ======================================================
// UPDATE NODES (with retry)
// ======================================================
function updateNodes() {
    runMeshtastic(["--host", deviceIp, "--nodes"], (err, stdout) => {

        // Node offline / reboot → retry
        if (err || !stdout) {
            scheduleRetry("updateNodes");
            return;
        }

        // Erfolg → Retry Counter zurücksetzen
        retryCount = 0;

        const nodes = parseData(stdout);
        if (!nodes.length) return;

        nodes.forEach(n => {
            n.ID = normalizeNodeId(n.ID);

            if (!nodeIsKnown(n.ID)) createNode(n);
            updateNode(n);
        });
    });
}

// ======================================================
// CLI ACTIONS (ALL INCLUDED)
// ======================================================
function requestTelemetry(target) {
    runMeshtastic(["--host", deviceIp, "--request-telemetry", "--dest", "!" + target]);
}

function startTraceroute(target) {
    runMeshtastic(["--host", deviceIp, "--traceroute", "--dest", "!" + target]);
}

function sendPing(target) {
    runMeshtastic(["--host", deviceIp, "--sendping", "--dest", "!" + target]);
}

function sendDirectMessage(target, message) {
    runMeshtastic(["--host", deviceIp, "--dest", "!" + target, "--sendtext", message]);
}

function sendChatMessage(chatId, message) {
    runMeshtastic(["--host", deviceIp, "--ch-index", String(chatId), "--sendtext", message]);
}

// ======================================================
// COMMAND BUTTON LISTENERS
// ======================================================
on({ id: /^0_userdata\.0\.Meshtastic\.Nodes\..*\.command\.(sendPing|sendTraceRoute|getLocation|getTelemetry)$/, change: "any" }, obj => {
    if (obj.state.ack) return;
    if (obj.state.val !== true) return;

    const parts = obj.id.split(".");
    const nodeId = parts[4];
    const cmd = parts[6];

    if (cmd === "sendPing") sendPing(nodeId);
    if (cmd === "sendTraceRoute") startTraceroute(nodeId);
    if (cmd === "getLocation" || cmd === "getTelemetry") requestTelemetry(nodeId);

    setTimeout(() => setState(obj.id, false, true), 300);
});

// ======================================================
// STARTUP
// ======================================================
createChannels();
createChats();

log("Meshtastic: Initialisierung abgeschlossen.", "info");

setTimeout(() => updateNodes(), 2000);

const pollInterval = setInterval(() => {
    log("Meshtastic: Node Polling...", "info");
    updateNodes();
}, POLL_INTERVAL);

onStop(() => {
    clearInterval(pollInterval);
    log("Meshtastic: Script stopped, interval cleared.", "info");
}, 1000);
