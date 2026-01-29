import json
import time
import paho.mqtt.client as mqtt
from meshtastic_mqtt_json import MeshtasticMQTT

# --- KONFIGURATION ---
LOCAL_BROKER = "<ip-of-your-mosquitto-server"
LOCAL_PORT = 1883
LOCAL_USER = "<username>"
LOCAL_PASS = "<password>"

# Kanal-Details
CHANNEL_NAME = "<channel-name>"
CHANNEL_INDEX = <channel-id/numer>
CHANNEL_KEY = "<channel-key>"
REGION = "EU_868"
ENCRYPTED_ROOT = f"msh/{REGION}/2/e/"

# --- SETUP LOKALER PUBLISHER ---
publisher = mqtt.Client()
publisher.username_pw_set(LOCAL_USER, LOCAL_PASS)
publisher.connect(LOCAL_BROKER, LOCAL_PORT)
publisher.loop_start()

def send_to_iobroker(sender_id_dec, msg_type, payload_data):
    """Baut das Meshtastic-JSON-Format nach und sendet es lokal."""
    sender_id_hex = hex(sender_id_dec)[2:].lower().zfill(8)
    # Ziel-Topic für den ioBroker JavaScript-Trigger
    topic = f"msh/{REGION}/2/json/{CHANNEL_NAME}/!{sender_id_hex}"
    
    full_payload = {
        "from": sender_id_dec,
        "channel": CHANNEL_INDEX,
        "type": msg_type,
        "payload": payload_data,
        "timestamp": int(time.time())
    }
    publisher.publish(topic, json.dumps(full_payload), qos=1)

# --- CALLBACKS ---

def on_text_message(json_data):
    """Verarbeitet reine Textnachrichten."""
    # json_data["decoded"]["payload"] enthält bei Textnachrichten den String
    send_to_iobroker(json_data["from"], "text", {"text": json_data["decoded"]["payload"]})
    print(f'Relayed Text: {json_data["decoded"]["payload"]}')

def on_position(json_data):
    """Verarbeitet GPS-Positionen."""
    # json_data["decoded"]["payload"] enthält hier das Positions-Objekt
    p = json_data["decoded"]["payload"]
    
    # Payload-Struktur für dein ioBroker-Skript aufbauen
    # Meshtastic nutzt oft latitude_i (Integer) statt Float für Präzision
    pos_payload = {
        "latitude_i": p.get("latitude_i"),
        "longitude_i": p.get("longitude_i"),
        "altitude": p.get("altitude")
    }
    
    send_to_iobroker(json_data["from"], "position", pos_payload)
    print(f'Relayed Position Update from {json_data["from"]}')

# --- SETUP DECRYPTOR ---
decryptor = MeshtasticMQTT()

# Registrierung der gewünschten Callbacks
decryptor.register_callback('TEXT_MESSAGE_APP', on_text_message)
decryptor.register_callback('POSITION_APP', on_position)

# Authentifizierung am internen Client setzen
if hasattr(decryptor, '_client'):
    decryptor._client.username_pw_set(LOCAL_USER, LOCAL_PASS)

# Verbindung zum lokalen Broker herstellen
decryptor.connect(
    LOCAL_BROKER,
    LOCAL_PORT,
    ENCRYPTED_ROOT,
    CHANNEL_NAME,
    LOCAL_USER,
    LOCAL_PASS,
    CHANNEL_KEY
)
