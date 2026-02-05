import sys
import json
import time
import logging
import paho.mqtt.client as mqtt
from meshtastic_mqtt_json import MeshtasticMQTT

# --- CHANNEL DATABASE ---
# Add all your channels here
CHANNELS = {
    "Puig":    {"index": 0, "key": "BASE64_KEY_1"},
    "Default": {"index": 1, "key": "BASE64_KEY_2"},
    "Privat":  {"index": 2, "key": "BASE64_KEY_3"}
}

# Get channel name from command line argument
if len(sys.argv) < 2 or sys.argv[1] not in CHANNELS:
    print(f"Usage: python3 decryptor.py <channel_name>")
    print(f"Available channels: {', '.join(CHANNELS.keys())}")
    sys.exit(1)

CHANNEL_NAME = sys.argv[1]
CHANNEL_INDEX = CHANNELS[CHANNEL_NAME]["index"]
CHANNEL_KEY = CHANNELS[CHANNEL_NAME]["key"]

# --- REST OF CONFIGURATION ---
LOCAL_BROKER = "mqtt"
LOCAL_PORT = 1883
LOCAL_USER = "user"
LOCAL_PASS = "pass"
REGION = "EU_868"
ENCRYPTED_ROOT = f"msh/{REGION}/2/e/"
SERVICE_BASE_PATH = f"service/Decryptor/{CHANNEL_NAME}"

# --- LOGGING SETUP ---
# Format includes the channel name for better clarity in journalctl
logging.basicConfig(
    level=logging.INFO, 
    format=f'%(asctime)s - [{CHANNEL_NAME}] - %(levelname)s - %(message)s'
)

# --- MQTT LOGGING HANDLER ---
# Forwards local log events to an MQTT topic for remote monitoring
class MQTTHandler(logging.Handler):
    def emit(self, record):
        try:
            # Only attempt publish if the publisher client is connected
            if 'publisher' in globals() and publisher.is_connected():
                log_entry = self.format(record)
                publisher.publish(f"{SERVICE_BASE_PATH}/log", log_entry)
        except Exception:
            pass

# --- LOCAL PUBLISHER SETUP ---
# Used for sending decrypted JSON data and service logs to ioBroker
publisher = mqtt.Client()
publisher.username_pw_set(LOCAL_USER, LOCAL_PASS)

# Attach the MQTT logger after the client object is created
logging.getLogger().addHandler(MQTTHandler())

def send_to_iobroker(sender_id_dec, msg_type, payload_data):
    """
    Constructs a Meshtastic-compatible JSON structure and publishes it locally.
    Target: msh/REGION/2/json/CHANNEL/!senderhex
    """
    sender_id_hex = hex(sender_id_dec)[2:].lower().zfill(8)
    topic = f"msh/{REGION}/2/json/{CHANNEL_NAME}/!{sender_id_hex}"
    
    full_payload = {
        "from": sender_id_dec,
        "channel": CHANNEL_INDEX,
        "type": msg_type,
        "payload": payload_data,
        "timestamp": int(time.time())
    }
    publisher.publish(topic, json.dumps(full_payload), qos=1)

# --- DECRYPTION CALLBACKS ---
def on_text_message(json_data):
    """Callback for incoming decrypted text messages."""
    msg_text = json_data["decoded"]["payload"]
    send_to_iobroker(json_data["from"], "text", {"text": msg_text})
    logging.info(f"Relayed Text from !{hex(json_data['from'])[2:]}: {msg_text}")

def on_position(json_data):
    """Callback for incoming decrypted position updates."""
    p = json_data["decoded"]["payload"]
    pos_payload = {
        "latitude_i": p.get("latitude_i"),
        "longitude_i": p.get("longitude_i"),
        "altitude": p.get("altitude")
    }
    send_to_iobroker(json_data["from"], "position", pos_payload)
    logging.info(f"Relayed Position from !{hex(json_data['from'])[2:]}")

# --- DECRYPTOR INITIALIZATION ---
# Using MeshtasticMQTT to handle encrypted MQTT streams
decryptor = MeshtasticMQTT()
decryptor.register_callback('TEXT_MESSAGE_APP', on_text_message)
decryptor.register_callback('POSITION_APP', on_position)

# Configure authentication for the internal decryptor client
if hasattr(decryptor, '_client'):
    decryptor._client.username_pw_set(LOCAL_USER, LOCAL_PASS)

# --- START SERVICE ---
try:
    logging.info(f"Connecting to local broker at {LOCAL_BROKER}...")
    publisher.connect(LOCAL_BROKER, LOCAL_PORT)
    publisher.loop_start()

    logging.info(f"Starting Decryptor service for channel '{CHANNEL_NAME}'...")
    decryptor.connect(
        LOCAL_BROKER, LOCAL_PORT, ENCRYPTED_ROOT, 
        CHANNEL_NAME, LOCAL_USER, LOCAL_PASS, CHANNEL_KEY
    )

    start_time = time.time()
    last_heartbeat = 0

    # --- MAIN MAINTENANCE LOOP ---
    while True:
        time.sleep(1)
        
        # Publish health status every 60 seconds
        if time.time() - last_heartbeat > 60:
            status = {
                "status": "online",
                "channel": CHANNEL_NAME,
                "uptime_seconds": int(time.time() - start_time),
                "timestamp": time.strftime('%Y-%m-%d %H:%M:%S')
            }
            publisher.publish(f"{SERVICE_BASE_PATH}/status", json.dumps(status), retain=True)
            last_heartbeat = time.time()

except KeyboardInterrupt:
    logging.info("Service stopped by user.")
except Exception as e:
    logging.error(f"Critical error in main loop: {e}")
finally:
    # Clean shutdown of MQTT connections
    publisher.loop_stop()
    publisher.disconnect()
