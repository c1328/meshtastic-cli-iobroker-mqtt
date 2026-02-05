import paho.mqtt.client as mqtt
import meshtastic.tcp_interface
from meshtastic import portnums_pb2
import logging
import time
import sys
import threading
import os
import json

# --- 0. RECONNECT HOOK ---
# This hook ensures the script exits completely if a background thread crashes 
# (e.g., BrokenPipeError). systemd will then trigger a clean restart.
def or_die(args):
    logging.error(f"CRITICAL THREAD CRASH: {args.exc_value}")
    os._exit(1) 

threading.excepthook = or_die

# --- CONFIGURATION ---
MQTT_BROKER     = "<IP or hostname>"
MQTT_USER       = "<user>"
MQTT_PW         = "<password>"
MQTT_TOPIC      = "msh/EU_868/2/e/PKI/#"
NODE_IP         = "<IP of your node>"
MAX_AGE_HOURS   = 12  # Only serve nodes active within the last X hours

# --- MQTT LOGGING HANDLER ---
# Forwards Python logging records to an MQTT topic for remote monitoring in ioBroker.
class MQTTHandler(logging.Handler):
    def emit(self, record):
        try:
            if 'client' in globals() and client.is_connected():
                log_entry = self.format(record)
                client.publish("service/PKIdownlink/log", log_entry)
        except Exception:
            pass # Avoid infinite loops if MQTT publish fails

# Logging Setup (Console)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# --- 1. MESHTASTIC INTERFACE INITIALIZATION ---
logging.info(f"Connecting to Meshtastic node at {NODE_IP}...")
try:
    interface = meshtastic.tcp_interface.TCPInterface(hostname=NODE_IP)
    time.sleep(5) # Wait for NodeDB synchronization
    if interface.myInfo:
        my_id = interface.myInfo.my_node_num
        logging.info(f"TCP Connection established. My ID: !{my_id:08x}")
    else:
        logging.warning("Connected, but myInfo not loaded. Restarting...")
        sys.exit(1)
except Exception as e:
    logging.error(f"Failed to connect to Meshtastic node: {e}")
    sys.exit(1)

# --- 2. INITIAL WIFI STATUS CHECK ---
if interface.nodes:
    my_node = interface.nodes.get(interface.myInfo.my_node_num)
    if my_node:
        metrics = my_node.get("deviceMetrics", {})
        rssi = metrics.get("rssi") or my_node.get("stats", {}).get("signalStrength")
        
        if rssi:
            logging.info(f"Gateway WiFi Signal (RSSI): {rssi} dBm")
            if rssi < -80:
                logging.warning("Weak WiFi signal! This may cause BrokenPipeErrors.")
        else:
            logging.info("WiFi RSSI not yet available in NodeDB.")

# --- 3. MQTT CALLBACKS ---
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        logging.info("Connected successfully to MQTT broker.")
        client.subscribe(MQTT_TOPIC)
    else:
        logging.error(f"MQTT login failed with code {rc}")

def on_message(client, userdata, msg):
    global interface
    try:
        if not interface or interface.myInfo is None:
            return

        # Extract Destination ID from topic (e.g., .../PKI/!abcdefgh)
        dest_id_hex = msg.topic.split('/')[-1].lower()
        dest_id_int = int(dest_id_hex.replace('!', '0x'), 16)
        
        nodes = interface.nodes or {}
        num_known = len(nodes)

        # Safety check for asynchronous NodeDB updates (if only local node is known)
        if num_known <= 1:
            time.sleep(0.5)
            nodes = interface.nodes or {}
            num_known = len(nodes)

        # Ignore messages for ourself
        if dest_id_int == interface.myInfo.my_node_num:
            return

        # Check if target node is in local NodeDB
        if dest_id_int in nodes:
            node_info = nodes[dest_id_int]
            long_name = node_info.get("user", {}).get("longName", "Unknown")
            last_heard = node_info.get("lastHeard", 0)
            
            # Apply time filter (MAX_AGE_HOURS)
            if (time.time() - last_heard) > (MAX_AGE_HOURS * 3600):
                logging.info(f"RESULT: DISCARDED | Target: {dest_id_hex} ({long_name}) | Reason: Inactive | DB: {num_known}")
                return

            logging.info(f"RESULT: MATCH | Target: {dest_id_hex} ({long_name}) | DB: {num_known} | ACTION: LoRa TX")
            
            # Inject message into LoRa Mesh
            interface.sendData(
                data=msg.payload, 
                destinationId=dest_id_int, 
                portNum=portnums_pb2.TEXT_MESSAGE_APP,
                wantAck=False,
                wantResponse=False
            )
        else:
            logging.info(f"RESULT: DISCARDED | Target: {dest_id_hex} | Reason: Not in DB | DB: {num_known}")

    except Exception as e:
        logging.error(f"Error processing MQTT message: {e}")

# --- 4. MQTT CLIENT SETUP ---
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
client.username_pw_set(MQTT_USER, MQTT_PW)
client.on_connect = on_connect
client.on_message = on_message

# Attach MQTT Logger after client creation
logging.getLogger().addHandler(MQTTHandler())

# --- 5. MAIN LOOP ---
last_heartbeat = 0
start_time = time.time()

try:
    logging.info("Starting MQTT Bridge Main Loop...")
    client.connect(MQTT_BROKER, 1883, 60)
    
    while True:
        # Process MQTT events
        client.loop(timeout=1.0)
        
        # Publish Health Status every 60 seconds
        if time.time() - last_heartbeat > 60:
            status = {
                "status": "online",
                "db_size": len(interface.nodes or {}),
                "uptime_script": int(time.time() - start_time)
            }
            client.publish("service/PKIdownlink/status", json.dumps(status), retain=True)
            last_heartbeat = time.time()
        
        # Monitor TCP Connection to Heltec Hardware
        if not interface or interface.failure or not interface.isConnected:
            logging.error("Critical Failure: Connection to Heltec lost!")
            sys.exit(1) # Triggers systemd restart

except KeyboardInterrupt:
    logging.info("Terminated by user.")
    if interface:
        interface.close()
    sys.exit(0)
except Exception as e:
    logging.error(f"Unexpected Error: {e}")
    sys.exit(1)
