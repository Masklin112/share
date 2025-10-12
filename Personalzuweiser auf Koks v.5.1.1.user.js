// ==UserScript==
// @name          Personalzuweiser auf Koks
// @namespace     personalzuweiser.leitstellenspiel.de
// @version       5.1.1
// @license       BSD-3-Clause
// @author        BOS-Ernie, Masklin, BAHendrik (modifiziert und fusioniert durch KI)
// @description   Kombiniert die verbesserte Zuweisungslogik von 4.5.0 mit den Automations-Features von 4.3.1 (Loop, Wachenbauplan, Ausbau etc.).
// @match         https://*.leitstellenspiel.de/buildings/*
// @match         https://*.leitstellenspiel.de/dispatchcenters/*
// @match         https://*.leitstellenspiel.de/vehicles/*/zuweisung
// @run-at        document-idle
// @grant         none
// ==/UserScript==

/* global $, I1n */

(async function () {
    'use strict';

    // ### GRUNDEINSTELLUNGEN (aus 4.5.0) ###
    const forceStatus2OnFull = true;
    const assignMostSeniorFirst = false;
    const skippableCaptionPrefixes = ["anh ", "mzb ", "boot "];
    const maxWorkers = 10;

    // ### NEU: GRUNDEINSTELLUNGEN & HOTKEYS (Kombiniert) ###
    const buildingNextHotkey = "d";
    const buildingPreviousHotkey = "a";
    const applyFleetConfigHotkey = "w";
    const triggerPlanAndAutoAssignHotkey = "x";
    const combinedSequenceHotkey = "y"; // Hotkey for the combined sequence
    const buildingStartVisibleAutoHotkey = "c";
    const buildingStartUnassignVisibleHotkey = "v";
    const buildingStartAutoHotkey = "s";


    // ### INTERNE KONFIGURATION (Kombiniert) ###
    const localStoragePrefix = "personalzuweiser_v4_mod."; // Eigener Prefix um Konflikte zu vermeiden
    const vehiclesConfigKey = localStoragePrefix + "vehicle-type-configurations";
    const storageTtl = 24 * 60 * 60 * 1000;
    const userVehiclesConfigKey = localStoragePrefix + "user-vehicle-configurations";
    const fleetConfigIdStorageKey = localStoragePrefix + "selectedFleetConfigId";
    const loopAssignNewOnlyKey = localStoragePrefix + "loopAssignNewOnly";
    const sequenceStateKey = localStoragePrefix + "sequence.state";
    const superLoopStateKey = localStoragePrefix + "superLoop.state";
    const assignmentLoopStateKey = localStoragePrefix + "assignmentLoop.state";


    let allTrainings = {};
    let csrfToken = document.querySelector("meta[name=csrf-token]")?.content;
    let vehiclesConfiguration = [];
    let isProcessRunning = false;
    const currentVehicleId = window.location.pathname.includes("/vehicles/") ? window.location.pathname.split("/")[2] : null;
    const currentBuildingId = window.location.pathname.includes("/buildings/") ? window.location.pathname.split("/")[2].split("?")[0] : null;
    const isBuildingOverviewPage = window.location.pathname.includes("/buildings/") && !window.location.pathname.includes("/expand");
    const isBuildingExpansionPage = window.location.pathname.includes("/buildings/") && window.location.pathname.includes("/expand");

    // ### NEU: Zustandsvariablen für die neuen Features ###
    let currentSelectedFleetConfigId = localStorage.getItem(fleetConfigIdStorageKey) || null;


    // Harte Overrides, falls die API-Daten unvollständig sind
    const vehiclesConfigurationOverride = [
        { id: 134, caption: "Pferdetransporter klein", maxStaff: 4, training: [{ key: "police_horse", number: 4 }] },
        { id: 135, caption: "Pferdetransporter groß", maxStaff: 2, training: [{ key: "police_horse", number: 2 }] },
        { id: 137, caption: "Zugfahrzeug Pferdetransport", maxStaff: 6, training: [{ key: "police_horse", number: 6 }] },
        { id: 29, caption: "NEF", maxStaff: 1, training: [{ key: "notarzt", number: 1 }] },
        { id: 122, caption: "LKW 7 Lbw (FGr E)", maxStaff: 2, training: [{ key: "thw_energy_supply", number: 2 }] },
        { id: 123, caption: "LKW 7 Lbw (FGr WP)", maxStaff: 3, training: [{ key: "water_damage_pump", number: 3 }] },
        { id: 93, caption: "MTW-O", maxStaff: 5, training: [{ key: "rettungshunde", number: 5 }] },
        { id: 53, caption: "Dekon-P", maxStaff: 6, training: [{ key: "dekon_p", number: 6 }] },
        { id: 81, caption: "MEK - ZF", maxStaff: 3, training: [{ key: "police_mek", number: 3 }] },
        { id: 79, caption: "SEK - ZF", maxStaff: 3, training: [{ key: "police_sek", number: 3 }] },
        { id: 173, caption: "MTW TeSi", maxStaff: 7, training: [{ key: "disaster_response_technology", number: 7 }] },
        { id: 172, caption: "LKW Technik (Notstrom)", maxStaff: 6, training: [{ key: "disaster_response_technology", number: 6 }] },
        { id: 126, caption: "MTF Drohne", maxStaff: 5, training: [{ key: "fire_drone", number: 5 }] },
        { id: 74, caption: "NAW", maxStaff: 3, training: [{ key: "notarzt", number: 3 }] },
        { id: 51, caption: "FüKW (Polizei)", maxStaff: 2, training: [{ key: "police_fukw", number: 2 }] }
    ];

    function log(message) { console.log(`[PZ-Mod] ${message}`); }

    // Die createVehicleGrid Funktion aus 4.5.0 bleibt unverändert
    function createVehicleGrid(vehicles, parentElement = null) {
        const container = document.createElement('div');
        container.id = 'pz-grid-container';
        container.style.cssText = 'display: flex; flex-wrap: wrap; gap: 5px; padding: 10px; border: 1px solid #4a5568; border-radius: 5px; margin-bottom: 15px; background-color: #2d3748;';
        vehicles.forEach(vehicle => {
            const card = document.createElement('div');
            card.id = `pz-card-${vehicle.id}`;
            card.className = 'pz-grid-card pz-status-pending';
            card.textContent = vehicle.caption;
            card.title = vehicle.caption;
            container.appendChild(card);
        });
        document.querySelectorAll('#pz-grid-container').forEach(el => el.remove());
        if (parentElement) {
            parentElement.appendChild(container);
        } else {
    const mainPanel = document.getElementById('pz-main-container');
    if (mainPanel) {
        mainPanel.after(container);
    } else {
        // Fallback auf die alte Methode, falls unser Panel nicht gefunden wird
        const targetElement = document.querySelector("#building_vehicles .panel-heading") || document.querySelector(".tab-content #tabs-vehicle") || document.querySelector(".tab-content");
        if (targetElement) targetElement.prepend(container);
    }
}
    }
    // Die setCardStatus Funktion aus 4.5.0 bleibt unverändert
    function setCardStatus(vehicleId, status) {
        const card = document.getElementById(`pz-card-${vehicleId}`);
        if (card) {
            card.className = 'pz-grid-card';
            card.classList.add(`pz-status-${status}`);
        }
    }

    // Die initVehiclesConfiguration und apply... Funktionen aus 4.5.0 bleiben weitgehend unverändert
    async function initVehiclesConfiguration() {
        const cached = localStorage.getItem(vehiclesConfigKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed.trainings && Object.keys(parsed.trainings).length > 0 && Array.isArray(parsed.data) && parsed.data.length > 0 && parsed.lastUpdate > Date.now() - storageTtl) {
                    log("⚙️ Lade Fahrzeugdaten aus dem Cache.");
                    vehiclesConfiguration = parsed.data;
                    allTrainings = parsed.trainings;
                    applyUserConfiguration();
                    return;
                } else {
                    log("⚠️ Veralteter oder fehlerhafter Cache gefunden. Lade neue Daten von der API.");
                }
            } catch (e) {
                log("❌ Fehler beim Lesen des Cache. Lade neue Daten von der API.");
            }
        }
        try {
            log("☁️ Lade frische Fahrzeug- und Ausbildungsdaten von der LSS-Manager API...");
            const [vehicleResponse, schoolingResponse] = await Promise.all([
                fetch("https://api.lss-manager.de/de_DE/vehicles"),
                fetch("https://api.lss-manager.de/de_DE/schoolings")
            ]);
            if (!vehicleResponse.ok || !schoolingResponse.ok) throw new Error("API-Fehler");
            const [apiData, rawSchoolings] = await Promise.all([vehicleResponse.json(), schoolingResponse.json()]);
            allTrainings = {};
            for (const schoolCategory of Object.values(rawSchoolings)) {
                for (const schooling of schoolCategory) {
                    // Prüft, ob der Schlüssel bereits existiert. Fügt ihn nur hinzu, wenn er neu ist.
                    // Das verhindert das Überschreiben und sorgt für konsistente Bezeichnungen.
                    if (schooling.key && schooling.caption && !allTrainings.hasOwnProperty(schooling.key)) {
                        allTrainings[schooling.key] = schooling.caption;
                    }
                }
            }
            const captionOverrides = {
                'gw_taucher': 'GW-Taucher Lehrgang',
                'gw_wasserrettung': 'GW-Wasserrettung Lehrgang'
            };

            for (const [key, caption] of Object.entries(captionOverrides)) {
                if (allTrainings.hasOwnProperty(key)) {
                    allTrainings[key] = caption;
                }
            }
            const transformedData = transformVehiclesData(apiData);
            vehiclesConfiguration = applyVehicleConfigurationOverride(transformedData);
            localStorage.setItem(vehiclesConfigKey, JSON.stringify({
                lastUpdate: Date.now(), data: vehiclesConfiguration, trainings: allTrainings,
            }));
            applyUserConfiguration();
        } catch (err) {
            log(`❌ Fehler beim Laden der Fahrzeugdaten: ${err.message}`);
        }
    }

    function applyVehicleConfigurationOverride(data) {
        return data.map(vehicleFromApi => {
            const override = vehiclesConfigurationOverride.find(v => v.id === vehicleFromApi.id);
            return override || vehicleFromApi;
        });
    }

    function transformVehiclesData(data) {
        return Object.entries(data).filter(([, v]) => !v.isTrailer).map(([id, v]) => {
            const training = [];
            if (v.staff?.training) {
                for (const courseGroup of Object.values(v.staff.training)) {
                    for (const [key, info] of Object.entries(courseGroup)) {
                        if (info.min && info.min > 0) training.push({ key, number: info.min });
                        else if (info.all === true) training.push({ key, number: v.maxPersonnel });
                    }
                }
            }
            return { id: Number(id), caption: v.caption, maxStaff: v.maxPersonnel, training };
        });
    }

    function applyUserConfiguration() {
        const userConfigStr = localStorage.getItem(userVehiclesConfigKey);
        if (userConfigStr) {
            const userConfig = JSON.parse(userConfigStr);
            vehiclesConfiguration = vehiclesConfiguration.map(defaultConfig => {
                const userOverride = userConfig.find(c => c.id === defaultConfig.id);
                return userOverride ? userOverride : defaultConfig;
            });
        }
    }

    // Die runAssignmentProcess Logik aus 4.5.0 bleibt das Herzstück für die Zuweisung
    async function runAssignmentProcess(vehicleIds, unassignMode = false, isSubProcess = false, uiContainer = null, skipGridCreation = false) {
        // Diese Funktion wird um eine Status-Rückmeldung erweitert, damit der Loop weiß, wann er fertig ist.
        return new Promise(async (resolve, reject) => {
            if (!isSubProcess) { if (isProcessRunning) return reject("Process already running"); isProcessRunning = true; setButtonsDisabled(true); }
            const modeText = unassignMode ? "Entzuweisung" : "Zuweisung";
            log(`🚀 Starte ${modeText} für ${vehicleIds.length} Fahrzeuge...`);
            let incompleteVehicles = new Set();
            try {
                const taskManager = (tasks) => new Promise((resolveManager) => {
                    const taskQueue = [...tasks]; let running = 0;
                    const runNext = () => {
                        if (taskQueue.length === 0 && running === 0) return resolveManager();
                        while (running < maxWorkers && taskQueue.length > 0) {
                            const task = taskQueue.shift(); running++;
                            (async () => {
                                try {
                                    if (task.preTask) task.preTask();
                                    const response = await fetch(task.url, { method: task.method || 'POST', headers: { 'x-csrf-token': csrfToken, 'x-requested-with': 'XMLHttpRequest' } });
                                    if (!response.ok) throw new Error(`Server-Antwort: ${response.status}`);
                                    if (task.postTask) task.postTask('success');
                                } catch (err) {
                                    if (task.postTask) task.postTask('error');
                                    log(`❌ Fehler bei ${task.type || 'Aufgabe'} für Fzg ${task.vehicleId}: ${err.message}`);
                                } finally { running--; runNext(); }
                            })();
                        }
                    }; runNext();
                });
                if (vehicleIds.length === 0) {
                     if (!isSubProcess) { isProcessRunning = false; setButtonsDisabled(false); }
                     return resolve();
                }
                const vehicleDetails = (await Promise.all(vehicleIds.map(id => fetch(`/api/v2/vehicles/${id}`).then(res => res.json()).then(data => data.result).catch(() => null)))).filter(Boolean);
                if (vehicleDetails.length === 0) { log(`[WARN] Konnten für keine der IDs Fahrzeugdetails abrufen.`); }
                if (!skipGridCreation && vehicleDetails.length > 0) { createVehicleGrid(vehicleDetails, uiContainer); }

                log("🧹 Phase 1: Entferne alte Zuweisungen...");
                const allHtmls = await Promise.all(vehicleDetails.map(vehicle => fetch(`/vehicles/${vehicle.id}/zuweisung`).then(r=>r.text()).catch(() => "")));
                let unassignTasks = [];
                allHtmls.forEach((html, index) => {
                    if (!html) return;
                    const vehicle = vehicleDetails[index];
                    const assignedDom = new DOMParser().parseFromString(html, "text/html");
                    assignedDom.querySelectorAll("a.btn-assigned").forEach(btn => {
                        unassignTasks.push({ url: btn.href, vehicleId: vehicle.id, type: 'Entzuweisung', preTask: () => setCardStatus(vehicle.id, 'working'), postTask: () => setCardStatus(vehicle.id, unassignMode ? 'success' : 'pending') });
                    });
                });
                if (unassignTasks.length > 0) await taskManager(unassignTasks);
                log("✅ Alte Zuweisungen entfernt.");

                if (unassignMode) {
                    incompleteVehicles.clear();
                } else if (vehicleDetails.length > 0) {
                    log("🧠 Phase 2: Plane neue Zuweisungen...");
                    let availablePersonnel = [];
                    const sourceVehicleForPersonnel = vehicleDetails.find(v => { const c = vehiclesConfiguration.find(vc => vc.id === v.vehicle_type); return c && c.maxStaff > 0; });
                    if(sourceVehicleForPersonnel) {
                        try {
                            const html = await (await fetch(`/vehicles/${sourceVehicleForPersonnel.id}/zuweisung`)).text();
                            const dom = new DOMParser().parseFromString(html, "text/html");
                            availablePersonnel = Array.from(dom.querySelectorAll("tr[data-filterable-by]")).map(row => {
                                const assignButton = row.querySelector("a.btn-success");
                                if (!assignButton || row.children[2].innerText.trim().startsWith("Im Unterricht")) return null;
                                return { id: assignButton.getAttribute("personal_id"), qualifications: JSON.parse(row.getAttribute("data-filterable-by").replace(/'/g, '"')).filter(Boolean) };
                            }).filter(Boolean);
                        } catch (e) { log(`🚨 Fehler beim Laden der Personalliste: ${e.message}`); }
                    }

                    if (availablePersonnel.length > 0) {
                        let personnelPool = [...availablePersonnel];
                        if (assignMostSeniorFirst) personnelPool.reverse();
                        const assignTasks = [];
                        for (const vehicle of vehicleDetails) {
                            const config = vehiclesConfiguration.find(v => v.id === vehicle.vehicle_type);
                            if (!config || config.maxStaff === 0 || skippableCaptionPrefixes.some(p => vehicle.caption.toLowerCase().startsWith(p))) continue;

                            let assignedPersonnelForThisVehicle = [];
                            for (const req of (config.training || [])) {
                                for (let i = 0; i < req.number && assignedPersonnelForThisVehicle.length < config.maxStaff; i++) {
                                    const personIndex = personnelPool.findIndex(p => (req.key === "") ? p.qualifications.length === 0 : p.qualifications.includes(req.key));
                                    if (personIndex > -1) {
                                        assignedPersonnelForThisVehicle.push(personnelPool.splice(personIndex, 1)[0]);
                                    }
                                }
                            }

                            // Auffüllen, wenn keine Spezialausbildung nötig ist
                            if ((config.training || []).length === 0 && assignedPersonnelForThisVehicle.length < config.maxStaff) {
                                const needed = config.maxStaff - assignedPersonnelForThisVehicle.length;
                                const untrained = personnelPool.filter(p => p.qualifications.length === 0).slice(0, needed);
                                assignedPersonnelForThisVehicle.push(...untrained);
                                personnelPool = personnelPool.filter(p => !untrained.find(u => u.id === p.id));
                            }


                            for (const person of assignedPersonnelForThisVehicle) {
                                assignTasks.push({ url: `/vehicles/${vehicle.id}/zuweisungDo/${person.id}`, vehicleId: vehicle.id });
                            }
                             // KORREKTUR: Die Prüfung auf "unvollständig" berücksichtigt jetzt die Summe der angeforderten Personen, nicht nur die maximale Kapazität.
                             const totalRequestedPersonnel = (config.training || []).reduce((sum, req) => sum + req.number, 0);
                             if (assignedPersonnelForThisVehicle.length < totalRequestedPersonnel) {
                                incompleteVehicles.add(vehicle.id);
                            }
                        }
                        if (assignTasks.length > 0) { await taskManager(assignTasks); log("✅ Zuweisungen gesendet."); }
                    }
                }

                log("📊 Phase 4: Setze FMS-Status...");
                const fmsTasks = [];
                vehicleDetails.forEach(v => {
                    const vehicleId = String(v.id);
                    if (incompleteVehicles.has(v.id)) {
                        fmsTasks.push({ method: 'GET', url: `/vehicles/${vehicleId}/set_fms/6`, vehicleId, postTask: () => setCardStatus(vehicleId, 'error') });
                    } else {
                        if (unassignMode) return;
                        const config = vehiclesConfiguration.find(cfg => cfg.id === v.vehicle_type);
                         if (config && config.maxStaff > 0 && forceStatus2OnFull) {
                            fmsTasks.push({ method: 'GET', url: `/vehicles/${vehicleId}/set_fms/2`, vehicleId, postTask: () => setCardStatus(vehicleId, 'success') });
                        }
                    }
                });
                if (fmsTasks.length > 0) await taskManager(fmsTasks);
                log("✅ FMS-Status aktualisiert.");

                if (!isSubProcess) { log("🏁 Prozess abgeschlossen! Seite wird in 5 Sekunden neu geladen."); setTimeout(() => window.location.reload(), 5000); }
                else { log("✅ Wachen-Abarbeitung abgeschlossen."); }
                resolve();

            } catch (error) {
                log(`❌ Ein schwerwiegender Fehler im Zuweisungsprozess ist aufgetreten: ${error.message}`);
                console.error("Full error details:", error);
                reject(error);
            } finally {
                if (!isSubProcess) { isProcessRunning = false; setButtonsDisabled(false); }
            }
        });
    }

    // Die bestehenden UI- und Hilfsfunktionen aus 4.5.0 bleiben erhalten
    async function resetVehicle() { log("🧹 Personal wird entfernt..."); const buttons = document.querySelectorAll(".btn-assigned.btn.btn-default"); for (let i = buttons.length - 1; i >= 0; i--) { buttons[i].click(); await new Promise(r => setTimeout(r, 250)); } log("✅ Fahrzeug geleert."); }
    function addVehicleAssignmentPageButtons() { const assignHotkey="s",resetHotkey="x",nextVehicleHotkey="d",previousVehicleHotkey="a"; const container = document.querySelector(".vehicles-education-filter-box"); if (!container) return; const group = document.createElement("div"); group.className = "btn-group", group.style.marginLeft = "10px"; const assignBtn = document.createElement("button"); assignBtn.className = "btn btn-success", assignBtn.innerHTML = '<span class="glyphicon glyphicon-ok"></span> Zuweisen', assignBtn.title = `Optimal zuweisen (${assignHotkey.toUpperCase()})`, assignBtn.addEventListener("click", ()=>{ /* Die Einzelzuweisung wird hier nicht mehr benötigt, da alles über runAssignmentProcess läuft */ }); const resetBtn = document.createElement("button"); resetBtn.className = "btn btn-danger", resetBtn.innerHTML = '<span class="glyphicon glyphicon-trash"></span> Leeren', resetBtn.title = `Personal entfernen (${resetHotkey.toUpperCase()})`, resetBtn.addEventListener("click", resetVehicle); group.append(assignBtn, resetBtn), container.appendChild(group); document.addEventListener("keydown", async e => { if (document.activeElement?.tagName.match(/INPUT|TEXTAREA/)) return; const key = e.key.toLowerCase(); if (key === assignHotkey) e.preventDefault(); else if (key === resetHotkey) e.preventDefault(), resetVehicle(); else if (key === nextVehicleHotkey) e.preventDefault(), document.querySelectorAll(".btn-group.pull-right a")[1]?.click(); else if (key === previousVehicleHotkey) e.preventDefault(), document.querySelectorAll(".btn-group.pull-right a")[0]?.click(); }); }
    function getVisibleVehicleIds() { return Array.from(document.querySelectorAll('#vehicle_table tbody tr')).filter(row => row.style.display !== 'none' && !row.classList.contains('tablesorter-filtered')).map(row => row.querySelector('a[href*="/vehicles/"]')?.href.match(/\/vehicles\/(\d+)/)?.[1]).filter(Boolean); }
    function getAllVehicleIds() { return Array.from(document.querySelectorAll("#building_vehicles a[href*='/vehicles/'], #vehicle_table a[href*='/vehicles/']")).map(a => a.href.match(/\/vehicles\/(\d+)/)?.[1]).filter((v, i, s) => s.indexOf(v) === i); }
    function setButtonsDisabled(disabled) { document.querySelectorAll('#pz-button-group button, #pz-loop-button-group button').forEach(btn => btn.disabled = disabled); }


    // =================================================================================
    // ### NEU: KOMPLETT NEUE FUNKTIONEN AUS 4.3.1 (angepasst für 4.5.0) ###
    // =================================================================================

    // Speichert/Löscht den Zustand von Loops und Sequenzen
    function saveState(key, state) {
        if (state) localStorage.setItem(key, JSON.stringify(state));
        else localStorage.removeItem(key);
    }
    // Liest den Zustand von Loops und Sequenzen
    function getState(key) {
        const state = localStorage.getItem(key);
        return state ? JSON.parse(state) : null;
    }

    // Hilfsfunktion, um auf das Erscheinen eines Elements zu warten
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                const element = document.querySelector(selector);
                if (element) { clearInterval(interval); resolve(element); }
            }, 100);
            setTimeout(() => { clearInterval(interval); resolve(null); }, timeout);
        });
    }

    // Holt die aktuelle Ausbaustufe des Gebäudes
    function getCurrentBuildingLevel() {
        const dt = Array.from(document.querySelectorAll('dt')).find(d => d.textContent.includes('Stufe:'));
        const level = dt ? parseInt(dt.nextElementSibling.textContent, 10) : -1;
        return isNaN(level) ? -1 : level;
    }

    // Startet die kombinierte Sequenz (Ausbau -> Bauplan -> Personal)
    async function startCombinedSequence(isLoop = false) {
    log("🎬 Starte kombinierte Sequenz...");

    const useFleetPlanToggleKey = localStoragePrefix + "useFleetPlan";
    const useFleetPlan = JSON.parse(localStorage.getItem(useFleetPlanToggleKey)) ?? true;

    if (useFleetPlan) {
        const expandButton = document.querySelector('a.btn[href*="/expand"]');
        const levelInput = document.getElementById('lss-expand-level-input');
        const targetLevel = levelInput ? parseInt(levelInput.value, 10) : 0;
        const assignNewOnly = document.getElementById('pz-new-only-toggle')?.checked || false;

        if (!currentSelectedFleetConfigId) {
            alert('Bitte zuerst einen Wachenbauplan auswählen...');
            if (isLoop) saveState(superLoopStateKey, null);
            return;
        }

        const currentLevel = getCurrentBuildingLevel();
        const shouldExpand = expandButton && levelInput && !isNaN(targetLevel) && targetLevel > currentLevel;
        const oldVehicleIds = getAllVehicleIds();

        if (shouldExpand) {
            log("Starte Ausbau und bereite nächsten Schritt vor (Wachenbauplan)...");
            // KORREKTUR: Der nächste Schritt nach dem Ausbau ist jetzt der Wachenbauplan, nicht die Personalzuweisung.
            const nextState = {
                active: true,
                step: "apply_fleet_config", // Dies war der Fehler, hier stand "start_personnel_assignment"
                buildingId: currentBuildingId,
                newOnly: assignNewOnly,
                oldVehicles: oldVehicleIds,
                fleetConfigId: currentSelectedFleetConfigId
            };
            saveState(sequenceStateKey, nextState); // Zustand für NACH den Ausbau speichern.
            const expansionUrl = `/buildings/${currentBuildingId}/expand_do/credits?level=${targetLevel - 1}`;
            try {
                const response = await fetch(expansionUrl);
                if (!response.ok) throw new Error(`Server-Antwort: ${response.status}`);
                window.location.reload();
            } catch (err) {
                log(`❌ Fehler beim Ausbau: ${err.message}`);
                saveState(sequenceStateKey, null);
            }
        } else {
            log("Starte Wachenbauplan und bereite nächsten Schritt vor (Personalzuweisung)...");
             // Der Zustand, der NACH einem Neuladen gelten soll.
            const nextState = {
                active: true,
                step: "start_personnel_assignment",
                buildingId: currentBuildingId,
                newOnly: assignNewOnly,
                oldVehicles: oldVehicleIds,
                fleetConfigId: currentSelectedFleetConfigId
            };

            const fleetButton = document.querySelector(`a.btn[vehicle-fleet-configuration-id="${currentSelectedFleetConfigId}"]`);
            if (fleetButton) {
                // Listener für den Fall, dass KEIN Neuladen stattfindet
                document.body.addEventListener('ba:fleetCompleted', function handleFleetCompletion(event) {
                    if (event.detail.status === 'skipped') {
                        log("Keine Fahrzeuge gekauft. Starte Personalzuweisung manuell.");
                        handleSequenceController();
                    }
                }, { once: true });

                saveState(sequenceStateKey, nextState);
                fleetButton.click();
            } else {
                alert("Fehler: Wachenbauplan-Button nicht gefunden.");
                saveState(sequenceStateKey, null);
                if (isLoop) saveState(superLoopStateKey, null);
            }
        }
    } else {
        // Dieser Teil für "Ohne Plan" bleibt unverändert
        log("🎬 Starte Sequenz nur für Personalzuweisung (Wachenbauplan übersprungen).");
        const vehicleIds = getAllVehicleIds();
        await runAssignmentProcess(vehicleIds, false, true);
        if (isLoop) {
            handleLoopNavigation();
        } else {
            log("🏁 Einzelprozess abgeschlossen! Seite wird in 5 Sekunden neu geladen.");
            setTimeout(() => window.location.reload(), 5000);
        }
    }
}
    // Kern-Controller, der den Zustand der Sequenz über Seiten-Neuladungen hinweg steuert
    async function handleSequenceController() {
        const state = getState(sequenceStateKey);
        if (!state?.active || state.buildingId !== currentBuildingId) {
            if (state) saveState(sequenceStateKey, null); // Alten State aufräumen
            return;
        }
        log(`🔄 Sequenz-Controller aktiv. Schritt: ${state.step}`);

        if (isBuildingOverviewPage && state.step === "apply_fleet_config") {
            log(`➡️ Sequenz: Wende Wachenbauplan an.`);
            const fleetButton = await waitForElement(`a.btn[vehicle-fleet-configuration-id="${state.fleetConfigId}"]`);
            if(fleetButton) {
                state.step = "start_personnel_assignment";
                saveState(sequenceStateKey, state);
                fleetButton.click();
            } else {
                log(`❌ FEHLER: Button für Wachenbauplan nicht gefunden. Breche Sequenz ab.`);
                alert("Sequenz abgebrochen: Wachenbauplan-Button nicht gefunden.");
                saveState(sequenceStateKey, null);
                saveState(superLoopStateKey, null); // Auch Loop stoppen
            }
        } else if (isBuildingOverviewPage && state.step === "start_personnel_assignment") {
            log("➡️ Sequenz: Starte Personalzuweisung.");
            const currentVehicleIds = getAllVehicleIds();
            const vehicleIdsToAssign = state.newOnly
                ? currentVehicleIds.filter(id => !state.oldVehicles.includes(id))
                : currentVehicleIds;

             if (state.newOnly && vehicleIdsToAssign.length === 0) {
                log("ℹ️ Keine neuen Fahrzeuge gefunden. Zuweisung wird übersprungen.");
                saveState(sequenceStateKey, null); // Sequenz für diese Wache beenden
                handleLoopNavigation(); // Nächste Wache im Loop ansteuern
                return;
            }

            log(`Zuweisung für ${vehicleIdsToAssign.length} Fahrzeuge wird gestartet (Modus: ${state.newOnly ? 'Nur neue' : 'Alle'}).`);
            saveState(sequenceStateKey, null); // Zustand löschen, da die Zuweisung jetzt startet
            await runAssignmentProcess(vehicleIdsToAssign, false, true); // Als Sub-Prozess laufen lassen
            handleLoopNavigation(); // Nach Abschluss zur nächsten Wache
        }
    }

    // Steuert die Navigation zum nächsten Gebäude, wenn ein Loop aktiv ist
    function handleLoopNavigation() {
        const superLoopState = getState(superLoopStateKey);
        const assignmentLoopState = getState(assignmentLoopStateKey);

        if (superLoopState?.active || assignmentLoopState?.active) {
            log(`🔁 Loop aktiv: Navigiere zum nächsten Gebäude.`);
            const nextButton = document.evaluate(`//a[contains(text(),'Nächstes Gebäude')]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (nextButton) {
                // WICHTIG: Kurze Verzögerung, damit alle FMS-Status-Änderungen durch sind.
                setTimeout(() => nextButton.click(), 1000);
            } else {
                log("🛑 Loop Ende: 'Nächstes Gebäude' Button nicht gefunden. Stoppe Loop.");
                saveState(superLoopStateKey, null);
                saveState(assignmentLoopState, null);
            }
        }
    }

    // Fügt das UI für die Wachenbauplan-Auswahl und den Ausbau hinzu
    function addBuildingPageUI() {
        if (document.getElementById('pz-main-container')) return;

        let targetElement = document.querySelector("#vehicle.tab-pane, #vehicle_table_wrapper") || document.getElementById('vehicle_table');
        if (!targetElement) return;
        log("UI-Ankerpunkt gefunden. Initialisiere modernes UI.");

        const mainContainer = document.createElement("div");
        mainContainer.id = 'pz-main-container';

        // Linke Spalte für alle Steuerelemente
        const leftPanel = document.createElement('div');
        leftPanel.id = 'pz-left-panel';

        // Rechter Bereich für die Personal-Anzeige
        const surplusPanel = document.createElement('div');
        surplusPanel.id = 'pz-surplus-display-container';

        // Der Trennstrich kommt zwischen die beiden Spalten
        const separator = document.createElement('div');
        separator.className = 'pz-vertical-separator';


        // --- Alle Steuerelemente werden jetzt in der linken Spalte erstellt ---

        const btnRow1 = document.createElement("div");
        btnRow1.className = "pz-button-row";

        const startAllBtn = document.createElement("button");
        startAllBtn.className = "pz-mod-btn pz-green";
        startAllBtn.innerHTML = `<span class="glyphicon glyphicon-tasks"></span> Zuweisen (alle) (${buildingStartAutoHotkey.toUpperCase()})`;
        startAllBtn.addEventListener("click", () => runAssignmentProcess(getAllVehicleIds(), false));
        const startVisibleBtn = document.createElement("button");
        startVisibleBtn.className = "pz-mod-btn pz-blue";
        startVisibleBtn.innerHTML = `<span class="glyphicon glyphicon-eye-open"></span> Zuweisen (sichtb.) (${buildingStartVisibleAutoHotkey.toUpperCase()})`;
        startVisibleBtn.addEventListener("click", () => runAssignmentProcess(getVisibleVehicleIds(), false));
        const unassignVisibleBtn = document.createElement("button");
        unassignVisibleBtn.className = "pz-mod-btn pz-orange";
        unassignVisibleBtn.innerHTML = `<span class="glyphicon glyphicon-ban-circle"></span> Aufheben (sichtb.) (${buildingStartUnassignVisibleHotkey.toUpperCase()})`;
        unassignVisibleBtn.addEventListener("click", () => runAssignmentProcess(getVisibleVehicleIds(), true));

        btnRow1.append(startAllBtn, startVisibleBtn, unassignVisibleBtn);


        const btnRow2 = document.createElement("div");
        btnRow2.className = "pz-button-row";

        const sequenceBtn = document.createElement('button');
        sequenceBtn.className = 'pz-mod-btn pz-purple';
        sequenceBtn.innerHTML = `<span class="glyphicon glyphicon-play-circle"></span> Plan & Personal (${combinedSequenceHotkey.toUpperCase()})`;
        sequenceBtn.title = `Startet die Sequenz: Wachenbauplan anwenden, dann Personal zuweisen.`;
        sequenceBtn.onclick = () => startCombinedSequence(false);

        const superLoopBtn = document.createElement("button");
        superLoopBtn.id = 'lss-super-loop-button';
        const updateLoopBtn = () => {
             const state = getState(superLoopStateKey);
             if (state?.active) {
                superLoopBtn.className = "pz-mod-btn loop-active";
                superLoopBtn.innerHTML = `<span class="glyphicon glyphicon-stop"></span> STOPP Loop (${combinedSequenceHotkey.toUpperCase()}+SHIFT)`;
             } else {
                superLoopBtn.className = "pz-mod-btn pz-purple";
                superLoopBtn.innerHTML = `<span class="glyphicon glyphicon-repeat"></span> START Loop (${combinedSequenceHotkey.toUpperCase()}+SHIFT)`;
             }
        };
        superLoopBtn.addEventListener('click', () => {
             let state = getState(superLoopStateKey) || { active: false };
             state.active = !state.active;
             saveState(superLoopStateKey, state);
             updateLoopBtn();
             if(state.active) {
                 log("🔁 Super-Loop gestartet.");
                 startCombinedSequence(true);
             } else {
                 log("🛑 Super-Loop gestoppt.");
             }
        });
        updateLoopBtn();

        const settingsBtn = document.createElement("button");
        settingsBtn.className = "pz-mod-btn pz-settings-btn";
        settingsBtn.innerHTML = '<span class="glyphicon glyphicon-cog"></span>';
        settingsBtn.title = "Einstellungen";
        settingsBtn.addEventListener("click", createSettingsModal);

        btnRow2.append(sequenceBtn, superLoopBtn, settingsBtn);


        const addonContainer = document.createElement('div');
        addonContainer.className = 'pz-addon-container';

        const expandButton = document.querySelector('a.btn[href*="/expand"]');
        if (expandButton) {
            const expandContainer = document.createElement('span');
            expandContainer.style.cssText = 'display: inline-flex; align-items: center; gap: 5px; color: #cbd5e0;';
            expandContainer.innerHTML = `<span>Ausbau bis Lvl:</span>`;
            const storageKeyLevel = localStoragePrefix + "expandTargetLevel";
            const levelInput = document.createElement('input');
            levelInput.type = 'number';
            levelInput.min = '1';
            levelInput.id = 'lss-expand-level-input';
            levelInput.value = localStorage.getItem(storageKeyLevel) || '10';
            levelInput.style.cssText = "width:60px; height:28px; text-align:center; border:1px solid #4a5568; border-radius:5px; background-color: #1a202c; color: white;";
            levelInput.addEventListener('input', () => localStorage.setItem(storageKeyLevel, levelInput.value));
            expandContainer.appendChild(levelInput);
            addonContainer.appendChild(expandContainer);
        }

        const useFleetPlanToggleKey = localStoragePrefix + "useFleetPlan";
        const fleetPlanToggleContainer = document.createElement('div');
        fleetPlanToggleContainer.className = 'lss-toggle-switch-container';
        fleetPlanToggleContainer.title = 'Legt fest, ob der Wachenbauplan (Fahrzeugkauf) Teil der Sequenz sein soll.';
        fleetPlanToggleContainer.style.color = '#cbd5e0';
        const fleetPlanToggleLabel = document.createElement('label');
        fleetPlanToggleLabel.className = 'lss-toggle-switch';
        const fleetPlanToggleInput = document.createElement('input');
        fleetPlanToggleInput.type = 'checkbox';
        fleetPlanToggleInput.id = 'pz-use-fleet-plan-toggle';
        fleetPlanToggleInput.checked = JSON.parse(localStorage.getItem(useFleetPlanToggleKey)) ?? true;
        const fleetPlanToggleSlider = document.createElement('span');
        fleetPlanToggleSlider.className = 'lss-slider';
        fleetPlanToggleLabel.append(fleetPlanToggleInput, fleetPlanToggleSlider);
        fleetPlanToggleContainer.append(document.createTextNode('Ohne Plan'), fleetPlanToggleLabel, document.createTextNode('Mit Plan'));
        fleetPlanToggleInput.addEventListener('change', () => {
            localStorage.setItem(useFleetPlanToggleKey, fleetPlanToggleInput.checked);
            log(`Wachenbauplan-Modus geändert auf: ${fleetPlanToggleInput.checked ? 'Aktiviert' : 'Deaktiviert'}`);
        });
        addonContainer.appendChild(fleetPlanToggleContainer);

        const toggleContainer = document.createElement('div');
        toggleContainer.className = 'lss-toggle-switch-container';
        toggleContainer.title = 'Legt fest, ob Personal für ALLE oder NUR für NEUE Fahrzeuge nach dem Bauplan zugewiesen wird.';
        toggleContainer.style.color = '#cbd5e0';
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'lss-toggle-switch';
        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.id = 'pz-new-only-toggle';
        toggleInput.checked = JSON.parse(localStorage.getItem(loopAssignNewOnlyKey)) || false;
        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'lss-slider';
        toggleLabel.append(toggleInput, toggleSlider);
        toggleContainer.append(document.createTextNode('Alle Fahrzeuge'), toggleLabel, document.createTextNode('Nur neue Fahrzeuge'));
        toggleInput.addEventListener('change', () => {
            localStorage.setItem(loopAssignNewOnlyKey, toggleInput.checked);
            log(`Zuweisungsmodus geändert auf: ${toggleInput.checked ? 'Nur neue' : 'Alle'}`);
        });
        addonContainer.appendChild(toggleContainer);

        // Alle Elemente der linken Spalte zuweisen
        leftPanel.append(btnRow1, btnRow2, addonContainer);

        // Die fertigen Spalten dem Hauptcontainer zuweisen
        mainContainer.append(leftPanel, separator, surplusPanel);
        targetElement.before(mainContainer);

        document.addEventListener("keydown", async e => {
            if (document.activeElement?.tagName.match(/INPUT|TEXTAREA/)) return;
            const key = e.key.toLowerCase();
            if (key === combinedSequenceHotkey) {
                e.preventDefault();
                if (e.shiftKey) superLoopBtn.click();
                else sequenceBtn.click();
            } else if (key === applyFleetConfigHotkey) {
                 e.preventDefault();
                 document.querySelector(`a.btn[vehicle-fleet-configuration-id="${currentSelectedFleetConfigId}"]`)?.click();
            } else if (key === buildingNextHotkey || key === buildingPreviousHotkey) {
                 if (getState(superLoopStateKey)?.active || getState(assignmentLoopStateKey)?.active) return;
                 e.preventDefault();
                 const selector = key === buildingNextHotkey ? "Nächstes Gebäude" : "Vorheriges Gebäude";
                 document.evaluate(`//a[contains(text(),'${selector}')]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue?.click();
            } else if (key === buildingStartAutoHotkey) {
                e.preventDefault();
                startAllBtn.click();
            } else if (key === buildingStartVisibleAutoHotkey) {
                e.preventDefault();
                startVisibleBtn.click();
            } else if (key === buildingStartUnassignVisibleHotkey) {
                e.preventDefault();
                unassignVisibleBtn.click();
            }
        });
    }
    // Erweitert die Wachenbauplan-Buttons, um die ID zu speichern
    function enhanceFleetConfigurationButtons() {
        const buttons = document.querySelectorAll("a.btn.btn-default.btn-xs[vehicle-fleet-configuration-id]");
        buttons.forEach(button => {
            const configId = button.getAttribute("vehicle-fleet-configuration-id");
            if (button.nextElementSibling?.classList.contains("fleet-config-id-display")) return;

            const idDisplay = document.createElement("span");
            idDisplay.textContent = button.textContent.trim();
            idDisplay.title = `Konfiguration '${button.textContent.trim()}' (ID: ${configId}) auswählen`;
            idDisplay.className = "fleet-config-id-display";
            if (configId === currentSelectedFleetConfigId) {
                idDisplay.classList.add("selected-fleet-config-id");
            }
            idDisplay.addEventListener("click", function() {
                document.querySelectorAll(".selected-fleet-config-id").forEach(el => el.classList.remove("selected-fleet-config-id"));
                this.classList.add("selected-fleet-config-id");
                currentSelectedFleetConfigId = configId;
                localStorage.setItem(fleetConfigIdStorageKey, configId);
                log(`Ausgewählte Flottenkonfiguration: "${this.textContent}" (ID: ${configId})`);
            });
            button.insertAdjacentElement('afterend', idDisplay);
        });
    }

    // Fügt das benötigte CSS für die neuen UI-Elemente hinzu
    function addCustomLoopStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .fleet-config-id-display { margin-left: 5px; padding: 3px 8px; border: 1px solid #4a5568; cursor: pointer; display: inline-block; vertical-align: middle; font-size: 12px; border-radius: 3px; background-color: #2d3748; color: white; }
            .selected-fleet-config-id { border: 2px solid #38a169 !important; font-weight: bold; background-color: #2c7a7b !important; }
            .lss-toggle-switch-container { display: inline-flex; align-items: center; margin-left: 8px; vertical-align: middle; gap: 5px; }
            .lss-toggle-switch { position: relative; display: inline-block; width: 50px; height: 24px; }
            .lss-toggle-switch input { opacity: 0; width: 0; height: 0; }
            .lss-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #4a5568; transition: .4s; border-radius: 24px; }
            .lss-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .lss-slider { background-color: #38a169; }
            input:checked + .lss-slider:before { transform: translateX(26px); }
        `;
        document.head.appendChild(style);
    }

    // Die Einstellungs-Modal-Funktionen aus 4.5.0 bleiben unverändert
    function createSettingsModal() {
        const modal = document.createElement('div');
        modal.id = 'pz-settings-modal';
        modal.style.cssText = 'position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;';
        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'background-color: #2d3748; color: white; padding: 20px; border: 1px solid #4a5568; border-radius: 8px; width: 90%; max-width: 800px; max-height: 80vh; display: flex; flex-direction: column;';
        modal.appendChild(modalContent);
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';
        header.innerHTML = '<h3 style="margin: 0;">Personalzuweiser Einstellungen</h3>';
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.className = 'btn btn-danger';
        closeBtn.onclick = () => document.getElementById('pz-settings-modal').remove();
        header.appendChild(closeBtn);
        modalContent.appendChild(header);
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.placeholder = 'Fahrzeugtyp filtern...';
        filterInput.className = 'form-control';
        filterInput.style.marginBottom = '15px';
        filterInput.onkeyup = () => {
            const filterValue = filterInput.value.toLowerCase();
            document.querySelectorAll('.pz-vehicle-setting-row').forEach(row => {
                row.style.display = row.dataset.caption.toLowerCase().includes(filterValue) ? '' : 'none';
            });
        };
        modalContent.appendChild(filterInput);
        const vehicleList = document.createElement('div');
        vehicleList.id = 'pz-settings-vehicle-list';
        vehicleList.style.cssText = 'overflow-y: auto; flex-grow: 1; padding-right: 10px;';
        modalContent.appendChild(vehicleList);
        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top: 15px; text-align: right;';
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Speichern & Schließen';
        saveBtn.className = 'btn btn-success';
        saveBtn.onclick = saveAndCloseSettings;
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Alle Overrides zurücksetzen';
        resetBtn.className = 'btn btn-warning';
        resetBtn.style.marginRight = '10px';
        resetBtn.onclick = () => {
             if(confirm('Möchtest du wirklich alle deine persönlichen Zuweisungsregeln löschen?')) {
                 localStorage.removeItem(userVehiclesConfigKey);
                 document.getElementById('pz-settings-modal').remove();
                 log("✅ Benutzereinstellungen zurückgesetzt. Seite wird neu geladen.");
                 setTimeout(() => window.location.reload(), 1000);
             }
        };
        footer.append(resetBtn, saveBtn);
        modalContent.appendChild(footer);
        document.body.appendChild(modal);
        populateSettingsModal();
    }
    function populateSettingsModal() {
        const list = document.getElementById('pz-settings-vehicle-list');
        list.innerHTML = '';
        vehiclesConfiguration.sort((a,b) => a.caption.localeCompare(b.caption)).forEach(vehicle => {
            const row = document.createElement('div');
            row.className = 'pz-vehicle-setting-row';
            row.dataset.id = vehicle.id;
            row.dataset.caption = vehicle.caption;
            row.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding: 5px; border-bottom: 1px solid #4a5568;';
            row.innerHTML = `<div style="flex: 2; font-weight: bold;">${vehicle.caption}</div><div style="flex: 1;">Max. Pers.: <input type="number" class="form-control input-sm pz-max-staff" value="${vehicle.maxStaff}" min="0" style="width: 60px; display: inline-block;"></div><div style="flex: 3;" class="pz-training-container"></div>`;
            const trainingContainer = row.querySelector('.pz-training-container');
            (vehicle.training || []).forEach(t => trainingContainer.appendChild(createTrainingRow(t.key, t.number)));
            const addTrainingBtn = document.createElement('button');
            addTrainingBtn.textContent = '+ Ausbildung';
            addTrainingBtn.className = 'btn btn-primary btn-xs';
            addTrainingBtn.onclick = () => trainingContainer.insertBefore(createTrainingRow(), addTrainingBtn);
            trainingContainer.appendChild(addTrainingBtn);
            list.appendChild(row);
        });
    }
    function createTrainingRow(selectedKey = '', selectedNumber = 1) {
        const div = document.createElement('div');
        div.className = 'pz-training-row';
        div.style.cssText = 'display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; padding: 8px; border: 1px solid #4a5568; border-radius: 4px;'; // Layout für Suchfeld angepasst

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Lehrgang suchen...';
        searchInput.className = 'form-control input-sm';
        searchInput.style.marginBottom = '5px';

        const controlsDiv = document.createElement('div');
        controlsDiv.style.cssText = 'display: flex; gap: 5px;';

        const select = document.createElement('select');
        select.className = 'form-control input-sm';
        select.innerHTML = '<option value="">Ohne Ausbildung</option>' +
            Object.entries(allTrainings)
            .sort(([, a], [, b]) => a.localeCompare(b)) // Alphabetisch sortieren
            .map(([key, caption]) => `<option value="${key}" ${key === selectedKey ? 'selected' : ''}>${caption}</option>`).join('');

        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.className = 'form-control input-sm';
        numberInput.value = selectedNumber;
        numberInput.min = 1;
        numberInput.style.width = '60px';

        const removeBtn = document.createElement('button');
        removeBtn.innerHTML = '&times;';
        removeBtn.className = 'btn btn-danger btn-xs';
        removeBtn.onclick = () => div.remove();

        // Event-Listener für das Suchfeld
        searchInput.addEventListener('keyup', () => {
            const filterValue = searchInput.value.toLowerCase();
            const currentSelection = select.value;
            let firstVisibleOption = null;

            Array.from(select.options).forEach(option => {
                const optionVisible = option.value === "" || option.text.toLowerCase().includes(filterValue);
                option.style.display = optionVisible ? '' : 'none';
                if (optionVisible && !firstVisibleOption) {
                    firstVisibleOption = option;
                }
            });

            // Wenn die aktuell ausgewählte Option ausgeblendet wird, setze die Auswahl auf die erste sichtbare
            if (select.options[select.selectedIndex].style.display === 'none' && firstVisibleOption) {
                select.value = firstVisibleOption.value;
            }
        });

        controlsDiv.append(select, numberInput, removeBtn);
        div.append(searchInput, controlsDiv);
        return div;
    }
    function saveAndCloseSettings() {
        const userConfig = [];
        document.querySelectorAll('.pz-vehicle-setting-row').forEach(row => {
            const training = [];
            row.querySelectorAll('.pz-training-row').forEach(tRow => {
                const key = tRow.querySelector('select').value;
                const number = parseInt(tRow.querySelector('input[type="number"]').value, 10);
                if (key !== null && number > 0) {
                    training.push({ key, number });
                }
            });
            userConfig.push({
                id: parseInt(row.dataset.id, 10),
                caption: row.dataset.caption,
                maxStaff: parseInt(row.querySelector('.pz-max-staff').value, 10),
                training: training
            });
        });
        localStorage.setItem(userVehiclesConfigKey, JSON.stringify(userConfig));
        log("✅ Einstellungen gespeichert. Sie werden beim nächsten Lauf oder nach einem Neuladen der Seite angewendet.");
        applyUserConfiguration();
        document.getElementById('pz-settings-modal').remove();
    }
    function addBaseStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .pz-grid-card { width: 120px; min-height: 40px; border-radius: 4px; color: white; font-size: 11px; padding: 4px; text-align: center; transition: background-color 0.3s ease; display: flex; align-items: center; justify-content: center; white-space: normal; word-break: break-word; }
            .pz-status-pending { background-color: #4a5568; }
            .pz-status-working { background-color: #d69e2e; animation: pz-pulse 1.5s infinite; }
            .pz-status-success { background-color: #38a169; }
            .pz-status-error { background-color: #c53030; }
            @keyframes pz-pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } }
            #pz-settings-modal .form-control { background-color: #1a202c; color: white; border-color: #4a5568; }
        `;
        document.head.appendChild(style);
    }

    function addModernUIStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #pz-main-container {
                display: flex;
                background-color: rgba(45, 55, 72, 0.8);
                border: 1px solid #4a5568;
                border-radius: 12px;
                padding: 10px 15px;
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
                backdrop-filter: blur(5px);
                margin-bottom: 20px !important;
            }

            #pz-left-panel {
                flex-grow: 1;
            }
            #pz-surplus-display-container {
                flex-basis: 350px;
                flex-shrink: 0;
            }

            .pz-button-row {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                align-items: center;
                margin-bottom: 10px;
            }

            .pz-addon-container {
                 display: flex;
                 align-items: center;
                 flex-wrap: wrap;
                 gap: 20px;
                 padding-top: 10px;
                 margin-top: 0; /* War -5px, 0 ist sauberer */
                 border-top: 1px solid #4a5568;
            }

            .pz-vertical-separator {
                width: 1px;
                background-color: #4a5568;
                align-self: stretch;
                margin: 0 15px;
            }

            .pz-mod-btn {
                border: none;
                border-radius: 8px;
                padding: 10px 15px;
                font-size: 13px;
                font-weight: bold;
                color: white;
                cursor: pointer;
                transition: all 0.2s ease-in-out;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2), inset 0 -2px 1px rgba(0,0,0,0.1);
                display: inline-flex;
                align-items: center;
                gap: 8px;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.2);
            }
            .pz-mod-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 12px rgba(0, 0, 0, 0.3), inset 0 -2px 1px rgba(0,0,0,0.1);
            }
            .pz-mod-btn:active {
                transform: translateY(1px);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2), inset 0 -1px 1px rgba(0,0,0,0.1);
            }

            .pz-green { background: linear-gradient(145deg, #4CAF50, #388E3C); }
            .pz-blue { background: linear-gradient(145deg, #2196F3, #1976D2); }
            .pz-orange { background: linear-gradient(145deg, #FF9800, #F57C00); }
            .pz-purple { background: linear-gradient(145deg, #673AB7, #512DA8); }

            .pz-settings-btn {
                background: linear-gradient(145deg, #2D3748, #1A202C);
            }
            .pz-settings-btn .glyphicon {
                font-size: 14px;
            }

            .pz-mod-btn.loop-active {
                 background: linear-gradient(145deg, #e53e3e, #c53030);
                 animation: pulse-red 2s infinite;
            }
            @keyframes pulse-red {
                0% { box-shadow: 0 0 0 0 rgba(229, 62, 62, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(229, 62, 62, 0); }
                100% { box-shadow: 0 0 0 0 rgba(229, 62, 62, 0); }
            }

            #pz-surplus-container {
                height: 100%;
            }
            #pz-surplus-container h4 {
                margin: 0 0 10px 0;
                color: #ffc107;
                font-size: 16px;
                font-weight: normal;
            }
            #pz-surplus-container ul {
                margin: 0;
                padding-left: 20px;
                color: #f8f9fa;
                list-style-type: disc;
            }
            #pz-surplus-container li {
                font-size: 14px;
                margin-bottom: 5px;
            }
            #pz-surplus-container li::marker {
                color: #ffc107;
            }
            #pz-surplus-container p {
                color: #f8f9fa;
                margin: 0;
                font-size: 14px;
            }
        `;
        document.head.appendChild(style);
    }

    async function analyzeAndDisplaySurplusPersonnel() {
        log("Analysiere Personal-Überschuss...");

        const targetContainer = document.getElementById('pz-surplus-display-container');
        if (!targetContainer) {
            log("Ziel-Container für Überschuss-Anzeige nicht gefunden.");
            return;
        }

        const firstVehicleLink = document.querySelector('#vehicle_table a[href*="/vehicles/"]');
        if (!firstVehicleLink) {
            log("Kein Fahrzeug auf der Wache gefunden, um Personalliste abzurufen.");
            targetContainer.innerHTML = `
                <div id="pz-surplus-container">
                    <h4>Freies Ausgebildetes Personal</h4>
                    <p>Personalliste nicht abrufbar.</p>
                </div>`;
            return;
        }

        const personnelCounts = {};
        try {
            const response = await fetch(firstVehicleLink.href + '/zuweisung');
            const html = await response.text();
            const dom = new DOMParser().parseFromString(html, "text/html");
            dom.querySelectorAll("tr[data-filterable-by]").forEach(row => {
                if (row.children[2].innerText.trim().startsWith("Im Unterricht")) return;
                const qualifications = JSON.parse(row.getAttribute('data-filterable-by').replace(/'/g, '"'));
                qualifications.filter(Boolean).forEach(q => {
                    personnelCounts[q] = (personnelCounts[q] || 0) + 1;
                });
            });
        } catch (e) {
            log("Fehler beim Abrufen der Personalliste für Überschuss-Analyse.");
            return;
        }

        const neededPersonnel = {};
        document.querySelectorAll('#vehicle_table img[vehicle_type_id]').forEach(img => {
            const typeId = parseInt(img.getAttribute('vehicle_type_id'), 10);
            const config = vehiclesConfiguration.find(v => v.id === typeId);
            if (config?.training) {
                config.training.forEach(req => {
                    neededPersonnel[req.key] = (neededPersonnel[req.key] || 0) + req.number;
                });
            }
        });

        const surplusMessages = [];
        for (const trainingKey in personnelCounts) {
            if (!allTrainings[trainingKey]) continue;
            const surplus = (personnelCounts[trainingKey] || 0) - (neededPersonnel[trainingKey] || 0);
            if (surplus > 0) {
                surplusMessages.push(`<li><strong>${surplus}x</strong> ${allTrainings[trainingKey] || trainingKey}</li>`);
            }
        }

        if (surplusMessages.length > 0) {
            targetContainer.innerHTML = `
                <div id="pz-surplus-container">
                    <h4>Freies Ausgebildetes Personal</h4>
                    <ul>${surplusMessages.join('')}</ul>
                </div>`;
            log(`${surplusMessages.length} Meldungen zu Personal-Überschuss angezeigt.`);
        } else {
            targetContainer.innerHTML = `
                <div id="pz-surplus-container">
                    <h4>Freies Spezialpersonal</h4>
                    <p>Kein überschüssiges Personal mit Spezialausbildung gefunden.</p>
                </div>`;
            log("Kein überschüssiges Spezialpersonal gefunden.");
        }
    }
    // =================================================================================
    // ### main() Funktion - Der Startpunkt des Skripts ###
    // =================================================================================
    async function main() {
        await initVehiclesConfiguration();
        addBaseStyles();
        addCustomLoopStyles();
        addModernUIStyles();

        const isVehicleAssignmentPage = window.location.pathname.includes("/vehicles/") && window.location.pathname.includes("/zuweisung");
        const isTablePage = document.getElementById('vehicle_table') || document.getElementById('vehicle_table_wrapper') || window.location.pathname.includes('/dispatchcenters/');

        if (isVehicleAssignmentPage) {
            log("✅ Fahrzeug-Zuweisungs-Seite erkannt.");
            addVehicleAssignmentPageButtons();
        } else if (isBuildingOverviewPage || isBuildingExpansionPage || isTablePage) {
            log("🔎 Wachen- oder Leitstellen-Seite erkannt.");

            if (isBuildingOverviewPage || isBuildingExpansionPage) {
                await handleSequenceController();
                const superLoopState = getState(superLoopStateKey);
                if (superLoopState?.active && !getState(sequenceStateKey)) {
                    log("🔁 Super-Loop: Starte kombinierte Sequenz für neue Wache.");
                    setTimeout(() => startCombinedSequence(true), 500);
                }
            }

            // KORREKTUR: Robuste, getrennte Observer nach dem Vorbild von v4.3.1
            // Dieser Observer fügt die Haupt-UI hinzu und beendet sich dann.
            const mainUiObserver = new MutationObserver((_, obs) => {
                const vehicleTable = document.getElementById('vehicle_table');
                if (vehicleTable) {
                    log("👀 Haupt-UI Observer: Fahrzeugtabelle gefunden, starte UI-Initialisierung.");
                    addBuildingPageUI();
                    analyzeAndDisplaySurplusPersonnel();
                    obs.disconnect(); // Wichtig: Beenden, um Endlosschleifen zu vermeiden.
                    log("✅ Haupt-UI Observer beendet.");
                }
            });

            // Dieser Observer kümmert sich NUR um die Wachenbauplan-Buttons und läuft weiter.
            const fleetButtonObserver = new MutationObserver(() => {
                const fleetButtons = document.querySelector("a.btn[vehicle-fleet-configuration-id]");
                if(fleetButtons){
                    // log("👀 Wachenbauplan Observer: Buttons gefunden, erweitere sie.");
                    enhanceFleetConfigurationButtons();
                }
            });

            log("🚀 Starte UI-Beobachter...");
            mainUiObserver.observe(document.body, { childList: true, subtree: true });
            fleetButtonObserver.observe(document.body, { childList: true, subtree: true });
        }
    }
    main();
})();
