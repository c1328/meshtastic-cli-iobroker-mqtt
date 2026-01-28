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
  Nachrichtenempfang (LoRa & MQTT) direkt in ioBroker-Datenpunkten

- **Multi-Kanal Support**  
  Primary/Secondary Channels werden unterstützt

- **Trennung/Anbindung von öffentlichen MQTT Servern**  
  Verschiedene öffentliche MQTT Server anbinden und dabei gezielt private Kanäle nicht an öffentliche Server weiterleiten

---

## 📋 Voraussetzungen

- Meshtastic Gerät (LAN oder USB)  
- ioBroker mit JavaScript- und MQTT-Adapter  
- Python 3 + Meshtastic CLI  
- Mosquitto Broker als lokales MQTT-Gateway/Bridge 

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

MQTT + JSON aktivieren an der Node:

```bash
meshtastic --host <IP-of-your-meshtastic-node> --set mqtt.enabled true
meshtastic --host <IP-of-your-meshtastic-node> --set mqtt.json_enabled true
```

Zusätzlich muss natürlich die soeben konfigurierte Mosquitto Bridge in der Node konfiguriert werden mit Adresse, Port, Username und Password.

---

### 3. Mosquitto Bridge als Sicherheits-Gateway

- Private Channels bleiben lokal  
- Node kann nur an einen Broker angebunden werden, Mosquitto übernimmt hier die Verteilung an mehrere Server  
- Selektives Topic-Forwarding möglich  

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

### 4. Konfigurieren der MQTT Instanz in ioBroker

- Eine MQTT Instanz im ioBroker muss auf unsere Mosquitto Bridge konfiguriert werden
- IP, Port, Username und Password müssen auf die Bridge zeigen
- Das Topic ```msh/EU_868/2/json/#``` muss aboniert werden
- Die entstandene Instanz ist auch diejenige, die im folgenden Abschnitt konfiguriert werden muss

---

### 5. JS script in ioBroker anlegen und aktivieren

- Das Script meshcli_iobroker.js als JS in ioBroker anlegen und die Konfigurationen im oberen Abschnitt des Scripts an die eigenen Bedürfnisse anpassen
- Damit das Script Datenpunkte anlegen kann, muss "Enable command "setObject"" in der JS Instanz erlaubt werden

Beispiel:

```text
// Configuration of IP adress of meshtastic node that is connected via TCP
var deviceIp = '<IP-of-your-meshtastic-node>';
// Configuration of MQTT instance that is used (in my case 3rd instance)
var mqttPath = 'mqtt.3.msh.*.json.*'; 
// Configuration of channel names
var chats = [
    { name: 'Default', id: 0 },
    { name: '<private channel>', id: 1 },
    { name: '<public channel>', id: 2 }
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



---
## 📝 Lizenz

MIT License – frei erweiterbar und offen für Contributions.
