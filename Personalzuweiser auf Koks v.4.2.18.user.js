// ==UserScript==
// @name          Personalzuweiser auto-mod v4.3 (FMS-Status-Logik)
// @namespace     personalzuweiser.leitstellenspiel.de
// @version       4.3.18-Single-FMS-Fix
// @license       BSD-3-Clause
// @author        BOS-Ernie, Masklin, BAHendrik (modifiziert und fusioniert durch KI)
// @description   V4.3.18: Fügt die fehlende Logik zum Setzen des FMS-Status bei der Einzel-Fahrzeug-Zuweisung hinzu.
// @match         https://*.leitstellenspiel.de/buildings/*
// @match         https://*.leitstellenspiel.de/dispatchcenters/*
// @match         https://*.leitstellenspiel.de/vehicles/*/zuweisung
// @run-at        document-idle
// @grant         none

// ==/UserScript==

/* global $, I18n */

(async function () {
    'use strict';

    // ### GRUNDEINSTELLUNGEN ###
    const forceStatus2OnFull = true;
    const assignMostSeniorFirst = false;
    const skippableCaptionPrefixes = ["anh ", "mzb ", "boot "];
    const maxWorkers = 10;

    // ### INTERNE KONFIGURATION ###
    const localStoragePrefix = "personalzuweiser_v4.";
    const vehiclesConfigKey = localStoragePrefix + "vehicle-type-configurations";
    const storageTtl = 24 * 60 * 60 * 1000;

    let csrfToken = document.querySelector("meta[name=csrf-token]")?.content;
    let vehiclesConfiguration = [];
    let isProcessRunning = false;
    const currentVehicleId = window.location.pathname.includes("/vehicles/") ? window.location.pathname.split("/")[2] : null;

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
        { id: 172, caption: "MTW TeSi", maxStaff: 6, training: [{ key: "disaster_response_technology", number: 6 }] },
        { id: 126, caption: "MTF Drohne", maxStaff: 5, training: [{ key: "fire_drone", number: 5 }] },
        { id: 74, caption: "NAW", maxStaff: 3, training: [{ key: "notarzt", number: 3 }] },
        { id: 51, caption: "FüKW (Polizei)", maxStaff: 2, training: [{ key: "police_fukw", number: 2 }] },
        { id: 57, caption: "GW-San", maxStaff: 6, training: [{ key: "betreuung", number: 4 }] }
    ];

    function log(message) { console.log(`[PZ-Mod] ${message}`); }

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
            const targetElement = document.querySelector("#building_vehicles .panel-heading") || document.querySelector(".tab-content #tabs-vehicle") || document.querySelector(".tab-content");
            if (targetElement) targetElement.prepend(container);
        }
    }

    function setCardStatus(vehicleId, status) {
        const card = document.getElementById(`pz-card-${vehicleId}`);
        if (card) {
            card.className = 'pz-grid-card';
            card.classList.add(`pz-status-${status}`);
        }
    }

    async function initVehiclesConfiguration() {
        const cached = localStorage.getItem(vehiclesConfigKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.lastUpdate > Date.now() - storageTtl) {
                vehiclesConfiguration = parsed.data;
                return;
            }
        }
        try {
            const response = await fetch("https://api.lss-manager.de/de_DE/vehicles");
            if (!response.ok) throw new Error("API Fehler");
            const data = await response.json();
            const transformedData = transformVehiclesData(data);
            vehiclesConfiguration = applyVehicleConfigurationOverride(transformedData);
            localStorage.setItem(vehiclesConfigKey, JSON.stringify({
                lastUpdate: Date.now(), data: vehiclesConfiguration,
            }));
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

    async function fetchHtml(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP-Fehler ${response.status} für URL: ${url}`);
        return await response.text();
    }

    async function fetchPersonnelAndAssignments(vehicleId) {
        const html = await fetchHtml(`/vehicles/${vehicleId}/zuweisung`);
        const dom = new DOMParser().parseFromString(html, "text/html");
        return {
            availablePersonnel: Array.from(dom.querySelectorAll("tr[data-filterable-by]")).map(row => {
                const assignButton = row.querySelector("a.btn-success");
                if (!assignButton || row.children[2].innerText.startsWith("Im Unterricht")) return null;
                return {
                    id: assignButton.getAttribute("personal_id"),
                    qualifications: JSON.parse(row.getAttribute("data-filterable-by").replace(/'/g, '"')).filter(Boolean),
                };
            }).filter(Boolean)
        };
    }

    async function runControlCenterAssignment(vehicleIds, unassignMode = false) { /* ... unverändert ... */ }
    async function runAssignmentProcess(vehicleIds, unassignMode = false, isSubProcess = false, uiContainer = null, skipGridCreation = false) { /* ... unverändert ... */ }
    async function resetVehicle() { /* ... unverändert ... */ }

    // MODIFIZIERT: Logik zum Setzen des FMS-Status am Ende hinzugefügt
    async function assignSingleVehicleLogic() {
        log("⚙️ Starte Einzelzuweisung...");
        const vehicleData = await (await fetch(`/api/v2/vehicles/${currentVehicleId}`)).json();
        const config = vehiclesConfiguration.find(v => v.id === vehicleData.result.vehicle_type);
        if (!config || config.maxStaff === 0) {
            log("ℹ️ Kein Personal benötigt.");
            return;
        }
        await resetVehicle();
        await new Promise(r => setTimeout(r, 500));
        for (const req of config.training) {
            const personnel = Array.from(document.querySelectorAll(`a.btn-success[personal_id]`)).filter(btn => JSON.parse(btn.closest('tr').getAttribute("data-filterable-by").replace(/'/g, '"')).includes(req.key));
            for (let i = 0; i < req.number && i < personnel.length; i++) {
                personnel[i].click();
                await new Promise(r => setTimeout(r, 250));
            }
        }
        const assignedCount = document.querySelectorAll(".btn-assigned").length;
        const remaining = config.maxStaff - assignedCount;
        if (remaining > 0) {
            const personnel = Array.from(document.querySelectorAll(`a.btn-success[personal_id]`)).filter(btn => JSON.parse(btn.closest('tr').getAttribute("data-filterable-by").replace(/'/g, '"')).filter(q => q).length === 0);
            for (let i = 0; i < remaining && i < personnel.length; i++) {
                personnel[i].click();
                await new Promise(r => setTimeout(r, 250));
            }
        }

        // NEU: Warte kurz und setze dann den FMS-Status basierend auf dem Ergebnis
        await new Promise(r => setTimeout(r, 300));
        const finalAssignedCount = document.querySelectorAll(".btn-assigned").length;
        log(`Zuweisung beendet. ${finalAssignedCount} von ${config.maxStaff} Personen zugewiesen.`);

        if (finalAssignedCount < config.maxStaff) {
            log(`Fahrzeug nicht voll besetzt. Setze FMS-Status auf 6.`);
            await fetch(`/vehicles/${currentVehicleId}/set_fms/6`);
        } else if (forceStatus2OnFull) {
            log(`Fahrzeug voll besetzt. Setze FMS-Status auf 2.`);
            await fetch(`/vehicles/${currentVehicleId}/set_fms/2`);
        }

        log("✅ Zuweisung abgeschlossen.");
    }

    function addVehicleAssignmentPageButtons() { /* ... unverändert ... */ }
    function getVisibleVehicleIds() { /* ... unverändert ... */ }
    function getAllVehicleIds() { /* ... unverändert ... */ }
    function setButtonsDisabled(disabled) { /* ... unverändert ... */ }
    function addOverviewPageButtons(isControlCenterPage) { /* ... unverändert ... */ }
    function addCustomStyles() { /* ... unverändert ... */ }
    function initializeLogicForTablePages() { /* ... unverändert ... */ }
    async function main() { /* ... unverändert ... */ }

    // Unveränderte Funktionen hier einkopiert, um das Skript vollständig zu halten
    async function runControlCenterAssignment(vehicleIds, unassignMode = false) {
        if (isProcessRunning) return;
        isProcessRunning = true;
        setButtonsDisabled(true);
        const modeText = unassignMode ? "Entzuweisung" : "Zuweisung";
        log(`🚀 Starte ${modeText} für die Leitstelle...`);
        const mainUiContainer = document.createElement('div');
        const targetElement = document.querySelector("#vehicle_table_wrapper .panel-heading") || document.querySelector("#vehicle_table");
        if (targetElement) targetElement.before(mainUiContainer);
        const statusDiv = document.createElement('div');
        statusDiv.id = 'pz-status-text';
        statusDiv.style.cssText = "margin-bottom: 5px; font-weight: bold; font-size: 1.2em; padding: 5px; background-color: #2d3748; border-radius: 5px; color: white;";
        mainUiContainer.appendChild(statusDiv);
        statusDiv.textContent = `Sammle Details für ${vehicleIds.length} Fahrzeuge...`;
        const allVehicleDetails = (await Promise.all(
            vehicleIds.map(id => fetch(`/api/v2/vehicles/${id}`).then(res => res.json()).then(data => data.result).catch(() => null))
        )).filter(Boolean);
        createVehicleGrid(allVehicleDetails, mainUiContainer);
        const buildings = new Map();
        document.querySelectorAll('#vehicle_table tbody tr').forEach(row => {
            const vehicleLink = row.querySelector('a[href*="/vehicles/"]');
            const vehicleId = vehicleLink?.href.match(/\/vehicles\/(\d+)/)?.[1];
            if (!vehicleId || !vehicleIds.includes(vehicleId)) return;
            const buildingLink = row.querySelector('td:nth-of-type(4) a[href*="/buildings/"]');
            const buildingId = buildingLink?.href.match(/\/buildings\/(\d+)/)?.[1];
            const buildingName = buildingLink?.textContent.trim() || 'Unbekannte Wache';
            if (buildingId) {
                if (!buildings.has(buildingId)) buildings.set(buildingId, { name: buildingName, vehicleIds: [] });
                buildings.get(buildingId).vehicleIds.push(vehicleId);
            }
        });
        if (buildings.size === 0) {
            log("⚠️ Keine Wachen oder Fahrzeuge zur Bearbeitung gefunden.");
            isProcessRunning = false; setButtonsDisabled(false); return;
        }
        log(`✅ ${buildings.size} Wachen identifiziert. Starte sequenzielle Abarbeitung.`);
        try {
            let buildingCount = 0;
            for (const [buildingId, data] of buildings.entries()) {
                buildingCount++;
                statusDiv.textContent = `[${buildingCount}/${buildings.size}] Bearbeite Wache: ${data.name}`;
                await runAssignmentProcess(data.vehicleIds, unassignMode, true, null, true);
            }
            log("🏁 Leitstellen-Prozess abgeschlossen! Seite wird in 5 Sekunden neu geladen.");
            statusDiv.textContent = "Prozess abgeschlossen! Seite wird neu geladen...";
            setTimeout(() => window.location.reload(), 5000);
        } catch (error) {
            log(`❌ Ein schwerwiegender Fehler im Leitstellen-Prozess ist aufgetreten: ${error.message}`);
            statusDiv.textContent = `Ein Fehler ist aufgetreten: ${error.message}`;
        } finally {
            isProcessRunning = false;
            setButtonsDisabled(false);
        }
    }
    async function runAssignmentProcess(vehicleIds, unassignMode = false, isSubProcess = false, uiContainer = null, skipGridCreation = false) {
        if (!isSubProcess) { if (isProcessRunning) return; isProcessRunning = true; setButtonsDisabled(true); }
        const modeText = unassignMode ? "Entzuweisung" : "Zuweisung";
        log(`🚀 Starte ${modeText} für ${vehicleIds.length} Fahrzeuge...`);
        let incompleteVehicles = new Set(vehicleIds);
        try {
            const taskManager = (tasks) => new Promise((resolve) => {
                const taskQueue = [...tasks]; let running = 0;
                const runNext = () => {
                    if (taskQueue.length === 0 && running === 0) return resolve();
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
            if (vehicleIds.length === 0) { if (!isSubProcess) { isProcessRunning = false; setButtonsDisabled(false); } return; }
            const vehicleDetails = (await Promise.all(vehicleIds.map(id => fetch(`/api/v2/vehicles/${id}`).then(res => res.json()).then(data => data.result).catch(() => null)))).filter(Boolean);
            if (vehicleDetails.length === 0) { log(`[WARN] Konnten für keine der IDs Fahrzeugdetails abrufen.`); }
            if (!skipGridCreation && vehicleDetails.length > 0) { createVehicleGrid(vehicleDetails, uiContainer); }
            log("🧹 Phase 1: Entferne alte Zuweisungen...");
            const allHtmls = await Promise.all(vehicleDetails.map(vehicle => fetchHtml(`/vehicles/${vehicle.id}/zuweisung`).catch(() => "")));
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
            if (unassignMode) { incompleteVehicles.clear(); }
            else if (vehicleDetails.length > 0) {
                log("🧠 Phase 2: Plane neue Zuweisungen...");
                let availablePersonnel = [];
                const sourceVehicleForPersonnel = vehicleDetails.find(vehicle => {
                    const config = vehiclesConfiguration.find(v => v.id === vehicle.vehicle_type);
                    return config && config.maxStaff > 0;
                });
                if (sourceVehicleForPersonnel) {
                    log(`[INFO] Nutze '${sourceVehicleForPersonnel.caption}' (ID: ${sourceVehicleForPersonnel.id}) als Quelle für die Personalliste.`);
                    try {
                        const personnelData = await fetchPersonnelAndAssignments(sourceVehicleForPersonnel.id);
                        availablePersonnel = personnelData.availablePersonnel;
                    } catch (e) {
                        log(`🚨 KRITISCHER FEHLER: Personalliste konnte selbst von einem gültigen Fahrzeug (ID: ${sourceVehicleForPersonnel.id}) nicht geladen werden: ${e.message}`);
                    }
                } else {
                    log(`[INFO] Konnte kein Fahrzeug in diesem Batch finden, das Personal aufnehmen kann. Überspringe Zuweisung.`);
                    incompleteVehicles.clear();
                }
                if (availablePersonnel.length > 0) {
                    let personnelPool = [...availablePersonnel];
                    if (assignMostSeniorFirst) personnelPool.reverse();
                    const assignTasks = [];
                    incompleteVehicles.clear();
                    for (const vehicle of vehicleDetails) {
                        const config = vehiclesConfiguration.find(v => v.id === vehicle.vehicle_type);
                        if (!config || config.maxStaff === 0 || skippableCaptionPrefixes.some(p => vehicle.caption.toLowerCase().startsWith(p))) { continue; }
                        let assignedCount = 0;
                        for (const req of (config.training || [])) {
                            for (let i = 0; i < req.number && assignedCount < config.maxStaff; i++) {
                                const personIndex = personnelPool.findIndex(p => p.qualifications.includes(req.key));
                                if (personIndex > -1) {
                                    assignTasks.push({ url: `/vehicles/${vehicle.id}/zuweisungDo/${personnelPool[personIndex].id}`, vehicleId: vehicle.id });
                                    personnelPool.splice(personIndex, 1);
                                    assignedCount++;
                                }
                            }
                        }
                        for (let i = assignedCount; i < config.maxStaff; i++) {
                            const personIndex = personnelPool.findIndex(p => p.qualifications.length === 0);
                            if (personIndex > -1) {
                                assignTasks.push({ url: `/vehicles/${vehicle.id}/zuweisungDo/${personnelPool[personIndex].id}`, vehicleId: vehicle.id });
                                personnelPool.splice(personIndex, 1);
                                assignedCount++;
                            }
                        }
                        if (assignedCount < config.maxStaff) { incompleteVehicles.add(vehicle.id); }
                    }
                    if (assignTasks.length > 0) {
                        await taskManager(assignTasks); log("✅ Zuweisungen gesendet.");
                    }
                }
            }
            log("📊 Phase 4: Setze FMS-Status...");
            const fmsTasks = [];
            const allProcessedIds = new Set(vehicleIds.map(id => String(id)));
            allProcessedIds.forEach(vehicleId => {
                if (incompleteVehicles.has(Number(vehicleId))) {
                    fmsTasks.push({ method: 'GET', url: `/vehicles/${vehicleId}/set_fms/6`, vehicleId, postTask: () => setCardStatus(vehicleId, 'error') });
                } else {
                    if (unassignMode) return;
                    if (forceStatus2OnFull) fmsTasks.push({ method: 'GET', url: `/vehicles/${vehicleId}/set_fms/2`, vehicleId, postTask: () => setCardStatus(vehicleId, 'success') });
                }
            });
            if (fmsTasks.length > 0) await taskManager(fmsTasks);
            log("✅ FMS-Status aktualisiert.");
            if (!isSubProcess) { log("🏁 Prozess abgeschlossen! Seite wird in 5 Sekunden neu geladen."); setTimeout(() => window.location.reload(), 5000); }
            else { log("✅ Wachen-Abarbeitung abgeschlossen."); }
        } catch (error) {
            log(`❌ Ein schwerwiegender Fehler im Zuweisungsprozess ist aufgetreten: ${error.message}`);
            console.error("Full error details:", error);
        } finally {
            if (!isSubProcess) { isProcessRunning = false; setButtonsDisabled(false); }
        }
    }
    async function resetVehicle() { log("🧹 Personal wird entfernt..."); const buttons = document.querySelectorAll(".btn-assigned.btn.btn-default"); for (let i = buttons.length - 1; i >= 0; i--) { buttons[i].click(); await new Promise(r => setTimeout(r, 250)); } log("✅ Fahrzeug geleert."); }
    function addVehicleAssignmentPageButtons() { const assignHotkey="s",resetHotkey="x",nextVehicleHotkey="d",previousVehicleHotkey="a"; const container = document.querySelector(".vehicles-education-filter-box"); if (!container) return; const group = document.createElement("div"); group.className = "btn-group", group.style.marginLeft = "10px"; const assignBtn = document.createElement("button"); assignBtn.className = "btn btn-success", assignBtn.innerHTML = '<span class="glyphicon glyphicon-ok"></span> Zuweisen', assignBtn.title = `Optimal zuweisen (${assignHotkey.toUpperCase()})`, assignBtn.addEventListener("click", assignSingleVehicleLogic); const resetBtn = document.createElement("button"); resetBtn.className = "btn btn-danger", resetBtn.innerHTML = '<span class="glyphicon glyphicon-trash"></span> Leeren', resetBtn.title = `Personal entfernen (${resetHotkey.toUpperCase()})`, resetBtn.addEventListener("click", resetVehicle); group.append(assignBtn, resetBtn), container.appendChild(group); document.addEventListener("keydown", async e => { if (document.activeElement?.tagName.match(/INPUT|TEXTAREA/)) return; const key = e.key.toLowerCase(); if (key === assignHotkey) e.preventDefault(), assignSingleVehicleLogic(); else if (key === resetHotkey) e.preventDefault(), resetVehicle(); else if (key === nextVehicleHotkey) e.preventDefault(), document.querySelectorAll(".btn-group.pull-right a")[1]?.click(); else if (key === previousVehicleHotkey) e.preventDefault(), document.querySelectorAll(".btn-group.pull-right a")[0]?.click(); }); }
    function getVisibleVehicleIds() { return Array.from(document.querySelectorAll('#vehicle_table tbody tr')).filter(row => row.style.display !== 'none' && !row.classList.contains('tablesorter-filtered')).map(row => row.querySelector('a[href*="/vehicles/"]')?.href.match(/\/vehicles\/(\d+)/)?.[1]).filter(Boolean); }
    function getAllVehicleIds() { return Array.from(document.querySelectorAll("#building_vehicles a[href*='/vehicles/'], #vehicle_table a[href*='/vehicles/']")).map(a => a.href.match(/\/vehicles\/(\d+)/)?.[1]).filter((v, i, s) => s.indexOf(v) === i); }
    function setButtonsDisabled(disabled) { document.querySelectorAll('#pz-button-group button').forEach(btn => btn.disabled = disabled); }
    function addOverviewPageButtons(isControlCenterPage) { const buildingStartAutoHotkey="s",buildingStartVisibleAutoHotkey="c",buildingStartUnassignVisibleHotkey="v"; let targetElement = document.querySelector("#building_vehicles .panel-heading") || document.querySelector("#vehicle_table_wrapper .panel-heading") || document.querySelector(".tab-content #tabs-vehicle") || document.querySelector(".tab-content"); if (!targetElement) return; const btnGroup = document.createElement("div"); btnGroup.id = "pz-button-group", btnGroup.className = "btn-group", btnGroup.style.cssText = "margin-bottom: 10px; margin-right: 5px;"; const startAllBtn = document.createElement("button"); startAllBtn.className = "btn btn-success", startAllBtn.innerHTML = `Zuweisen (alle) (${buildingStartAutoHotkey.toUpperCase()})`; const startVisibleBtn = document.createElement("button"); startVisibleBtn.className = "btn btn-info", startVisibleBtn.innerHTML = `Zuweisen (sichtb.) (${buildingStartVisibleAutoHotkey.toUpperCase()})`, startVisibleBtn.style.marginLeft = "5px"; const unassignVisibleBtn = document.createElement("button"); unassignVisibleBtn.className = "btn btn-danger", unassignVisibleBtn.innerHTML = `Aufheben (sichtb.) (${buildingStartUnassignVisibleHotkey.toUpperCase()})`, unassignVisibleBtn.style.marginLeft = "5px"; if (isControlCenterPage) { startAllBtn.addEventListener("click", () => runControlCenterAssignment(getAllVehicleIds(), false)); startVisibleBtn.addEventListener("click", () => runControlCenterAssignment(getVisibleVehicleIds(), false)); unassignVisibleBtn.addEventListener("click", () => runControlCenterAssignment(getVisibleVehicleIds(), true)); } else { startAllBtn.addEventListener("click", () => runAssignmentProcess(getAllVehicleIds(), false)); startVisibleBtn.addEventListener("click", () => runAssignmentProcess(getVisibleVehicleIds(), false)); unassignVisibleBtn.addEventListener("click", () => runAssignmentProcess(getVisibleVehicleIds(), true)); } btnGroup.append(startAllBtn, startVisibleBtn, unassignVisibleBtn); targetElement.prepend(btnGroup); document.addEventListener("keydown", e => { if (document.activeElement?.tagName.match(/INPUT|TEXTAREA/)) return; const key = e.key.toLowerCase(); if (key === buildingStartAutoHotkey) e.preventDefault(), startAllBtn.click(); else if (key === buildingStartVisibleAutoHotkey) e.preventDefault(), startVisibleBtn.click(); else if (key === buildingStartUnassignVisibleHotkey) e.preventDefault(), unassignVisibleBtn.click(); }); }
    function addCustomStyles() { const style = document.createElement('style'); style.textContent = ` .pz-grid-card { width: 120px; min-height: 40px; border-radius: 4px; color: white; font-size: 11px; padding: 4px; text-align: center; transition: background-color 0.3s ease; display: flex; align-items: center; justify-content: center; white-space: normal; word-break: break-word; } .pz-status-pending { background-color: #4a5568; } .pz-status-working { background-color: #d69e2e; animation: pz-pulse 1.5s infinite; } .pz-status-success { background-color: #38a169; } .pz-status-error { background-color: #c53030; } @keyframes pz-pulse { 0% { opacity: 1; } 50% { opacity: 0.6; } 100% { opacity: 1; } } `; document.head.appendChild(style); }
    function initializeLogicForTablePages() { log("➡️ Fahrzeugtabelle gefunden, starte Logik..."); const isControlCenterPage = Array.from(document.querySelectorAll('#vehicle_table th')).some(th => th.textContent.trim() === 'Gebäude'); if (isControlCenterPage) log("✅ Leitstelle erkannt (Spalte 'Gebäude' gefunden)."); else log("✅ Einzelwache erkannt (keine Spalte 'Gebäude' gefunden)."); addOverviewPageButtons(isControlCenterPage); }
    async function main() { await initVehiclesConfiguration(); addCustomStyles(); const isVehicleAssignmentPage = window.location.pathname.includes("/vehicles/") && window.location.pathname.includes("/zuweisung"); const isPotentiallyTablePage = !isVehicleAssignmentPage; if (isVehicleAssignmentPage) { log("✅ Fahrzeug-Zuweisungs-Seite erkannt, starte sofort."); addVehicleAssignmentPageButtons(); } else if (isPotentiallyTablePage) { log("🔎 Wachen- oder Leitstellen-Seite erkannt. Warte auf Fahrzeugtabelle..."); if (document.getElementById('vehicle_table')) { initializeLogicForTablePages(); } else { const observer = new MutationObserver((mutations, obs) => { if (document.getElementById('vehicle_table')) { obs.disconnect(); initializeLogicForTablePages(); } }); observer.observe(document.body, { childList: true, subtree: true }); } } }

    main();
})();
