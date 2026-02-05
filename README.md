# Meshtastic ioBroker Integration Kit

Dieses Projekt ermöglicht die Einbindung von **Meshtastic-Nodes** in das **ioBroker-Ökosystem**.  
Es kombiniert die Meshtastic-CLI für Geräteverwaltung mit einer **Mosquitto MQTT-Bridge** für Echtzeit-Nachrichten und sichere Topic-Isolation.

Die Basis der Idee entstammt dieser Diskussion: https://forum.iobroker.net/topic/73326/meshtastic/4

---

## 🚀 Einleitung

Ziel ist es, Meshtastic-Netzwerke in ioBroker sichtbar und steuerbar zu machen:

- **Node-Status** via CLI  
  Batterie, SNR, LastHeard, Telemetrie, u.v.m.

- **Node-Actions** via CLI  
  send TraceRoute, Ping, Message, u.v.m.

- **Echtzeit-Chat** via MQTT  
  Nachrichtenempfang und Sendung (LoRa & MQTT) direkt in ioBroker-Datenpunkten

- **Multi-Kanal Support**  
  Primary/Secondary Channels werden unterstützt

- **Trennung/Anbindung von öffentlichen MQTT Servern**  
  Verschiedene öffentliche MQTT Server anbinden und dabei gezielt private Kanäle nicht an öffentliche Server weiterleiten

---

## 📋 Voraussetzungen

- Meshtastic Gerät (LAN oder USB) -> Mein Szenario: Heltec V3 mit Meshtastic Firmware 2.7.18 angebunden über WLAN
- ioBroker mit JavaScript- und MQTT-Adapter -> Mein Szenario: ioBroker v7.7.22 mit JS adapter 9.0.11
- Python 3 + Meshtastic CLI -> Mein Szenario: Debian Bookworm mit Python 3.11 und meshtastic cli 2.7.7
- Mosquitto Broker als lokales MQTT-Gateway/Bridge -> Mein Szenario: Mosquitto 2.0.11 aus dem Standard Debian Repo
- Meshtastic MQTT Parser für Nachrichten die über einen öffentlichen MQTT kommen, denn die werden von der Node ja nicht nochmal als entschlüsseltes JSON zurückgegeben -> Mein Szenarion: https://github.com/acidvegas/meshtastic-mqtt-json R2.0.0 auf dem Server hinterlegt, auf dem auch die Mosquitto Bridge läuft

---

## 🛠 Installation & Konfiguration

### 1. Meshtastic CLI installieren

- Der Meshtastic-Cli sollte mit dem gleichen user installiert werden, mit dem auch der ioBroker läuft

```bash
pip3 install --upgrade meshtastic
```
Installation und Verbindung prüfen:
```bash
meshtastic --host <IP-of-your-meshtastic-node> --info
```

---

### 2. Mosquitto MQTT Bridge konfigurieren

- Mosquitto installieren falls noch nicht vorhanden
- Sofern die Funktion der MQTT Bridge gar nicht gewünscht ist, kann natürlich auch der MQTT Broker vom ioBroker in der Node konfiguriert werden, aber dann lassen sich keine weiteren (öffentlichen) MQTT Server anbinden.

Beispiel: `/etc/mosquitto/meshtastic.conf`

```text
allow_anonymous false
listener 1883 0.0.0.0
pid_file /var/run/mosquitto/mosquitto.pid
persistence true
persistence_location /var/lib/mosquitto/
log_dest file /var/log/mosquitto/mosquitto.log
include_dir /etc/mosquitto/conf.d
password_file /etc/mosquitto/pwfile
```

Mosquitto muss nach der Konfiguration natürlich neu gestartet werden.

```bash
systemctl restart mosquitto.service
```

Auf der Node nun MQTT aktivieren + JSON deaktivieren:

```bash
meshtastic --host <IP-of-your-meshtastic-node> --set mqtt.enabled true
```

Da der Meshtastic-MQTT-Parser uns perfekt formatierte Nachrichten und Positionsdaten liefert können wir JSON auf der Node deaktivieren - das spart auf der Node auch etwas Ressourcen

```bash
meshtastic --host <IP-of-your-meshtastic-node> --set mqtt.json_enabled false
```

Zusätzlich muss natürlich die soeben konfigurierte Mosquitto Bridge auf der Node konfiguriert werden mit Adresse, Port und ggf. Username und Password.

---

### 3. Mosquitto Bridge als Sicherheits-Gateway

- Private Channels bleiben lokal  
- Node kann nur an einen Broker angebunden werden, Mosquitto übernimmt hier die Verteilung an mehrere Server  
- Selektives Topic-Forwarding möglich

```bash
apt install mosquitto-clients 
```

Beispiel für: `/etc/mosquitto/conf.d/mqtt.meshtastic.org.conf`

```text
connection mqtt_meshtastic.org
address mqtt.meshtastic.es:1883
# this remote_clientid must be unique so make it unique :-)
remote_clientid msh-iob-mqtt-org-<any 3-digit number>

# Username and password for the upstream server
remote_username meshdev
remote_password large4cats

# MQTT version to use
bridge_protocol_version mqttv311

# Forward public traffic to the remote server - don't list here something you don't want to share to public MQTT servers
topic msh/EU_868/2/e/LongFast/# both 0
topic msh/EU_868/2/e/<any other public channel>/# both 0

# Enable encryption
use_identity_as_username false
bridge_insecure true
#bridge_cafile /etc/ssl/certs/ca-certificates.crt

# Bridge settings to manage the connection
cleansession true
notifications false
start_type automatic
try_private true
restart_timeout 10
```

Mosquitto muss nach der Konfiguration natürlich neu gestartet werden.

```bash
systemctl restart mosquitto.service
```

---

### 4. Meshtastic MQTT Parser installieren

- Der Meshtastic MQTT Parser wird auf dem gleichen Server installiert, wo auch der zuvor installierte Mosquitto Server läuft. Hier das GitHub Repo: https://github.com/acidvegas/meshtastic-mqtt-json

```bash
pip install meshtastic-mqtt-json
```

- Wir brauchen ein kleines Python Script, welches uns die Nachrichten und Positionsdaten, die verschlüsselt über einen öffentlichen MQTT Server unter msh/EU_868/2/e/<channel>/ kommen, entschlüsselt und in der gleichen Form unter msh/EU_868/2/json/<channel> ablegt wie es eine Meshtastic Node tun würde.
- Die restlichen restlichen Telemetriedaten sind nicht so zeitkritisch und können zyklisch über den meshtastic-cli geholt werden.
- Je Kanal der gelesen werden soll wird eine entsprechend konfigurierte Datei gebraucht. Beispiel: [mqtt-json-parse.py](https://github.com/c1328/meshtastic-cli-iobroker-mqtt/blob/main/mqtt-json-parse.py)

Das Script kann für den Test mit Screen im Hintergrund laufen lassen:

```bash
screen -S <channel-name>
python <scriptname.py>
CTRL-A-D
```

---

### 5. Konfigurieren der MQTT Instanz in ioBroker

- Eine MQTT Instanz im ioBroker muss auf unsere Mosquitto Bridge konfiguriert werden
- IP, Port, Username und Password müssen auf die Bridge zeigen
- Das Topic ```msh/EU_868/2/json/#``` muss aboniert werden
- Die entstandene Instanz ist auch diejenige, die im folgenden Abschnitt konfiguriert werden muss

---

### 6. JS script in ioBroker anlegen und aktivieren

- Das Script meshcli_iobroker.js als JS in ioBroker anlegen und die Konfigurationen im oberen Abschnitt des Scripts an die eigenen Bedürfnisse anpassen
- Damit das Script Datenpunkte anlegen kann, muss "Enable command "setObject"" in der JS Instanz erlaubt werden

Beispiel:

```text
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
    { name: "<private Channel>",     id: 1 },
    { name: "<public Channel>", id: 2 }
];
```

---

## 📂 Datenstruktur in ioBroker

- beim ersten Start erzeugt das Script zahlreiche neue Datenpunkte nach folgender Struktur

```
0_userdata.0.Meshtastic
├── Nodes/
│   ├── Node123/
│   │   ├── info/
│   │   │   ├── command/
│   │   │   ├── battery
│   │   │   ├── snr
│   │   │   ├── lastHeard
│   │   │   ├── lastMessage
│   │   │   ├── ...
│   │   └── command/
│   │       ├── sendMessage
│   │       ├── sendTraceRoute
│           ├── ...
└── Chats/
    ├── Channel0/
    ├── Channel1/
    └── Channel2/
          ├── lastMessage
          └── sendMessage
```

## ⚙️ Funktionsweise des Skripts

Das Skript arbeitet hybrid:
- Polling (CLI): Alle 5 Minuten wird meshtastic --nodes aufgerufen, um die Node-Tabelle zu parsen (Einstellung im Script: ```setInterval(updateNodes, 300000);``` )
- Event-Driven (MQTT): Eintreffende Nachrichten lösen einen Trigger aus, der sofort den lastMessage-Datenpunkt aktualisiert und den Kurznamen (Alias) des Senders auflöst.

## 🧪 Fehlerbehebung

- Node wird nicht gefunden: Das Skript benötigt einen ersten Durchlauf der CLI, um die Node-Ordner anzulegen, bevor MQTT-Nachrichten zugeordnet werden können.
- Kein JSON über MQTT: Prüfe mit einem Tool wie MQTT Explorer, ob unter ```msh/EU_868/2/json/...``` wirklich Daten ankommen.
- CLI Pfad: Stelle sicher, dass der Pfad zur CLI im Skript (/home/iobroker/.local/bin/meshtastic) korrekt ist. Nutze ```which meshtastic``` in der Konsole, um den Pfad zu finden.

---

## ✅ Ergebnis

** Datenschutz: Private Chats verlassen niemals dein Netzwerk

** Flexibilität: ioBroker sieht alles lokal

** Performance: keine Abhängigkeit von langsamen Public-Brokern

** Integration: Senden und Empfangen beliebiger Nachrichten bzw. Steuermöglichkeit des ioBroker durch Nachrichten

** Visualisierung in VIS/Jarvis: Sowohl die Positionen als auch der Chatverlauf kann über die History bzw. History-HTML Datenpunkte leicht visualiert werden

---

## ❌ Einschränkung

Dieses Setup optimiert die Erfassung von Gruppen-Kanälen und Positionsdaten. Direktnachrichten (DMs) werden aufgrund der Ende-zu-Ende-Verschlüsselung (PKC) bewusst nicht unterstützt. Für private Kommunikation im ioBroker empfiehlt sich die Nutzung eines separaten, privaten Kanals.

Prototypisch gibt es folgendes Script, welches verschlüsselte Direktnachrichten, die an Nodes aus der eigenen DB gerichtet sind und verschlüsselt über MQTT daherkommen über Lora weiterleitet: https://github.com/c1328/meshtastic-cli-iobroker-mqtt/blob/main/mqtt-pki-downlink.py

Das Script sollte als systemd eingerichtet werden, dass schreibt es seinen Status in das MQTT topic ```service/PKIdownlink/#```

Hier ist gerne Rückmeldung erwünscht, ob das zuverlässig funktioniert.

---
## 📝 Lizenz

MIT License – frei erweiterbar und offen für Contributions.
