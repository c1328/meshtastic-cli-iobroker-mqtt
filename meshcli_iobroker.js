// Meshtastic ioBroker Integration Kit
// Idea based on https://forum.iobroker.net/topic/73326/meshtastic/2

// ======================================================
// CONFIG
// ======================================================

// IP of your Meshtastic node
const deviceIp  = "192.168.1.x";

// MQTT path variable (note the 3 because I use the 3rd instance of mqtt at IoBroker)
const mqttPath  = /^mqtt\.3\.msh\..*\.json\..*$/;

// configure the channels of your node
const chats = [
    { name: "Default",  id: 0 },
    { name: "<private Channel>",     id: 1 },
    { name: "<public Channel>", id: 2 }
];

// Base paths (usualy no adjustment needed)
const BASE   = "0_userdata.0.Meshtastic";
const NODES  = BASE + ".Nodes";
const CHATS  = BASE + ".Chats";

// ======================================================
// HELPERS
// ======================================================
function safeCreateObject(id, obj) {
    if (!existsObject(id)) setObject(id, obj);
}

function safeCreateState(id, common) {
    if (!existsObject(id)) {
        setObject(id, { type: "state", common: common, native: {} });
    }
}

function safeSetState(id, val) {
    if (existsObject(id)) setState(id, val, true);
}

function shellSafe(msg) {
    if (!msg) return "";
    return msg.replace(/'/g, "").replace(/"/g, '\\"');
}

function parseNum(val) {
    if (!val || val === "N/A" || val === "Powered") return 0;
    return parseFloat(String(val).replace(/[^\d.-]/g, "")) || 0;
}

// ======================================================
// 1. MQTT TRIGGER (Realtime Chat + Name Resolution)
// ======================================================
on({ id: mqttPath, change: "any" }, function (obj) {
    try {
        if (!obj.state.val) return;
        const msg = JSON.parse(obj.state.val);

        const channelIdx = parseInt(msg.channel) || 0;

        // sender hex
        let senderHex = parseInt(msg.from)
            .toString(16)
            .toLowerCase()
            .replace("!", "")
            .padStart(8, "0");

        const nodeBasePath = `${NODES}.${senderHex}`;

        // Name resolution
        let displayName = senderHex;

        if (existsState(nodeBasePath + ".info.alias")) {
            let aliasVal = getState(nodeBasePath + ".info.alias").val;
            if (aliasVal && aliasVal !== "N/A") displayName = aliasVal;
        } else if (existsState(nodeBasePath + ".info.user")) {
            let userVal = getState(nodeBasePath + ".info.user").val;
            if (userVal && userVal !== "N/A") displayName = userVal;
        }

        // --- TEXT MESSAGE ---
        if (msg.type === "text" && msg.payload?.text) {
            const text = msg.payload.text;

            // Node lastMessage
            safeCreateState(nodeBasePath + ".info.lastMessage", {
                name: "Letzte Nachricht",
                type: "string",
                role: "text",
                read: true,
                write: false
            });
            safeSetState(nodeBasePath + ".info.lastMessage", text);

            // Chat lastMessage + history
            const chatPath = `${CHATS}.${channelIdx}`;
            if (existsObject(chatPath)) {
                safeSetState(chatPath + ".lastMessage", `${displayName}: ${text}`);
                addToHistory(channelIdx, displayName, text);
            }

            log(`Meshtastic Text: [${channelIdx}] ${displayName}: ${text}`);

        }

        // --- POSITION ---
        else if (msg.type === "position" && msg.payload) {
            const p = msg.payload;

            if (p.latitude_i && p.longitude_i) {
                const lat = p.latitude_i / 10000000;
                const lon = p.longitude_i / 10000000;
                const alt = p.altitude || 0;

                safeSetState(nodeBasePath + ".info.latitude", lat);
                safeSetState(nodeBasePath + ".info.longitude", lon);
                safeSetState(nodeBasePath + ".info.altitude", alt);
                safeSetState(nodeBasePath + ".info.location", `${lat},${lon}`);

                log(`Meshtastic Position: ${displayName} @ ${lat},${lon}`);
            }
        }

    } catch (e) {
        log("Fehler im MQTT Trigger: " + e, "error");
    }
});

// ======================================================
// 2. SEND MESSAGE TO CHAT CHANNELS
// ======================================================
on({ id: new RegExp("^" + CHATS.replace(/\./g, "\\.") + "\\.\\d+\\.sendMessage$"), change: "any" },
function (obj) {

    if (obj.state.ack) return;
    const msg = obj.state.val;
    if (!msg) return;

    const parts = obj.id.split(".");
    const channelId = parseInt(parts[parts.length - 2]);

    const safeMsg = shellSafe(msg);

    log(`Meshtastic: Send Chat ${channelId}: ${safeMsg}`);

    exec(`/home/iobroker/.local/bin/meshtastic --host ${deviceIp} --ch-index ${channelId} --sendtext '${safeMsg}'`,
        function (error, stdout, stderr) {
            if (error) log("Send error: " + (stderr || error), "error");
            else setTimeout(() => setState(obj.id, "", true), 300);
        }
    );
});

// ======================================================
// 3. SEND DIRECT MESSAGE TO NODE
// ======================================================
on({ id: new RegExp("^" + NODES.replace(/\./g, "\\.") + "\\..*\\.command\\.sendMessage$"), change: "any", ack: false },
function (obj) {

    const msg = obj.state.val;
    if (!msg) return;

    const nodeId = obj.id.split(".")[4];
    const safeMsg = shellSafe(msg);

    log(`Meshtastic: Direct to !${nodeId}: ${safeMsg}`);

    exec(`/home/iobroker/.local/bin/meshtastic --host ${deviceIp} --dest "!${nodeId}" --sendtext "${safeMsg}"`,
        function (error) {
            if (!error) setTimeout(() => setState(obj.id, "", true), 300);
        }
    );
});

// ======================================================
// 4. NODE COMMAND BUTTONS (Ping/Traceroute/Telemetry/Location)
// ======================================================
function cliAction(target, cmd) {
    exec(`/home/iobroker/.local/bin/meshtastic --host ${deviceIp} ${cmd} --dest "!${target}"`);
}

// Ping
on({ id: new RegExp("^" + NODES.replace(/\./g, "\\.") + "\\..*\\.command\\.sendPing$"), change: "any" },
obj => {
    if (obj.state.ack || !obj.state.val) return;
    const nodeId = obj.id.split(".")[4];
    cliAction(nodeId, "--sendping");
    setState(obj.id, false, true);
});

// Traceroute
on({ id: new RegExp("^" + NODES.replace(/\./g, "\\.") + "\\..*\\.command\\.sendTraceRoute$"), change: "any" },
obj => {
    if (obj.state.ack || !obj.state.val) return;
    const nodeId = obj.id.split(".")[4];
    cliAction(nodeId, "--traceroute");
    setState(obj.id, false, true);
});

// Telemetry
on({ id: new RegExp("^" + NODES.replace(/\./g, "\\.") + "\\..*\\.command\\.getTelemetry$"), change: "any" },
obj => {
    if (obj.state.ack || !obj.state.val) return;
    const nodeId = obj.id.split(".")[4];
    cliAction(nodeId, "--request-telemetry");
    setState(obj.id, false, true);
});

// Location request
on({ id: new RegExp("^" + NODES.replace(/\./g, "\\.") + "\\..*\\.command\\.getLocation$"), change: "any" },
obj => {
    if (obj.state.ack || !obj.state.val) return;
    const nodeId = obj.id.split(".")[4];
    cliAction(nodeId, "--request-position");
    setState(obj.id, false, true);
});

// ======================================================
// 5. NODE POLLING (CLI --nodes)
// ======================================================
function updateNodes() {
    exec(`/home/iobroker/.local/bin/meshtastic --host ${deviceIp} --nodes`,
        function (error, result) {
            if (!result || !result.includes("Connected")) return;
            const nodes = parseData(result);
            handleNodes(nodes);
        }
    );
}

function handleNodes(nodes) {
    nodes.forEach(node => {
        node.ID = node.ID.replace("!", "");
        if (!nodeIsKnown(node.ID)) {
            createNode(node);
            setTimeout(() => updateNode(node), 2000);
        } else {
            updateNode(node);
        }
    });
}

function nodeIsKnown(id) {
    return !!getObject(`${NODES}.${id}`);
}

function parseData(data) {
    const lines = data.trim().split("\n");
    const headerIndex = lines.findIndex(l => l.includes("│") && l.includes("ID"));
    if (headerIndex === -1) return [];

    const keys = lines[headerIndex]
        .split("│")
        .map(k => k.trim())
        .filter((k, i, arr) => i > 0 && i < arr.length - 1);

    return lines
        .filter(l => l.includes("│") && !l.includes("═") && !l.includes("─") && !l.includes(" User "))
        .map(line => {
            let values = line.split("│").map(v => v.trim()).slice(1, -1);
            if (values.length < keys.length) return null;
            let obj = {};
            keys.forEach((key, i) => obj[key] = values[i] || "N/A");
            return obj;
        })
        .filter(x => x);
}

// ======================================================
// 6. NODE CREATION + STATES
// ======================================================
function createNode(data) {
    safeCreateObject(`${NODES}.${data.ID}`, {
        type: "channel",
        common: { name: data.User },
        native: {}
    });

    createNodeStates(data.ID);
}

function createNodeStates(id) {

    safeCreateObject(`${NODES}.${id}.info`, {
        type: "channel",
        common: { name: "Info" },
        native: {}
    });

    safeCreateObject(`${NODES}.${id}.command`, {
        type: "channel",
        common: { name: "Command" },
        native: {}
    });

    // Info states
    [
        ["user","User","string"],
        ["alias","Alias","string"],
        ["location","Location","string"],
        ["latitude","Latitude","number"],
        ["longitude","Longitude","number"],
        ["altitude","Altitude","number"],
        ["battery","Battery","number"],
        ["lastMessage","Letzte Nachricht","string"]
    ].forEach(s => {
        safeCreateState(`${NODES}.${id}.info.${s[0]}`, {
            name: s[1], type: s[2], read: true, write: false
        });
    });

    // Command states
    [
        ["sendMessage","Direktnachricht senden","string","text"],
        ["sendPing","Ping senden","boolean","button"],
        ["sendTraceRoute","Traceroute starten","boolean","button"],
        ["getLocation","Standort anfordern","boolean","button"],
        ["getTelemetry","Telemetrie anfordern","boolean","button"]
    ].forEach(s => {
        safeCreateState(`${NODES}.${id}.command.${s[0]}`, {
            name: s[1], type: s[2], role: s[3], read: true, write: true
        });
    });
}

// ======================================================
// 7. UPDATE NODE VALUES
// ======================================================
function updateNode(data) {

    const path = `${NODES}.${data.ID}.info.`;

    safeSetState(path + "user", data.User || "N/A");
    safeSetState(path + "alias", data.AKA || "N/A");

    let lat = parseNum(data.Latitude);
    let lon = parseNum(data.Longitude);

    if (lat !== 0 && lon !== 0) {
        safeSetState(path + "latitude", lat);
        safeSetState(path + "longitude", lon);
        safeSetState(path + "location", lat + "," + lon);
    }

    let battVal = data.Battery === "Powered" ? 100 : parseNum(data.Battery);
    safeSetState(path + "battery", battVal);
}

// ======================================================
// 8. CHAT STRUCTURE + HISTORY
// ======================================================
function createChannels() {
    safeCreateObject(BASE,  { type: "channel", common: { name: "Meshtastic" }, native: {} });
    safeCreateObject(NODES, { type: "channel", common: { name: "Nodes" }, native: {} });
    safeCreateObject(CHATS, { type: "channel", common: { name: "Chats" }, native: {} });
}

function createChats() {
    chats.forEach(c => {
        safeCreateObject(`${CHATS}.${c.id}`, {
            type: "channel",
            common: { name: c.name },
            native: {}
        });

        safeCreateState(`${CHATS}.${c.id}.lastMessage`, {
            name: "Letzte Nachricht",
            type: "string",
            role: "text",
            read: true,
            write: false
        });

        safeCreateState(`${CHATS}.${c.id}.sendMessage`, {
            name: "Nachricht senden",
            type: "string",
            role: "text",
            read: true,
            write: true
        });

        safeCreateState(`${CHATS}.${c.id}.history`, {
            name: "Chat Historie JSON",
            type: "string",
            role: "json",
            read: true,
            write: false
        });

        safeCreateState(`${CHATS}.${c.id}.history_html`, {
            name: "Chat Historie HTML",
            type: "string",
            role: "html",
            read: true,
            write: false
        });
    });
}

function addToHistory(channelIdx, senderName, messageText) {
    const basePath = `${CHATS}.${channelIdx}`;
    const historyPath = basePath + ".history";
    const htmlPath    = basePath + ".history_html";
    const maxEntries  = 10;

    let history = [];
    if (existsState(historyPath)) {
        try { history = JSON.parse(getState(historyPath).val) || []; }
        catch { history = []; }
    }

    history.unshift({
        ts: Date.now(),
        time: formatDate(new Date(), "hh:mm"),
        from: senderName,
        text: messageText
    });

    if (history.length > maxEntries) history = history.slice(0, maxEntries);

    safeSetState(historyPath, JSON.stringify(history));

    let html = `<div style="display:flex;flex-direction:column;gap:8px;">`;
    history.forEach(m => {
        html += `<div style="padding:6px 10px;border-radius:10px;background:rgba(128,128,128,0.1);">
            <b>${m.from}</b> • ${m.time}<br>${m.text}</div>`;
    });
    html += `</div>`;

    safeSetState(htmlPath, html);
}

// ======================================================
// INIT
// ======================================================
createChannels();
createChats();

setTimeout(() => {
    log("Meshtastic: Initial Node Poll...");
    updateNodes();
}, 2000);

setInterval(() => {
    log("Meshtastic: Scheduled Node Poll...");
    updateNodes();
}, 300000);

log("Meshtastic: Script fully loaded (MQTT + CLI + Commands).");
