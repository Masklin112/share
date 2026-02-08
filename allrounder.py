import time
import json
import logging
import re
import os
import sys
import math
import random
import requests
import threading 
import atexit
import psutil
from datetime import date
from bs4 import BeautifulSoup
from colorama import init, Fore
from collections import defaultdict
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor, as_completed

def calculate_distance(lat1, lon1, lat2, lon2):
    try:
        if not lat1 or not lon1 or not lat2 or not lon2: return float('inf')
        R = 6371
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = math.sin(dlat / 2) * math.sin(dlat / 2) + \
            math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * \
            math.sin(dlon / 2) * math.sin(dlon / 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c
    except:
        return float('inf')

class VehicleManager:
    def __init__(self, session):
        self.session = session
        self.lock = threading.RLock()
        self.buildings = {} 
        self.vehicles = {}  
        
    def load_static_data(self):
        logging.info("🏠 [API] Lade Gebäude-Daten...")
        try:
            resp = self.session.get(f"{BASE_URL}/api/buildings", timeout=15)
            data = resp.json()
            with self.lock:
                for b in data:
                    self.buildings[b['id']] = {'lat': b['latitude'], 'lon': b['longitude']}
        except Exception as e:
            logging.error(f"Fehler Gebäude-API: {e}")

    def sync_vehicles(self):
        while True:
            try:
                resp = self.session.get(f"{BASE_URL}/api/vehicles", timeout=15)
                data = resp.json()
                temp_vehicles = {}
                current_time = time.time()
                
                # SCHRITT 1: Rohdaten einlesen und Lock-Schutz prüfen
                for v in data:
                    v_id = v['id']
                    server_status = v['fms_real']
                    
                    current_local = self.vehicles.get(v_id)
                    if current_local and current_local['status'] == 5:
                        if (current_time - current_local.get('lock_time', 0)) < LOCK_TTL:
                            temp_vehicles[v_id] = current_local
                            continue

                    b_id = v['building_id']
                    coords = (0, 0)
                    if b_id in self.buildings:
                        coords = (self.buildings[b_id]['lat'], self.buildings[b_id]['lon'])
                    
                    temp_vehicles[v_id] = {
                        'id': v_id,
                        'type': v['vehicle_type'],
                        'status': server_status,
                        'coords': coords,
                        'tractive_vehicle_id': v.get('tractive_vehicle_id'),
                        'lock_time': 0
                    }

                # SCHRITT 2: Gespanne validieren (Status-Match)
                for v in temp_vehicles.values():
                    if v.get('tractive_vehicle_id'):
                        parent = temp_vehicles.get(v['tractive_vehicle_id'])
                        if not parent or parent['status'] != v['status']:
                            if v['status'] in [1, 2]:
                                v['status'] = 99 # Blockiert, da Zugfahrzeug nicht passt

                with self.lock:
                    self.vehicles = temp_vehicles
            except Exception as e:
                logging.error(f"Fahrzeug-Sync Fehler: {e}")
            time.sleep(30)

    def find_vehicles(self, requirements, m_lat, m_lon):
        found_ids = []
        MAX_DIST = 500.0
        temp_reserved = []
        
        with self.lock:
            candidates = []
            for v in self.vehicles.values():
                if v['status'] in [1, 2]:
                    dist = calculate_distance(m_lat, m_lon, v['coords'][0], v['coords'][1])
                    if dist <= MAX_DIST:
                        candidates.append((dist, v))
            
            candidates.sort(key=lambda x: x[0])

            # Haupt-Suche nach Anforderungen
            for req_name, count_needed in requirements.items():
                target_ids = bot._resolve_vehicle_name(req_name)
                if not target_ids: continue
                if isinstance(target_ids, int): target_ids = [target_ids]
                
                count = 0
                for dist, v in candidates:
                    if count >= count_needed: break
                    if v['id'] in found_ids: continue
                    
                    if v['type'] in target_ids:
                        # Falls Anhänger: Zugfahrzeug-Check
                        if v['tractive_vehicle_id']:
                            t_id = v['tractive_vehicle_id']
                            if t_id in found_ids or self.vehicles[t_id]['status'] not in [1, 2]:
                                continue # Zugfahrzeug bereits weg oder nicht bereit
                            
                            found_ids.append(t_id)
                            temp_reserved.append(t_id)

                        found_ids.append(v['id'])
                        temp_reserved.append(v['id'])
                        count += 1

            # PROAKTIVE LOGIK: Anhänger mitnehmen, wenn Zugfahrzeug bereits alarmiert wurde
            for dist, v in candidates:
                if v['id'] not in found_ids and v.get('tractive_vehicle_id'):
                    if v['tractive_vehicle_id'] in found_ids:
                        found_ids.append(v['id'])
                        temp_reserved.append(v['id'])

            # Lokalen Lock setzen
            for vid in temp_reserved:
                if vid in self.vehicles:
                    self.vehicles[vid]['status'] = 5
                    self.vehicles[vid]['lock_time'] = time.time()
                    
            return found_ids

def send_discord_notification(message):
    """Sendet eine einfache Nachricht an den konfigurierten Discord Webhook."""
    if not DISCORD_WEBHOOK_URL or 'DEINE_EINFÜGEN_WEBHOOK_URL' in DISCORD_WEBHOOK_URL:
        return

    data = {'content': message}
    headers = {'Content-Type': 'application/json'}
    try:
        response = requests.post(DISCORD_WEBHOOK_URL, data=json.dumps(data), headers=headers, timeout=10)
        response.raise_for_status() 
    except requests.exceptions.RequestException as e:
        logging.error(f"Konnte Discord-Benachrichtigung nicht senden: {e}")

# --- Hauptkonfiguration ---
SESSION_COOKIE = 'DEIN_SESSION_COOKIE' 
BASE_URL = 'https://www.leitstellenspiel.de'
API_URL = f'{BASE_URL}/map/mission_markers_own.js.erb'
MY_BOT_NAME = "Allrounder 1" 
COLLECTOR_URL = "" 
CHECK_INTERVAL_SECONDS = 15
PROCESS_PRISONER_REQUESTS = False 
RELOAD_ATTEMPTS = 5 
LOCK_TTL = 40

LEADERSHIP_MEMORY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'processed_leadership_allrounder.json')
PROCESSED_MISSIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'PM_Allrounder.json')
ESCALATION_MEMORY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'escalation_memory.json') 
VEHICLE_IDS = {
    'RTW': '28', 'NEF': '29', 'HLF_20': '30', 'FUSTW': '32',
    'LNA': '55', 'ORGL': '56', 'ELW1_SEG': '59',
    'RTH_1': '31', 'RTH_2': '157',
    'KTW_TYP_B': '58',
    'NAW': '74', 'GW_SAN': '60'
}
SHAREABLE_MTIDS_ON_GREEN = {814, 815, 816, 817, 818, 819, 820, 838, 839}
VEHICLE_SUBSTITUTIONS = {'rtw': ['ktw_typ_b', 'naw']}

# --- Pfad-Konfiguration ---
BOT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PAUSE_REQUEST_FILE = os.path.join(BOT_DIRECTORY, 'pause_request.lock')
PAUSE_CONFIRMED_FILE = os.path.join(BOT_DIRECTORY, 'pause_confirmed.lock')
MISSIONS_JSON_PATH = os.path.join(BOT_DIRECTORY, 'missions/')
CONFIG_PATH = os.path.join(BOT_DIRECTORY, 'config.json')

# --- Logging-Setup (NEU: Mit Rotation) ---
class UnbufferedStreamHandler(logging.StreamHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

class NoColorFilter(logging.Filter):
    def filter(self, record):
        if isinstance(record.msg, str):
            return True
        return True
    
log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

# 1. Konsolen-Ausgabe (Bunt & Live)
console_handler = UnbufferedStreamHandler(sys.stdout)
console_handler.setFormatter(log_formatter)

# 2. Datei-Ausgabe (Rotierend: Max 2 MB, behält 1 Backup)
log_file_path = os.path.join(BOT_DIRECTORY, 'allrounder.log')
file_handler = RotatingFileHandler(
    log_file_path, 
    maxBytes=2*1024*1024,  # 2 MB
    backupCount=1,         # 1 Backup
    encoding='utf-8'
)
file_handler.setFormatter(log_formatter)

root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
root_logger.handlers.clear()
root_logger.addHandler(console_handler) 
root_logger.addHandler(file_handler)    

class AllrounderBot:
    def __init__(self):
        os.system('title [Allrounder-Bot V4.7 Turbo] - MULTI-THREADED')
        logging.info("Initialisiere Allrounder-Bot (Turbo)...")
        
        global SESSION_COOKIE, DISCORD_WEBHOOK_URL
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                config = json.load(f)
                self.config = config
                SESSION_COOKIE = config['SESSION_COOKIE']
                DISCORD_WEBHOOK_URL = config.get('DISCORD_WEBHOOK_URL', '')
        except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
            logging.error(f"FATAL: Konnte Konfigurationsdatei nicht laden: {e}")
            self.config = {}
            sys.exit(1)

        self.shareable_mtids = SHAREABLE_MTIDS_ON_GREEN
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        self.session.cookies.set('_session_id', SESSION_COOKIE, domain='www.leitstellenspiel.de')
        self.PROCESS_PRISONER_REQUESTS = PROCESS_PRISONER_REQUESTS
        self.CHECK_INTERVAL_SECONDS = CHECK_INTERVAL_SECONDS

        self._load_helper_files()
        
        if not self._verify_login():
            logging.error("Anmeldung fehlgeschlagen. Bitte SESSION_COOKIE überprüfen. Skript wird beendet.")
            sys.exit()

        self.processed_missions = self._load_mission_memory()
        self.processed_leadership = self._load_leadership_memory()
        self.escalation_memory = self._load_escalation_memory()
        self.sprechwunsch_waitlist = self._load_sprechwunsch_waitlist()
        self.yellow_mission_realarms = {}
        
        self.dispatch_attempts = {}
        self.failed_vehicles_to_ignore = defaultdict(set)
        self.bad_vehicle_log_path = os.path.join(BOT_DIRECTORY, 'zu_ueberpruefende_fahrzeuge.txt')
        
        self.consecutive_api_failures = 0
        self.last_heartbeat_time = 0
        self.total_completed_missions = 0
        self.total_earned_credits = 0
        self.completed_normal = 0
        self.completed_transport = 0
        self.completed_planned = 0
        self.last_api_missions = []
        self.verband_last_active_timestamp = None 
        self.last_reset_date = date.today()
        
        logging.info(f"Statistik-Reset-Datum initialisiert auf: {self.last_reset_date.strftime('%Y-%m-%d')}")
        logging.info(Fore.GREEN + "Bot erfolgreich initialisiert und angemeldet.")
        self.current_dashboard_status = "♻️ Bot startet..." 
        
        atexit.register(self._save_leadership_memory)
        atexit.register(self._save_mission_memory)
        atexit.register(self._save_escalation_memory)
        atexit.register(self._save_sprechwunsch_waitlist)
        logging.info("Gedächtnis-Speicherfunktionen für sauberen Programm-Exit registriert.")
        
        self._start_heartbeat_pinger()
        self._start_sprechwunsch_processor()
        self._start_bonus_collector()

        # NEU: Watchdog
        self.last_main_loop_activity = time.time()
        self._start_watchdog()
        
        self.vm = VehicleManager(self.session)
        self.vm.load_static_data()
        threading.Thread(target=self.vm.sync_vehicles, daemon=True).start()
        logging.info("Warte auf ersten Fahrzeug-Sync...")
        while not self.vm.vehicles:
            time.sleep(1)
        logging.info(f"Fahrzeug-Sync abgeschlossen ({len(self.vm.vehicles)} Fahrzeuge geladen).")

    def _start_heartbeat_pinger(self):
        pinger_thread = threading.Thread(target=self._run_heartbeat_pinger, daemon=True)
        pinger_thread.start()
        logging.info("Aktivitäts-Pinger wurde im Hintergrund gestartet (Intervall: 18s).")
    
    def _start_sprechwunsch_processor(self):
        sprechwunsch_thread = threading.Thread(target=self._run_sprechwunsch_processor, daemon=True)
        sprechwunsch_thread.start()
        logging.info("Sprechwunsch-Prozessor wurde im Hintergrund gestartet (Intervall: 30s).")
    
    def _run_heartbeat_pinger(self):
        while True:
            try:
                timestamp = int(time.time() * 1000)
                ping_url = f"{BASE_URL}/mission-generate?_={timestamp}"
                self.session.get(ping_url, timeout=10)
                logging.info("[Pinger] Aktivitäts-Signal erfolgreich gesendet.")
                self._send_status_to_collector(self.current_dashboard_status)
            except requests.exceptions.RequestException as e:
                logging.error(f"[Pinger-Fehler] Konnte Aktivitäts-Ping nicht senden: {e}")
            time.sleep(18)

    # --- WATCHDOG ---
    def _start_watchdog(self):
        wd_thread = threading.Thread(target=self._run_watchdog, daemon=True)
        wd_thread.start()
        logging.info("🐕 [Watchdog] Überwachungsdienst gestartet (Timeout: 5 Minuten).")

    def _run_watchdog(self):
        WATCHDOG_TIMEOUT = 300  # 5 Minuten
        logging.info("🐕 [Watchdog] Thread gestartet und scharf geschaltet.")
        
        while True:
            try:
                time.sleep(60)
                if os.path.exists(PAUSE_REQUEST_FILE):
                    self.last_main_loop_activity = time.time()
                    continue
                
                time_since_last_run = time.time() - self.last_main_loop_activity
                
                # Lebenszeichen
                if time_since_last_run > 60:
                    logging.info(f"🐕 [Watchdog] Prüfe... Letzte Aktivität vor {int(time_since_last_run)}s (Limit: {WATCHDOG_TIMEOUT}s)")

                if time_since_last_run > WATCHDOG_TIMEOUT:
                    minutes_stuck = int(time_since_last_run / 60)
                    error_msg = f"⚠️ [Watchdog] ALARM! Hauptschleife steht seit {int(time_since_last_run)}s ({minutes_stuck} Min.) still. Führe Not-Neustart durch..."
                    logging.error(Fore.RED + error_msg)
                    send_discord_notification(f"🐕 **Watchdog-Alarm:** {self.config.get('BOT_NAME', 'Allrounder')} reagiert nicht mehr. Starte neu...")
                    try:
                        self._save_mission_memory() 
                        self._save_leadership_memory()
                    except: pass
                    
                    logging.warning("♻️ Starte Skript neu...")
                    python = sys.executable
                    os.execl(python, python, *sys.argv)
            except Exception as e:
                logging.error(f"🐕 [Watchdog-Fehler] Der Watchdog ist gestolpert: {e}")
                time.sleep(10)

    def _load_helper_files(self):
        logging.info("Lade Fahrzeug-Zuordnungsdateien...")
        try:
            with open(os.path.join(BOT_DIRECTORY, 'links.json'), 'r', encoding='utf-8') as f:
                links_data = json.load(f)
            with open(os.path.join(BOT_DIRECTORY, 'missing.json'), 'r', encoding='utf-8') as f:
                missing_data = json.load(f)
            self.vehicle_map = {k.lower().strip(): v for k, v in {**links_data, **missing_data}.items()}
        except Exception as e:
            logging.error(f"FATAL: Konnte links.json oder missing.json nicht laden: {e}")
            sys.exit()
            
        logging.info("Lade Fahrzeug-Ignorier-Liste...")
        self.ignore_list = set()
        try:
            with open(os.path.join(BOT_DIRECTORY, 'vehicleignorelist.json'), 'r', encoding='utf-8') as f:
                ignore_data = json.load(f)
            self.ignore_list = {item.lower().strip() for item in ignore_data}
        except FileNotFoundError:
            logging.warning("'vehicleignorelist.json' nicht gefunden.")
        except json.JSONDecodeError:
            logging.error("Fehler bei 'vehicleignorelist.json'.")

        hardcoded_ignores = {
            'kdow-lna', 'lna', 'kdow-orgl', 'orgl', 'elw 1 (seg)', 'elw1-seg', 'elw 1-seg',
            'maximale patientenanzahl', 'Maximale Patienenanzahl', 
            'Maximale patientenanzahl', 'maximale Patientenanzahl'
        }
        self.ignore_list.update(hardcoded_ignores)
        
        logging.info("Lade Material-Zuordnungsdatei...")
        self.material_map = {}
        try:
            with open(os.path.join(BOT_DIRECTORY, 'material_map.json'), 'r', encoding='utf-8') as f:
                self.material_map = json.load(f)
        except FileNotFoundError:
            logging.warning("'material_map.json' nicht gefunden.")
            
        logging.info("Lade Fahrzeug-Detaildaten...")
        self.vehicle_details = {}
        try:
            with open(os.path.join(BOT_DIRECTORY, 'vehicles.json'), 'r', encoding='utf-8') as f:
                vehicles_data = json.load(f)
            for vid, vdata in vehicles_data.items():
                caption = vdata.get('caption', '').lower().strip()
                if caption:
                    max_personnel = vdata.get('maxPersonnel')
                    if max_personnel is None:
                        staff_info = vdata.get('staff', {})
                        max_personnel = staff_info.get('max', 1)
                    self.vehicle_details[caption] = {'id': vid, 'maxPersonnel': max_personnel}
        except Exception as e:
            logging.error(f"FATAL: Konnte vehicles.json nicht laden: {e}")
            sys.exit()

    def _verify_login(self):
        try:
            logging.info("Überprüfe Login-Status...")
            response = self.session.get(BASE_URL)
            response.raise_for_status()
            if "Logout" in response.text:
                logging.info("Login erfolgreich verifiziert.")
                return True
            return False
        except requests.exceptions.RequestException as e:
            logging.error(f"Fehler bei Verbindung: {e}")
            return False
            
    def _reinitialize_session(self):
        logging.warning("Initialisiere die Netzwerk-Session neu...")
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        self.session.cookies.set('_session_id', SESSION_COOKIE, domain='www.leitstellenspiel.de')
        logging.info("Netzwerk-Session neu initialisiert.")
        
    def _load_leadership_memory(self):
        try:
            with open(LEADERSHIP_MEMORY_PATH, 'r', encoding='utf-8') as f:
                return {int(k): set(v) for k, v in json.load(f).items()}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_leadership_memory(self):
        try:
            with open(LEADERSHIP_MEMORY_PATH, 'w', encoding='utf-8') as f:
                json.dump({k: list(v) for k, v in self.processed_leadership.items()}, f, indent=4)
        except Exception as e:
            logging.error(f"Fehler beim Speichern Führungskräfte: {e}")
    
    def _load_mission_memory(self):
        try:
            with open(PROCESSED_MISSIONS_PATH, 'r', encoding='utf-8') as f:
                return set(json.load(f))
        except (FileNotFoundError, json.JSONDecodeError):
            return set()

    def _save_mission_memory(self):
        try:
            with open(PROCESSED_MISSIONS_PATH, 'w', encoding='utf-8') as f:
                json.dump(list(self.processed_missions), f, indent=2)
        except Exception as e:
            logging.error(f"Fehler beim Speichern Einsätze: {e}")
    
    def _load_escalation_memory(self):
        try:
            with open(ESCALATION_MEMORY_PATH, 'r', encoding='utf-8') as f:
                return {int(k): v for k, v in json.load(f).items()}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_escalation_memory(self):
        try:
            with open(ESCALATION_MEMORY_PATH, 'w', encoding='utf-8') as f:
                json.dump(self.escalation_memory, f, indent=4)
        except Exception as e:
            logging.error(f"Fehler beim Speichern Eskalation: {e}")
    
    def _load_sprechwunsch_waitlist(self):
        waitlist_path = os.path.join(BOT_DIRECTORY, 'sprechwunsch_waitlist.json')
        try:
            with open(waitlist_path, 'r', encoding='utf-8') as f:
                return {int(k): v for k, v in json.load(f).items()}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_sprechwunsch_waitlist(self):
        waitlist_path = os.path.join(BOT_DIRECTORY, 'sprechwunsch_waitlist.json')
        try:
            with open(waitlist_path, 'w', encoding='utf-8') as f:
                json.dump(self.sprechwunsch_waitlist, f, indent=4)
        except Exception as e:
            logging.error(f"Fehler beim Speichern Sprechwünsche: {e}")
        
    def _is_medical_vehicle(self, req_name):
        return any(key in req_name for key in ['rtw', 'nef', 'lna', 'orgl', 'gw-san', 'ktw_typ_b', 'rth', 'naw'])

    def _get_api_data(self):
        try:
            response = self.session.get(API_URL, timeout=15) 
            response.raise_for_status()
            js_content = response.text
            missions = []
            patient_data_str = ""
            start_str = "const mList = "
            start_index = js_content.find(start_str)
            if start_index != -1:
                json_start = start_index + len(start_str)
                if js_content[json_start] == '[':
                    open_brackets = 1
                    search_pos = json_start + 1
                    while open_brackets > 0 and search_pos < len(js_content):
                        if js_content[search_pos] == '[': open_brackets += 1
                        elif js_content[search_pos] == ']': open_brackets -= 1
                        search_pos += 1
                    if open_brackets == 0:
                        json_end = search_pos
                        json_data_str = js_content[json_start:json_end]
                        json_data_str_fixed = re.sub(r',\s*(?=\]$)', '', json_data_str)
                        try:
                            missions = json.loads(json_data_str_fixed)
                        except json.JSONDecodeError as e:
                            logging.error(f"    -> JSON-Fehler: {e}")
                            return None, None
                patient_data_index = js_content.find('patientMarkerAdd')
                if patient_data_index != -1:
                    patient_data_str = js_content[patient_data_index:]
            else:
                logging.info("Keine 'const mList'-Daten gefunden.")
            return missions, patient_data_str
        except requests.exceptions.RequestException as e:
            logging.error(f"Fehler bei API: {e}")
            return None, None
    
    def _send_status_to_collector(self, status_text):
        try:
            payload = {
                'bot_name': self.config.get('BOT_NAME', MY_BOT_NAME),
                'status_text': status_text,
                'missions_completed': self.total_completed_missions,
                'credits_earned': self.total_earned_credits,
                'credits_formatted': f"{self.total_earned_credits:,}".replace(",", "."),
                'active_missions': len(self.last_api_missions) if hasattr(self, 'last_api_missions') and self.last_api_missions else 0,
                'timestamp': time.time()
            }
            requests.post(COLLECTOR_URL, json=payload, timeout=5)
        except Exception as e:
            pass

    def _generate_hud_html(self, header, sub_header, state_class, stats, progress=None):
        progress_html = ""
        if progress:
            current, total = progress
            pct = int((current / total) * 100) if total > 0 else 0
            progress_html = f"""
            <div class="progress-container">
                <div class="progress-bar-fill" style="width: {pct}%"></div>
                <div class="progress-text">Bearbeite: {current} / {total}</div>
            </div>
            """
        return f"""
        <div class="hud-container {state_class}">
            <div class="hud-header"><span class="hud-title">{header}</span><span class="hud-sub">{sub_header}</span></div>
            {progress_html} <div class="hud-row main-stat"><span class="hud-label">API Gesamt</span><span class="hud-value">{stats['total']}</span></div>
            <div class="hud-divider"></div>
            <div class="hud-row"><span class="hud-label">Fokus (&lt;5k)</span><span class="hud-value">{stats['c5k_total']}</span></div>
            <div class="hud-detail-row"><span class="dot-red">{stats['c5k_red']}</span><span class="dot-green">{stats['c5k_green']}</span><span class="dot-yellow">{stats['c5k_yellow']}</span></div>
            <div class="hud-row"><span class="hud-label">Geplant</span><span class="hud-value">{stats['sw_total']}</span></div>
            <div class="hud-detail-row"><span class="dot-red">{stats['sw_red']}</span><span class="dot-green">{stats['sw_green']}</span><span class="dot-yellow">{stats['sw_yellow']}</span></div>
            {(f'<div class="hud-alert">⚠️ Event: {stats["events"]}</div>' if stats["events"] > 0 else '')}
            {(f'<div class="hud-info">🚑 KTW: {stats["transport"]}</div>' if stats["transport"] > 0 else '')}
        </div>
        """

    # --- NEUE WORKER-METHODE ---
    def _process_single_mission(self, mission, patient_data_str):
        try:
            mission_id = mission['id']
            time.sleep(random.uniform(0.05, 0.25))

            icon = mission.get('icon', '')

            # 1. Gelb
            if icon.endswith('_gelb'):
                if mission_id in self.yellow_mission_realarms: return False
                creation_time = mission.get('created_at', time.time())
                age_minutes = (time.time() - creation_time) / 60
                if age_minutes >= 120:
                    self.handle_initial_alarm(mission, patient_data_str)
                    self.yellow_mission_realarms[mission_id] = time.time()
                    return True
                return False

            # 2. KTW Transport
            if mission.get('kt') and icon.endswith('_rot') and mission_id not in self.processed_missions:
                success = self._send_single_closest_vehicle(mission_id, mission.get('caption'), required_vehicle_types=None)
                if success:
                    with self.vm.lock:
                        self.processed_missions.add(mission_id)
                    return True
                return False

            # 3. Normale Einsätze (Rot)
            if icon.endswith('_rot'):
                if mission_id not in self.processed_missions:
                    self.handle_initial_alarm(mission, patient_data_str)
                else:
                    self.handle_follow_up_alarm(mission, patient_data_str)
                return True
                
        except Exception as e:
            logging.error(f"Worker-Fehler bei Einsatz {mission.get('id')}: {e}")
        return False

    def run(self):
        logging.info("Starte Hauptschleife (Turbo-Modus).")
        MISSIONS_PER_CYCLE = 100
        MAX_WORKERS = 4 

        while True:
            self.last_main_loop_activity = time.time()
            today = date.today()
            
            if today > self.last_reset_date:
                logging.info(Fore.CYAN + f"--- MITTERNACHT RESET {self.last_reset_date} ---")
                send_discord_notification(f"**Tagesabschluss {self.last_reset_date}**\nEinsätze: {self.total_completed_missions}\nCredits: {self.total_earned_credits:,}")
                self.total_completed_missions = 0
                self.total_earned_credits = 0
                self.completed_normal = 0
                self.completed_transport = 0
                self.completed_planned = 0
                self.last_reset_date = today

            if time.time() - self.last_heartbeat_time > 600:
                # Status-Logik (gekürzt)
                if os.path.exists(PAUSE_REQUEST_FILE):
                    v_status, a_status = "▶️ **Verbands-Bot:** Arbeitet", "⏸️ **Allrounder:** Pausiert"
                else:
                    v_status, a_status = "💤 **Verbands-Bot:** Inaktiv", "✅ **Allrounder:** Aktiv"
                
                cpu, ram = psutil.cpu_percent(interval=1), psutil.virtual_memory().percent
                msg = f"**🤖 Status**\n{a_status}\n{v_status}\n📈 **Heute:** {self.total_completed_missions} Einsätze | {self.total_earned_credits:,} Cr.\n🖥️ CPU: {cpu}% RAM: {ram}%"
                send_discord_notification(msg)
                self.last_heartbeat_time = time.time()

            if os.path.exists(PAUSE_REQUEST_FILE):
                logging.info(Fore.YELLOW + "Pausen-Anfrage! Pausiere...")
                with open(PAUSE_CONFIRMED_FILE, 'w') as f: pass
                last_log = time.time()
                while os.path.exists(PAUSE_REQUEST_FILE):
                    time.sleep(2)
                    if time.time() - last_log > 10:
                        logging.info("Pausiert...")
                        last_log = time.time()
                self.verband_last_active_timestamp = time.time()
                if os.path.exists(PAUSE_CONFIRMED_FILE): os.remove(PAUSE_CONFIRMED_FILE)
                logging.info(Fore.GREEN + "Freigabe erhalten.")

            try:
                missions, patient_data_str = self._get_api_data()
                if missions is None:
                    self.consecutive_api_failures += 1
                    logging.warning(f"API Fehler ({self.consecutive_api_failures})")
                    if self.consecutive_api_failures >= 20: self._reinitialize_session()
                    time.sleep(self.CHECK_INTERVAL_SECONDS)
                    continue
                self.last_api_missions = missions
                self.consecutive_api_failures = 0

                stats = {'total': len(missions), 'c5k_total': 0, 'c5k_red': 0, 'c5k_green': 0, 'c5k_yellow': 0, 'sw_total': 0, 'sw_red': 0, 'sw_green': 0, 'sw_yellow': 0, 'transport': 0, 'events': 0}
                for m in missions:
                    credits = m.get('average_credits', 0)
                    icon = m.get('icon', '')
                    is_sw, is_trans = m.get('sw', False), m.get('kt') or m.get('ct')
                    if is_sw: stats['sw_total'] += 1
                    elif is_trans: stats['transport'] += 1
                    elif credits <= 5000:
                        stats['c5k_total'] += 1
                        if icon.endswith('_rot'): stats['c5k_red'] += 1

                prio_a, prio_b, prio_c = [], [], []
                for m in missions:
                    if m.get('sw') and m.get('icon', '').endswith('_gruen') and m.get('alliance_shared_at'): continue
                    if m.get('sw'): prio_a.append(m)
                    elif m.get('kt') or m.get('ct'): prio_c.append(m)
                    elif m.get('average_credits', 0) <= 5000: prio_b.append(m)

                sorted_missions = sorted(prio_a, key=lambda x: x.get('id')) + sorted(prio_b, key=lambda x: x.get('id')) + sorted(prio_c, key=lambda x: x.get('id'))
                missions_to_process = sorted_missions[:MISSIONS_PER_CYCLE]
                total_to_process = len(missions_to_process)
                
                if missions_to_process:
                    logging.info(f"Scan fertig. {len(missions)} Einsätze, bearbeite Top {total_to_process} mit {MAX_WORKERS} Workern.")
                else:
                    logging.info(f"Scan fertig. {len(missions)} Einsätze, nichts zu tun.")

                processed_count = 0
                with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                    futures = {executor.submit(self._process_single_mission, m, patient_data_str): m for m in missions_to_process}
                    
                    for future in as_completed(futures):
                        processed_count += 1
                        self.last_main_loop_activity = time.time()
                        
                        if processed_count % 5 == 0 or processed_count == total_to_process:
                            live_html = self._generate_hud_html("🚀 TURBO", f"Worker aktiv ({processed_count}/{total_to_process})", "state-active", stats, progress=(processed_count, total_to_process))
                            self.current_dashboard_status = live_html
                            self._send_status_to_collector(live_html)
                        
                        if os.path.exists(PAUSE_REQUEST_FILE) and processed_count % 10 == 0:
                            logging.info(Fore.YELLOW + "🚨 Pausen-Anfrage! Lasse Batch fertigstellen...")

                self._save_mission_memory()

            except Exception as e:
                logging.error(f"Unerwarteter Fehler: {e}", exc_info=True)
            
            wait_html = self._generate_hud_html("💤 WARTE", f"Nächster Scan in {self.CHECK_INTERVAL_SECONDS}s", "state-active", stats if 'stats' in locals() else {'total':0, 'c5k_total':0, 'c5k_red':0, 'c5k_green':0, 'c5k_yellow':0, 'sw_total':0, 'sw_red':0, 'sw_green':0, 'sw_yellow':0, 'transport':0, 'events':0})
            self.current_dashboard_status = wait_html
            self._send_status_to_collector(wait_html)
            
            for _ in range(self.CHECK_INTERVAL_SECONDS):
                if os.path.exists(PAUSE_REQUEST_FILE): break
                time.sleep(1)

    def handle_initial_alarm(self, mission, patient_data_str):
        mission_id = mission['id']
        mission_caption = mission.get('caption', f"Einsatz {mission_id}")
        mtid = mission.get('mtid')
        overlay = mission.get('additive_overlays')
        missing_text = mission.get('missing_text')
        logging.info(Fore.YELLOW + f"--- ERSTKONTAKT: '{mission_caption}' (ID: {mission_id}) ---")
        requirements = {}

        initial_alarm_ignores = {'rtw', 'nef', 'rth', 'naw'}
        def is_ignored(req_text):
            if any(w in req_text for w in self.ignore_list): return True
            if any(w in req_text for w in initial_alarm_ignores): return True
            return False

        if mtid is not None:
            json_filename = f"{mtid}--{overlay}.json" if overlay else f"{mtid}.json"
            json_filepath = os.path.join(MISSIONS_JSON_PATH, json_filename)
            try:
                with open(json_filepath, 'r', encoding='utf-8') as f:
                    mission_data = json.load(f)
                for req in mission_data.get("requirements", []):
                    req_name = req.get("requirement", "").lower().strip()
                    if not req_name or (is_ignored(req_name) and not mission.get('sw')): continue
                    qty = int(req.get("qty", 1)) if str(req.get("qty", 1)).isdigit() else 1
                    requirements[req_name] = requirements.get(req_name, 0) + qty
            except FileNotFoundError: pass
        
        if not requirements and missing_text:
            try:
                missing_data = json.loads(missing_text)
                if v_text := missing_data.get('vehicles'):
                    for count, name in re.findall(r'(\d+)\s*x?\s*([^,]+)', v_text):
                        req_name = name.strip().lower().replace('\xa0', ' ')
                        if is_ignored(req_name) and not mission.get('sw'): continue
                        requirements[req_name] = requirements.get(req_name, 0) + int(count)
                if other_text := missing_data.get('other'):
                    for mat, opts in self.material_map.items():
                        if mat.lower() in other_text.lower():
                            v_req = opts[0] if isinstance(opts, list) else opts
                            if v_req: requirements[v_req] = requirements.get(v_req, 0) + 1
                            break
            except json.JSONDecodeError: pass
        
        dynamic_requirements = {}
        patients_count = mission.get('patients_count', 0)
        if patients_count > 0:
            dynamic_requirements['rtw'] = patients_count
            nef_needed = 2 if patients_count == 3 else math.ceil(patients_count / 10 * 3)
            if nef_needed > 0: dynamic_requirements['nef'] = int(nef_needed)
            if patients_count >= 1: dynamic_requirements['elw1_seg'] = 1
            if patients_count >= 5: dynamic_requirements['lna'] = 1
            if patients_count >= 10: dynamic_requirements['orgl'] = 1

        patient_entries = re.findall(r'patientMarkerAdd(?:Combined)?\((.*?)\);', patient_data_str)
        for entry_str in patient_entries:
            try:
                entry = json.loads(entry_str)
                if entry.get('mission_id') == mission_id:
                    needs = []
                    if entry.get('errors'): needs.extend(entry['errors'].items())
                    if entry.get('missing_text'): needs.append((entry['missing_text'], 1))
                    for n_str, count in needs:
                        for v_name in n_str.replace("Wir benötigen:", "").strip().lower().split(','):
                            v_name = v_name.strip()
                            if self._is_medical_vehicle(v_name) and 'rtw' not in v_name:
                                dynamic_requirements[v_name] = 1 if v_name in {'lna', 'orgl', 'elw1_seg', 'gw-san'} else dynamic_requirements.get(v_name, 0) + int(count)
            except: continue
        
        for v, c in dynamic_requirements.items(): requirements[v] = requirements.get(v, 0) + c
        
        if requirements:
            if self.dispatch_vehicles(mission_id, mission_caption, requirements):
                self.processed_missions.add(mission_id)
                self._save_mission_memory()
        else:
            self.processed_missions.add(mission_id)
            self._save_mission_memory()
    
    def _send_single_closest_vehicle(self, mission_id, mission_caption, required_vehicle_types=None):
        try:
            mission_url = f"{BASE_URL}/missions/{mission_id}"
            response = self.session.get(mission_url)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'lxml')
            token_tag = soup.find('input', {'name': 'authenticity_token'})
            if not token_tag: return False
            
            vehicle_table = soup.select_one('tbody[id^="vehicle_show_table_body_"]')
            if vehicle_table:
                for row in vehicle_table.find_all('tr', class_='vehicle_select_table_tr'):
                    checkbox = row.find('input', {'type': 'checkbox'})
                    if not checkbox: continue
                    try: v_type_id = int(checkbox.get('vehicle_type_id', 0))
                    except: continue
                    if not checkbox.get('disabled') and (required_vehicle_types is None or v_type_id in required_vehicle_types):
                        self._send_alarm_in_chunks(mission_id, mission_caption, token_tag['value'], [checkbox.get('value')])
                        return True
            return False
        except: return False
    
    def handle_follow_up_alarm(self, mission, patient_data_str):
        mission_id = mission['id']
        mission_caption = mission.get('caption', f"Einsatz {mission_id}")
        
        if mission.get('missing_text_short') == "Ein Fahrzeug hat einen Sprechwunsch!" and mission.get('prisoners_count', 0) > 0:
            if mission_id not in self.sprechwunsch_waitlist:
                self.sprechwunsch_waitlist[mission_id] = time.time()
                self._save_sprechwunsch_waitlist()
                return
            if time.time() - self.sprechwunsch_waitlist[mission_id] < 600: return
            del self.sprechwunsch_waitlist[mission_id]
            self._save_sprechwunsch_waitlist()
            self._handle_prisoner_transport_alarm(mission)
            return

        requirements = {}
        escalation_count = self.escalation_memory.get(mission_id, 0)
        should_ignore = escalation_count < 2

        if missing_text := mission.get('missing_text'):
            try:
                m_data = json.loads(missing_text)
                if v_text := m_data.get('vehicles'):
                    for c, n in re.findall(r'(\d+)\s*x?\s*([^,]+)', v_text):
                        req_name = n.strip().lower().replace('\xa0', ' ')
                        if should_ignore and any(w in req_name for w in self.ignore_list): continue
                        requirements[req_name] = requirements.get(req_name, 0) + int(c)
                if o_text := m_data.get('other'):
                    for mat, opts in self.material_map.items():
                        if mat.lower() in o_text.lower():
                            v = opts[0] if isinstance(opts, list) else opts
                            if v: requirements[v] = requirements.get(v, 0) + 1
                            break
                if p_text := m_data.get('personnel'):
                    for c, n in re.findall(r'(\d+)\s*x?\s*([^,]+)', p_text):
                        if "feuerwehr" in n.lower():
                            requirements['löschfahrzeuge'] = requirements.get('löschfahrzeuge', 0) + math.ceil(int(c)/9)
                        elif self._resolve_vehicle_name(n.strip().lower()):
                            requirements[n.strip().lower()] = requirements.get(n.strip().lower(), 0) + int(c)
            except: pass

        patient_entries = re.findall(r'patientMarkerAdd(?:Combined)?\((.*?)\);', patient_data_str)
        for e_str in patient_entries:
            try:
                entry = json.loads(e_str)
                if entry.get('mission_id') == mission_id:
                    needs = []
                    if entry.get('errors'): needs.extend(entry['errors'].items())
                    if entry.get('missing_text'): needs.append((entry['missing_text'], 1))
                    for n_str, c in needs:
                        for v_name in n_str.replace("Wir benötigen:", "").strip().lower().split(','):
                            v_name = v_name.strip()
                            if self._resolve_vehicle_name(v_name):
                                if should_ignore and any(w in v_name for w in self.ignore_list) and not any(x in v_name for x in ['lna', 'orgl', 'elw']): continue
                                requirements[v_name] = 1 if v_name in {'lna', 'orgl', 'elw1_seg', 'gw-san'} else requirements.get(v_name, 0) + 1
            except: continue

        if not requirements and mission.get('patients_count', 0) > 0:
            pc = mission['patients_count']
            if 'rtw' not in requirements and 'naw' not in requirements: requirements['rtw'] = requirements.get('rtw', 0) + pc
            if pc >= 1: requirements['elw1_seg'] = 1
            if pc >= 5: requirements['lna'] = 1
            if pc >= 10: requirements['orgl'] = 1
        
        if not requirements: requirements = {'fustw': 1}
        
        if self.dispatch_vehicles(mission_id, mission_caption, requirements, is_escalated=(escalation_count >= 2)):
            if mission_id in self.escalation_memory: del self.escalation_memory[mission_id]
        else:
            self.escalation_memory[mission_id] = escalation_count + 1

    def _handle_prisoner_transport_alarm(self, mission):
        mission_id = mission['id']
        prisoners_count = mission.get('prisoners_count', 0)
        if prisoners_count == 0: return
        requirements = {'funkstreifenwagen (dienstgruppenleitung)': 1, 'gefangenen-transport': prisoners_count}
        self.dispatch_vehicles(mission_id, mission.get('caption', ''), requirements)
            
    def _log_bad_vehicle(self, mission_caption, vehicle_info):
        try:
            with open(self.bad_vehicle_log_path, 'a', encoding='utf-8') as f:
                f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Einsatz: '{mission_caption}' | Defekt: '{vehicle_info.get('name')}' ({vehicle_info.get('id')})\n")
        except: pass
        
    def _check_and_claim_easter_egg(self, soup, mission_id, mission_caption):
        try:
            if soup.find('a', id='easter-egg-link'):
                token = (soup.find('input', {'name': 'authenticity_token'}) or {}).get('value')
                if token:
                    self.session.post(f"{BASE_URL}/missions/{mission_id}/claim_found_object", data={'authenticity_token': token}, headers={'Referer': f"{BASE_URL}/missions/{mission_id}", 'X-Requested-With': 'XMLHttpRequest'}, timeout=15)
                    logging.info(Fore.GREEN + f"    -> ✅ Easteregg bei '{mission_caption}' eingesammelt!")
        except: pass

    def dispatch_vehicles(self, mission_id, mission_caption, requirements, is_escalated=False):
        mission_data = next((m for m in self.last_api_missions if m['id'] == mission_id), None)
        if not mission_data: return False
        
        vehicle_ids = self.vm.find_vehicles(requirements, mission_data.get('latitude'), mission_data.get('longitude'))
        if not vehicle_ids: return False

        try:
            response = self.session.get(f"{BASE_URL}/missions/{mission_id}", timeout=10)
            soup = BeautifulSoup(response.text, 'lxml')
            self._check_and_claim_easter_egg(soup, mission_id, mission_caption)
            
            token = soup.find('input', {'name': 'authenticity_token'})
            if token:
                self._send_alarm_in_chunks(mission_id, mission_caption, token['value'], vehicle_ids)
                return True
        except Exception as e:
            logging.error(f"Dispatch Fehler: {e}")
        return False

    def _resolve_vehicle_name(self, req_name):
        req_name_cleaned = req_name.lower().replace('\xa0', ' ').strip()
        if req_name_cleaned == 'gefangenen-transport': return [52, 32]
        if req_name_cleaned in self.vehicle_map: return self.vehicle_map[req_name_cleaned]
        base_name = re.sub(r'\(.*\)| oder .*', '', req_name_cleaned).strip()
        if base_name in self.vehicle_map: return self.vehicle_map[base_name]
        return None

    def _send_alarm_in_chunks(self, mission_id, mission_caption, token, vehicle_ids):
        if not vehicle_ids: return
        unique_ids = sorted(list(set(vehicle_ids)), key=int)
        chunks = [unique_ids[i:i + 50] for i in range(0, len(unique_ids), 50)]
        alarm_url = f"{BASE_URL}/missions/{mission_id}/alarm"
        for i, chunk in enumerate(chunks):
            payload = { 'utf8': '✓', 'authenticity_token': token, 'vehicle_ids[]': chunk, 'next_mission': '0' }
            try:
                # WICHTIG: Timeout ist hier auf 20s gesetzt!
                response = self.session.post(alarm_url, data=payload, timeout=20)
                response.raise_for_status()
            except requests.exceptions.RequestException as e:
                logging.error(f"        -> Fehler beim Versand von Paket {i+1}: {e}")
                
    def _start_bonus_collector(self):
        threading.Thread(target=self._run_bonus_collector, daemon=True).start()

    def _run_bonus_collector(self):
        time.sleep(5)
        while True:
            try:
                self._collect_daily_login()
                self._collect_seasonal_rewards()
                self._collect_task_rewards()
            except: pass
            time.sleep(1200)

    def _collect_daily_login(self):
        try:
            url = f"{BASE_URL}/daily_bonuses"
            soup = BeautifulSoup(self.session.get(url).text, 'lxml')
            if btn := soup.find('button', class_='collect-button'):
                self.session.post(f"{BASE_URL}{btn.get('url')}", data={'authenticity_token': (soup.find('meta', {'name': 'csrf-token'}) or {}).get('content')}, timeout=15)
                logging.info(Fore.GREEN + "    -> [Daily] Eingesammelt!")
            elif link := soup.find('a', href=re.compile(r'/daily_bonuses/collect'), class_='btn-success'):
                self.session.post(f"{BASE_URL}{link['href']}", data={'authenticity_token': (soup.find('meta', {'name': 'csrf-token'}) or {}).get('content')}, timeout=15)
                logging.info(Fore.GREEN + "    -> [Daily] Eingesammelt!")
        except: pass

    def _collect_seasonal_rewards(self):
        try:
            url = f"{BASE_URL}/event-calendar"
            soup = BeautifulSoup(self.session.get(url).text, 'lxml')
            for btn in soup.find_all('a', class_='btn-success', href=re.compile(r'/event-calendar/\d+')):
                self.session.get(f"{BASE_URL}{btn['href']}")
                logging.info(Fore.GREEN + "    -> [Event] Eingesammelt!")
        except: pass

    def _collect_task_rewards(self):
        try:
            url = f"{BASE_URL}/tasks/index"
            soup = BeautifulSoup(self.session.get(url).text, 'lxml')
            if form := soup.find('form', action=re.compile(r'/tasks/claim_all_rewards')):
                self.session.post(f"{BASE_URL}{form['action']}", data={'authenticity_token': (form.find('input', {'name': 'authenticity_token'}) or {}).get('value')}, timeout=15)
                logging.info(Fore.GREEN + "    -> [Aufgaben] Alle eingesammelt!")
        except: pass
    
    def _run_sprechwunsch_processor(self):
        time.sleep(10)
        while True:
            try:
                response = self.session.get(f"{BASE_URL}/api/vehicles")
                for v in [x for x in response.json() if x.get('fms_real') == 5]:
                    vid = v.get('id')
                    try:
                        soup = BeautifulSoup(self.session.get(f"{BASE_URL}/vehicles/{vid}").text, 'lxml')
                        if btn := soup.select_one('.btn-success[href*="/patient/"]'):
                            self.session.get(f"{BASE_URL}{btn['href']}")
                        elif btn := soup.find('a', string='Gefangene entlassen'):
                             if self.PROCESS_PRISONER_REQUESTS:
                                 self.session.post(f"{BASE_URL}{btn['href']}", data={'_method': 'post', 'authenticity_token': (soup.find('meta', {'name': 'csrf-token'}) or {}).get('content')})
                        time.sleep(2)
                    except: pass
            except: pass
            time.sleep(30)

if __name__ == '__main__':
    init(autoreset=True)
    bot = AllrounderBot()
    try:
        send_discord_notification("✅ Turbo-Bot gestartet.")
        bot.run()
    except KeyboardInterrupt:
        logging.info("Beendet.")
    except Exception as e:
        logging.error(f"CRASH: {e}", exc_info=True)
        send_discord_notification(f"🔥 CRASH: ```{e}```")
    finally:
        bot._save_leadership_memory()